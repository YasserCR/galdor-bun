/**
 * core/provider/strip-thinking — remove inline reasoning blocks from text.
 *
 * Some chat models emit chain-of-thought inline in the text body as
 * `<think>...</think>` or `<thinking>...</thinking>` markers.
 * {@link stripThinkingBlocks} wraps a {@link Provider} so those blocks are
 * removed from text content on both {@link Provider.generate} and
 * {@link Provider.stream}; {@link extractThinkingBlocks} instead moves the
 * reasoning into a separate thinking part for observability. Both are opt-in:
 * adapters do not install them automatically.
 *
 * Only inline `<think>` text markers are handled. Structured reasoning parts
 * (thinking content emitted natively by a provider) are left untouched.
 */

import { ContentType, type Message, thinkingPart } from "../schema/index.ts";
import {
  type Event,
  EventType,
  type Provider,
  type Request,
  type Response,
  type RunContext,
} from "./index.ts";

/**
 * Matches a complete inline thinking block. Non-greedy so multiple blocks in
 * one string strip independently; case-insensitive and dot-matches-newline
 * because reasoning spans multiple lines. Group 1 captures the inner text for
 * {@link extractThinkingBlocks}.
 */
const thinkBlockRe = /<(?:think|thinking)\b[^>]*>([\s\S]*?)<\/(?:think|thinking)>/gi;

/** Matches the start of a thinking block; used to detect when to begin buffering a stream. */
const openThinkRe = /<(?:think|thinking)\b[^>]*>/i;

/**
 * Longest prefix of an open thinking tag the lookahead buffer may need to
 * hold: `<thinking ` plus a few attribute bytes. Capped at a small constant so
 * adversarial input that keeps almost-opening a tag can't grow it unboundedly.
 */
const maxOpenTagLen = 16;

/**
 * Wrap `inner` so inline `<think>`/`<thinking>` blocks are removed from text
 * content. Matching is case-insensitive and non-greedy; whitespace right after
 * a removed block is trimmed only when a strip actually changed the text, so
 * passthrough text keeps its exact shape.
 *
 * On streaming, an open `<think>` tag suppresses everything until its matching
 * close (which may straddle deltas); a small lookahead buffer catches a close
 * tag split across frames. If the stream ends with a `<think>` still open, the
 * buffered reasoning is dropped.
 *
 * @param inner - The provider to wrap.
 * @returns A provider whose text content has inline reasoning blocks removed.
 */
export function stripThinkingBlocks(inner: Provider): Provider {
  return new StripThinkingProvider(inner, false);
}

/**
 * Like {@link stripThinkingBlocks}, but the removed reasoning is moved into a
 * separate thinking content part instead of being discarded. The text parts
 * end up identical to the stripped form, so text readers are unaffected; the
 * reasoning is preserved as an extra, non-text part.
 *
 * @param inner - The provider to wrap.
 * @returns A provider that moves inline reasoning into thinking parts.
 */
export function extractThinkingBlocks(inner: Provider): Provider {
  return new StripThinkingProvider(inner, true);
}

/** Provider decorator implementing both strip and extract behaviors. */
class StripThinkingProvider implements Provider {
  #inner: Provider;
  // When true, reasoning is moved into a thinking part rather than discarded.
  #collect: boolean;

  constructor(inner: Provider, collect: boolean) {
    this.#inner = inner;
    this.#collect = collect;
  }

  name(): string {
    return this.#inner.name();
  }

  capabilities() {
    return this.#inner.capabilities();
  }

  async generate(req: Request, ctx?: RunContext): Promise<Response> {
    const resp = await this.#inner.generate(req, ctx);
    if (this.#collect) {
      extractMessage(resp.message);
    } else {
      stripMessage(resp.message);
    }
    return resp;
  }

  stream(req: Request, ctx?: RunContext): AsyncIterable<Event> {
    return stripStream(this.#inner.stream(req, ctx), this.#collect);
  }
}

/** Rewrite every text part of `m`, dropping inline thinking blocks. */
function stripMessage(m: Message): void {
  for (let i = 0; i < m.content.length; i++) {
    const p = m.content[i]!;
    if (p.type !== ContentType.Text) continue;
    const [cleaned, changed] = stripText(p.text ?? "");
    if (changed) p.text = cleaned;
  }
}

/**
 * Return `input` with all complete think blocks removed and whether it was
 * modified. When changed, the result is trimmed at the edges.
 */
function stripText(input: string): [string, boolean] {
  if (!input.includes("<")) return [input, false];
  const out = input.replace(thinkBlockRe, "");
  if (out === input) return [input, false];
  return [out.trim(), true];
}

/**
 * Rewrite every text part of `m`, moving inline reasoning out of the text and
 * appending it as separate thinking parts. The text parts are left exactly as
 * {@link stripMessage} would leave them.
 */
function extractMessage(m: Message): void {
  const thinks: string[] = [];
  for (let i = 0; i < m.content.length; i++) {
    const p = m.content[i]!;
    if (p.type !== ContentType.Text) continue;
    const [cleaned, th, changed] = extractText(p.text ?? "");
    if (changed) {
      p.text = cleaned;
      thinks.push(...th);
    }
  }
  for (const t of thinks) {
    const trimmed = t.trim();
    if (trimmed !== "") m.content.push(thinkingPart(trimmed));
  }
}

/**
 * Return `input` with all complete think blocks removed, the reasoning text
 * captured from each block, and whether the input was modified.
 */
function extractText(input: string): [string, string[], boolean] {
  if (!input.includes("<")) return [input, [], false];
  const matches = [...input.matchAll(thinkBlockRe)];
  if (matches.length === 0) return [input, [], false];
  const thinks = matches.map((m) => m[1] ?? "");
  const out = input.replace(thinkBlockRe, "");
  return [out.trim(), thinks, true];
}

/**
 * Transform an event stream, rewriting content deltas on the fly and the
 * terminal message in the same way the non-streaming path rewrites a response.
 */
async function* stripStream(
  inner: AsyncIterable<Event>,
  collect: boolean,
): AsyncIterable<Event> {
  // buf holds either the tail of forwarded text that might begin an open tag,
  // or — while inside a block — the recent text scanned for the close tag.
  let buf = "";
  // inThink is true while inside a <think>...</think> region.
  let inThink = false;

  /** Process a chunk and return the bytes to emit (possibly empty). */
  const feed = (chunk: string): string => {
    let work = buf + chunk;
    buf = "";
    let out = "";
    for (;;) {
      if (inThink) {
        const [idx, end] = findClose(work);
        if (idx < 0) {
          // No close yet; keep only a small tail in case the close tag is
          // split across this delta and the next.
          const n = work.length;
          if (n > 0) {
            buf = n > maxOpenTagLen ? work.slice(n - maxOpenTagLen) : work;
          }
          return out;
        }
        // Close found; resume scanning after it, trimming a single run of
        // whitespace at the seam to match the non-streaming strip.
        work = work.slice(end);
        inThink = false;
        work = trimLeftWhitespace(work);
      }
      const loc = findOpen(work);
      if (loc === null) {
        // No open tag; forward all but a trailing slice that could begin one.
        const [safe, tail] = splitSafePrefix(work);
        out += safe;
        buf = tail;
        return out;
      }
      // Emit text before the open tag, then enter think mode and loop.
      out += work.slice(0, loc[0]);
      work = work.slice(loc[1]);
      inThink = true;
    }
  };

  for await (const ev of inner) {
    switch (ev.type) {
      case EventType.ContentDelta: {
        const out = feed(ev.contentDelta ?? "");
        if (out === "") continue; // fully buffered or fully suppressed
        yield { ...ev, contentDelta: out };
        break;
      }
      case EventType.MessageStop: {
        // Rewrite the terminal message the same way as the delta stream, on a
        // copy so the provider's data is never mutated.
        let outEv = ev;
        if (ev.message !== undefined) {
          const cp: Message = {
            ...ev.message,
            content: ev.message.content.map((p) => ({ ...p })),
          };
          if (collect) {
            extractMessage(cp);
          } else {
            stripMessage(cp);
          }
          outEv = { ...ev, message: cp };
        }
        // Flush whatever the buffer still holds. Outside a block the bytes were
        // a non-tag lookahead and must be emitted; inside, the model never
        // closed the tag, so the buffer is dropped.
        if (!inThink && buf !== "") {
          const flush = buf;
          buf = "";
          yield { type: EventType.ContentDelta, contentDelta: flush };
          yield outEv;
        } else {
          buf = "";
          inThink = false;
          yield outEv;
        }
        break;
      }
      default:
        yield ev;
    }
  }
}

/** Locate the first closing think tag in `s`, returning [start, end] or [-1, -1]. */
function findClose(s: string): [number, number] {
  const lower = s.toLowerCase();
  const candidates = ["</think>", "</thinking>"];
  let bestStart = -1;
  let bestEnd = -1;
  for (const c of candidates) {
    const i = lower.indexOf(c);
    if (i >= 0 && (bestStart < 0 || i < bestStart)) {
      bestStart = i;
      bestEnd = i + c.length;
    }
  }
  return [bestStart, bestEnd];
}

/** Locate the first opening think tag in `s`, returning [start, end] or `null`. */
function findOpen(s: string): [number, number] | null {
  const m = openThinkRe.exec(s);
  if (m === null) return null;
  return [m.index, m.index + m[0].length];
}

/**
 * Split `input` into (safe, tail): `safe` is known not to begin an open think
 * tag and can be emitted now; `tail` is the trailing slice held back until more
 * bytes arrive.
 */
function splitSafePrefix(input: string): [string, string] {
  const idx = input.lastIndexOf("<");
  if (idx < 0) return [input, ""];
  const tail = input.slice(idx);
  const lt = tail.toLowerCase();
  const t1 = "<think";
  const t2 = "<thinking";
  // tail is a (shorter) prefix of an open tag, e.g. "<thi".
  const prefixOfTag = t1.startsWith(lt) || t2.startsWith(lt);
  // tail begins a real open tag, e.g. "<think" / "<thinking...".
  const startsTag = lt.startsWith(t1);
  if (!prefixOfTag && !startsTag) {
    return [input, ""];
  }
  // An open tag whose '>' hasn't arrived may carry an arbitrarily long
  // attribute list; hold the whole tail back until the tag closes.
  if (startsTag && !tail.includes(">")) {
    return [input.slice(0, idx), tail];
  }
  // Cap the held-back tail for the short ambiguous-prefix case.
  if (tail.length > maxOpenTagLen) {
    return [input, ""];
  }
  return [input.slice(0, idx), tail];
}

/** Trim a leading run of ASCII spaces, tabs, newlines, and carriage returns. */
function trimLeftWhitespace(s: string): string {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") break;
    i++;
  }
  return s.slice(i);
}
