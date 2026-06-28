/**
 * Anthropic streaming over Server-Sent Events.
 *
 * Translates Anthropic's SSE event sequence (`message_start`, `content_block_*`,
 * `message_delta`, `message_stop`) into galdor's provider {@link Event} stream
 * ({@link EventType.MessageStart}, {@link EventType.ContentDelta},
 * {@link EventType.ToolCallDelta}, {@link EventType.MessageStop}). The bytes
 * arrive in arbitrary chunks, so the reader buffers and splits on the blank-line
 * delimiter that separates SSE messages. Consume the result with `for await`, or
 * fold it back into a single Response with `collectStream`.
 */

import { type Event, EventType } from "@galdor/core/provider";
import { ContentType, type Message, Role, type StopReason, type Usage } from "@galdor/core/schema";
import { classifyStreamError, normalizeHTTPError } from "./errors.ts";
import type { MessageRequest } from "./convert.ts";

/**
 * Token-count fields shared by the `message_start` and `message_delta` usage
 * objects. Cache counts are reported only when prompt caching is in play, so
 * every field is optional.
 */
interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Decoded payload of a single SSE `data:` line. Fields are populated selectively
 * depending on `type`; the inline comments note which event each group belongs to.
 */
interface SSEEvent {
  type: string;
  // message_start
  message?: { model?: string; usage?: WireUsage };
  // content_block_start
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  // content_block_delta
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string; thinking?: string; signature?: string };
  // message_delta
  usage?: WireUsage;
  // error
  error?: { type?: string; message?: string };
}

/** A zero-valued usage accumulator to fill in as the stream reports token counts. */
function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

/**
 * Fold any cache token counts from a wire usage object into the running usage,
 * so streamed usage matches the non-streaming path. Counts are reported only
 * when present, so each is applied only when non-zero.
 */
function foldCacheUsage(usage: Usage, wire: WireUsage | undefined): void {
  if (wire?.cache_creation_input_tokens) usage.cacheCreationTokens = wire.cache_creation_input_tokens;
  if (wire?.cache_read_input_tokens) usage.cacheReadTokens = wire.cache_read_input_tokens;
}

/**
 * Mutable accumulator for extended-thinking deltas. Thinking and signature
 * fragments are gathered here across the stream rather than forwarded as live
 * events, then attached to the terminal MessageStop as a single thinking part.
 */
interface Reasoning {
  thinking: string;
  signature: string;
}

/**
 * Build the terminal assistant {@link Message} carrying any accumulated
 * reasoning, or `undefined` when none was streamed. The assistant text rides the
 * content deltas, so this message holds only the thinking part; downstream
 * `collectStream` harvests the thinking block from here.
 */
function reasoningMessage(r: Reasoning): Message | undefined {
  if (r.thinking === "" && r.signature === "") return undefined;
  return {
    role: Role.Assistant,
    content: [{ type: ContentType.Thinking, text: r.thinking, signature: r.signature }],
  };
}

/** Coerce a raw Anthropic stop-reason string to a known {@link StopReason}, defaulting to `end_turn`. */
function normalizeStopReason(s: string | undefined): StopReason {
  switch (s) {
    case "end_turn":
    case "max_tokens":
    case "tool_use":
    case "stop_sequence":
    case "refusal":
      return s;
    default:
      return "end_turn";
  }
}

/**
 * POST a streaming `/v1/messages` request and yield galdor provider events.
 *
 * Sends the request with `stream: true` already set on `body`, then reads the
 * SSE response incrementally: each complete event block is parsed and converted
 * into zero or more {@link Event}s. Running token usage, the model name, and the
 * stop reason are accumulated across the stream and emitted as a final
 * {@link EventType.MessageStop} once the body is exhausted.
 *
 * @param url - Full messages endpoint to POST to.
 * @param headers - Request headers, including auth and content type.
 * @param body - The wire request; its `stream` flag should already be true.
 * @param signal - Optional abort signal to cancel the in-flight request.
 * @returns An async generator of provider events, ending with a MessageStop.
 * @throws {APIError} When the response status is not 2xx (see {@link normalizeHTTPError}).
 * @throws {Error} When a 2xx response unexpectedly carries no body.
 * @example
 * for await (const ev of streamMessages(url, headers, wire, signal)) {
 *   if (ev.type === EventType.ContentDelta) process.stdout.write(ev.contentDelta);
 * }
 */
export async function* streamMessages(
  url: string,
  headers: Record<string, string>,
  body: MessageRequest,
  signal: AbortSignal | undefined,
): AsyncGenerator<Event> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, accept: "text/event-stream" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (Math.floor(res.status / 100) !== 2) throw await normalizeHTTPError(res);
  if (!res.body) throw new Error("anthropic: streaming response had no body");

  // Maps a content-block index to its tool-call id so later input_json_delta
  // events (which carry only the index) can be attributed to the right call.
  const toolIndex = new Map<number, string>();
  const usage = emptyUsage();
  const reasoning: Reasoning = { thinking: "", signature: "" };
  let model = "";
  let stopReason: StopReason = "end_turn";

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    // SSE messages are separated by a blank line.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = parseDataLine(rawEvent);
      if (data === undefined) continue;
      // handleEvent throws on a mid-stream `error` frame; the throw propagates
      // through `yield*` to the `for await` consumer.
      yield* handleEvent(data, { toolIndex, usage, reasoning }, (m) => (model = m), (sr) => (stopReason = sr));
    }
  }

  const message = reasoningMessage(reasoning);
  yield { type: EventType.MessageStop, stopReason, usage, model, ...(message ? { message } : {}) };
}

/**
 * Extract and JSON-parse the `data:` payload from one SSE event block.
 *
 * Concatenates multiple `data:` lines within the block, ignores the terminal
 * `[DONE]` sentinel and empty payloads, and swallows parse failures.
 *
 * @returns The decoded event, or `undefined` when there is nothing to emit.
 */
function parseDataLine(rawEvent: string): SSEEvent | undefined {
  const dataParts: string[] = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("data:")) dataParts.push(line.slice(5).trimStart());
  }
  if (dataParts.length === 0) return undefined;
  const payload = dataParts.join("\n");
  if (payload === "" || payload === "[DONE]") return undefined;
  try {
    return JSON.parse(payload) as SSEEvent;
  } catch {
    return undefined;
  }
}

/**
 * Convert one decoded SSE event into galdor provider events, mutating the shared
 * accumulator state (tool-index map, usage, and reasoning) and reporting the
 * model and stop reason through the supplied setters. Block-stop, message-stop
 * and ping events produce nothing mid-stream. Thinking and signature deltas are
 * accumulated silently rather than forwarded. An `error` frame throws.
 *
 * @throws {APIError} When the frame is a mid-stream `error` event.
 */
function* handleEvent(
  ev: SSEEvent,
  state: { toolIndex: Map<number, string>; usage: Usage; reasoning: Reasoning },
  setModel: (m: string) => void,
  setStop: (sr: StopReason) => void,
): Generator<Event> {
  switch (ev.type) {
    case "message_start": {
      const model = ev.message?.model ?? "";
      if (model) setModel(model);
      if (ev.message?.usage?.input_tokens) state.usage.inputTokens = ev.message.usage.input_tokens;
      foldCacheUsage(state.usage, ev.message?.usage);
      yield { type: EventType.MessageStart, model, usage: { ...state.usage } };
      break;
    }
    case "content_block_start": {
      const cb = ev.content_block;
      if (cb?.type === "tool_use" && typeof ev.index === "number") {
        const id = cb.id ?? "";
        state.toolIndex.set(ev.index, id);
        yield { type: EventType.ToolCallDelta, toolCallDelta: { id, name: cb.name ?? "", argumentsDelta: "" } };
      }
      break;
    }
    case "content_block_delta": {
      const d = ev.delta;
      if (d?.type === "text_delta" && d.text) {
        yield { type: EventType.ContentDelta, contentDelta: d.text };
      } else if (d?.type === "input_json_delta" && typeof ev.index === "number") {
        const id = state.toolIndex.get(ev.index) ?? "";
        yield { type: EventType.ToolCallDelta, toolCallDelta: { id, name: "", argumentsDelta: d.partial_json ?? "" } };
      } else if (d?.type === "thinking_delta" && d.thinking) {
        // Extended-thinking text; gather it for the terminal message, not live.
        state.reasoning.thinking += d.thinking;
      } else if (d?.type === "signature_delta" && d.signature) {
        // The provider-issued signature for the thinking block, gathered silently.
        state.reasoning.signature += d.signature;
      }
      break;
    }
    case "message_delta": {
      if (ev.delta?.stop_reason) setStop(normalizeStopReason(ev.delta.stop_reason));
      if (ev.usage?.output_tokens) state.usage.outputTokens = ev.usage.output_tokens;
      foldCacheUsage(state.usage, ev.usage);
      break;
    }
    case "error": {
      // A mid-stream failure: classify by error type and propagate by throwing,
      // which surfaces to the `for await` consumer rather than being swallowed.
      throw classifyStreamError(ev.error?.type, ev.error?.message ?? "anthropic: stream error");
    }
    // content_block_stop / message_stop / ping: nothing to emit mid-stream.
  }
}
