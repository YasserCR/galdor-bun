/**
 * Gemini streaming over Server-Sent Events.
 *
 * Calls streamGenerateContent with {@code alt=sse}: each frame is a
 * {@link GenerateResponse}-shaped JSON object describing the latest candidate
 * delta plus, on the terminal frame, a finishReason and usageMetadata. The SSE
 * stream carries no {@code [DONE]} sentinel — the connection simply closes after
 * the final frame — so the closing MessageStop event is synthesized from the
 * accumulated stop reason, usage and reasoning. Consume with {@code for await},
 * or fold the events into a single Response via {@code collectStream}.
 */

import { APIError, type Event, EventType } from "@galdor/core/provider";
import { type Message, Role, type StopReason, thinkingPart, type Usage } from "@galdor/core/schema";
import { type GenerateResponse, normalizeFinishReason, synthToolID, usageFromWire } from "./convert.ts";
import { classifyStreamError, normalizeHTTPError } from "./errors.ts";
import type { GenerateRequest } from "./convert.ts";

/** A zeroed {@link Usage} record used as the running accumulator until the stream reports counts. */
function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

/** True when a usageMetadata block carries any non-zero token count worth adopting. */
function hasUsage(u: GenerateResponse["usageMetadata"]): boolean {
  if (!u) return false;
  return (
    (u.promptTokenCount ?? 0) > 0 ||
    (u.candidatesTokenCount ?? 0) > 0 ||
    (u.cachedContentTokenCount ?? 0) > 0 ||
    (u.thoughtsTokenCount ?? 0) > 0
  );
}

/**
 * POST a streamGenerateContent request and yield galdor provider {@link Event}s
 * as the SSE frames arrive.
 *
 * Emits one MessageStart, then ContentDelta and ToolCallDelta events for each
 * candidate part, and finally a synthesized MessageStop carrying the stop
 * reason, usage and any accumulated reasoning. Thought parts are accumulated and
 * attached to the closing message rather than streamed live.
 *
 * @param url - Fully-qualified streamGenerateContent endpoint, including {@code ?alt=sse}.
 * @param headers - Request headers (auth, content type); an SSE accept header is added.
 * @param body - The already-built Gemini request payload.
 * @param signal - Optional abort signal to cancel the in-flight request.
 * @returns An async generator of provider events.
 * @throws {APIError} On a non-2xx response, an in-stream error frame, or a prompt blocked by the safety filter.
 * @throws {Error} When the response has no readable body.
 * @example
 * for await (const ev of streamGenerateContent(url, headers, body, signal)) {
 *   if (ev.type === EventType.ContentDelta) process.stdout.write(ev.contentDelta);
 * }
 */
export async function* streamGenerateContent(
  url: string,
  headers: Record<string, string>,
  body: GenerateRequest,
  signal: AbortSignal | undefined,
): AsyncGenerator<Event> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, accept: "text/event-stream" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (Math.floor(res.status / 100) !== 2) throw await normalizeHTTPError(res);
  if (!res.body) throw new Error("google: streaming response had no body");

  // Function name -> running part index, for stable tool-call ID synthesis.
  const toolIdx = new Map<string, number>();
  let usage = emptyUsage();
  let model = "";
  let stopReason: StopReason = "" as StopReason;
  let started = false;
  let reasoning = "";

  // Process one SSE block: parse its data payload, surface error/blocked
  // frames, fold usage/model/stop state and yield the deltas it carries. Shared
  // by the streaming loop and the end-of-stream flush so a final frame without a
  // trailing blank line is handled identically.
  const handleFrame = function* (rawEvent: string): Generator<Event> {
    const frame = parseDataLine(rawEvent);
    if (frame === undefined) return;

    // Surface an in-stream error frame instead of synthesizing a clean stop.
    if (frame.error) throw classifyStreamError(frame.error);
    // A prompt blocked by Gemini's safety filter arrives as a frame with no
    // candidates and a blockReason; fail instead of silently terminating.
    if ((frame.candidates ?? []).length === 0 && frame.promptFeedback?.blockReason) {
      throw new APIError({
        kind: "invalid_request",
        provider: "google",
        statusCode: 0,
        message: `prompt blocked by safety filter: ${frame.promptFeedback.blockReason}`,
      });
    }

    if (frame.modelVersion) model = frame.modelVersion;
    if (hasUsage(frame.usageMetadata)) usage = usageFromWire(frame.usageMetadata);

    if (!started) {
      started = true;
      yield { type: EventType.MessageStart, model };
    }

    const c = (frame.candidates ?? [])[0];
    if (!c) return;
    for (const p of c.content?.parts ?? []) {
      if (p.functionCall) {
        const idx = toolIdx.get(p.functionCall.name) ?? 0;
        toolIdx.set(p.functionCall.name, idx + 1);
        const id = synthToolID(p.functionCall.name, idx);
        const argsDelta = p.functionCall.args === undefined ? "" : JSON.stringify(p.functionCall.args);
        yield {
          type: EventType.ToolCallDelta,
          toolCallDelta: { id, name: p.functionCall.name, argumentsDelta: argsDelta },
        };
      } else if (p.thought && p.text) {
        // Accumulate reasoning; do not forward it on the live stream.
        reasoning += p.text;
      } else if (p.text) {
        yield { type: EventType.ContentDelta, contentDelta: p.text };
      }
    }
    if (c.finishReason) stopReason = normalizeFinishReason(c.finishReason);
  };

  const decoder = new TextDecoder();
  let buffer = "";

  // SSE frames are separated by a blank line. Tolerate both LF ("\n\n") and
  // CRLF ("\r\n\r\n") framing so a CRLF-framed stream is not silently swallowed.
  const FRAME_SEP = /\r?\n\r?\n/;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let m: RegExpExecArray | null;
    while ((m = FRAME_SEP.exec(buffer)) !== null) {
      const rawEvent = buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
      yield* handleFrame(rawEvent);
    }
  }

  // Flush a trailing frame that arrived without a terminating blank line: the
  // upstream connection may close immediately after the final data line.
  if (buffer.trim() !== "") {
    yield* handleFrame(buffer);
  }

  // Synthesize the terminal MessageStop, carrying any accumulated reasoning.
  const stop: Event = { type: EventType.MessageStop, stopReason, usage, model };
  if (reasoning !== "") {
    const message: Message = { role: Role.Assistant, content: [thinkingPart(reasoning)] };
    stop.message = message;
  }
  yield stop;
}

/**
 * Extract and JSON-parse the {@code data:} payload from one SSE event block.
 * Comment and {@code event:} lines are ignored, multi-line data is rejoined, and
 * empty or {@code [DONE]} payloads (as well as malformed JSON) yield undefined so
 * the caller can skip them without aborting the stream.
 *
 * @param rawEvent - One SSE block, the text between two blank-line separators.
 * @returns The decoded frame, or undefined when there is nothing to process.
 */
function parseDataLine(rawEvent: string): GenerateResponse | undefined {
  const dataParts: string[] = [];
  // Split on CR?LF so trailing carriage returns from CRLF framing are stripped.
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // comment
    if (line.startsWith("event:")) continue;
    if (line.startsWith("data: ")) dataParts.push(line.slice(6));
    else if (line.startsWith("data:")) dataParts.push(line.slice(5));
  }
  if (dataParts.length === 0) return undefined;
  const payload = dataParts.join("\n");
  if (payload === "" || payload === "[DONE]") return undefined;
  try {
    return JSON.parse(payload) as GenerateResponse;
  } catch {
    // Skip malformed lines without surfacing transport hiccups.
    return undefined;
  }
}
