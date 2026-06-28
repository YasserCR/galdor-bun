/**
 * OpenAI streaming over Server-Sent Events.
 *
 * Decodes each `data: {...}` chunk of the /chat/completions stream into galdor
 * provider {@link Event}s (MessageStart / ContentDelta / ToolCallDelta /
 * MessageStop). The OpenAI stream carries no dedicated opening frame, so
 * MessageStart is synthesized from the first chunk, and MessageStop is deferred
 * to the end: with `stream_options.include_usage = true` the final usage chunk
 * arrives after the `finish_reason` chunk. Some OpenAI-compatible backends close
 * the connection rather than emitting `data: [DONE]`, so the terminal
 * MessageStop is always synthesized from accumulated state, regardless of how
 * the stream ends. Consume the generator with `for await`, or fold it into a
 * single {@link Response} via `collectStream`.
 */

import { APIError, type Event, EventType } from "@galdor/core/provider";
import { Role, type StopReason, thinkingPart, type Usage } from "@galdor/core/schema";
import { normalizeFinishReason, usageFromWire, type WireUsage } from "./convert.ts";
import { kindForType, normalizeHTTPError } from "./errors.ts";

const PROVIDER_NAME = "openai";

interface ChunkFuncCall {
  name?: string;
  arguments?: string;
}

interface ChunkToolCall {
  id?: string;
  index?: number;
  function?: ChunkFuncCall;
}

interface ChunkDelta {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: ChunkToolCall[];
}

interface ChunkChoice {
  index?: number;
  delta?: ChunkDelta;
  finish_reason?: string;
}

interface ChunkError {
  type?: string;
  code?: string;
  message?: string;
}

interface ChatChunk {
  model?: string;
  choices?: ChunkChoice[];
  usage?: WireUsage;
  error?: ChunkError;
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

interface ToolState {
  id: string;
  name: string;
}

interface StreamState {
  started: boolean;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  reasoning: string;
  toolByIdx: Map<number, ToolState>;
}

/**
 * POST a streaming /chat/completions request and yield galdor provider events.
 *
 * Synthesizes a MessageStart from the first chunk, forwards content and tool-call
 * deltas as they arrive, accumulates reasoning and usage, and emits a terminal
 * MessageStop once the upstream stream ends.
 *
 * @param url - The fully-qualified /chat/completions endpoint to POST to.
 * @param headers - Request headers (auth, content-type, etc.); an SSE `Accept`
 * header is added automatically.
 * @param body - The request payload, serialized to JSON.
 * @param signal - Optional abort signal to cancel the in-flight request.
 * @returns An async generator of provider {@link Event}s ending in MessageStop.
 * @throws {APIError} When the HTTP response is non-2xx, or when an in-stream
 * error frame is received.
 * @throws {Error} When a 2xx response unexpectedly carries no body.
 * @example
 * ```ts
 * for await (const ev of streamChat(url, headers, wire, signal)) {
 *   if (ev.type === EventType.ContentDelta) process.stdout.write(ev.contentDelta);
 * }
 * ```
 */
export async function* streamChat(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
): AsyncGenerator<Event> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, accept: "text/event-stream" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (Math.floor(res.status / 100) !== 2) throw await normalizeHTTPError(res);
  if (!res.body) throw new Error("openai: streaming response had no body");

  const state: StreamState = {
    started: false,
    model: "",
    usage: emptyUsage(),
    stopReason: "end_turn",
    reasoning: "",
    toolByIdx: new Map(),
  };

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    // SSE events are separated by a blank line. Accept both LF and CRLF framing
    // so OpenAI-compatible backends that emit \r\n boundaries parse cleanly.
    let m: RegExpExecArray | null;
    while ((m = FRAME_BOUNDARY.exec(buffer)) !== null) {
      const rawEvent = buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
      FRAME_BOUNDARY.lastIndex = 0;
      const payload = parseDataLine(rawEvent);
      if (payload === undefined) continue;
      yield* handleChunk(payload, state);
    }
  }

  // Some backends close the connection without a blank-line-terminated final
  // frame; if the leftover buffer still holds a data line, process it so the
  // closing usage/finish chunk is not dropped.
  const tail = parseDataLine(buffer);
  if (tail !== undefined) yield* handleChunk(tail, state);

  yield terminalStop(state);
}

/** Matches an SSE blank-line frame boundary under either LF or CRLF framing. */
const FRAME_BOUNDARY = /\r?\n\r?\n/g;

/** Extract and JSON-parse the `data:` payload of one SSE event block. */
function parseDataLine(rawEvent: string): ChatChunk | undefined {
  const dataParts: string[] = [];
  for (const raw of rawEvent.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw; // strip CR under CRLF framing
    if (line.startsWith(":")) continue; // comment
    if (line.startsWith("data:")) dataParts.push(line.slice(5).trimStart());
  }
  if (dataParts.length === 0) return undefined;
  const payload = dataParts.join("\n");
  if (payload === "" || payload === "[DONE]") return undefined;
  try {
    return JSON.parse(payload) as ChatChunk;
  } catch {
    // Skip lines that fail to parse — be permissive about transport hiccups.
    return undefined;
  }
}

function terminalStop(state: StreamState): Event {
  const msg =
    state.reasoning !== ""
      ? { role: Role.Assistant, content: [thinkingPart(state.reasoning)] }
      : undefined;
  return {
    type: EventType.MessageStop,
    stopReason: state.stopReason,
    usage: state.usage,
    model: state.model,
    ...(msg ? { message: msg } : {}),
  };
}

function* handleChunk(c: ChatChunk, state: StreamState): Generator<Event> {
  // Surface an in-stream error frame instead of silently ending the stream.
  if (c.error) {
    const kind = kindForType(c.error.type, c.error.code) ?? "server";
    throw new APIError({ kind, provider: PROVIDER_NAME, statusCode: 0, message: c.error.message ?? "stream error" });
  }

  if (c.model) state.model = c.model;
  if (c.usage) state.usage = usageFromWire(c.usage);

  // First chunk: synthesize MessageStart, since the stream has no start frame.
  if (!state.started && (state.model !== "" || (c.choices?.length ?? 0) > 0)) {
    state.started = true;
    yield { type: EventType.MessageStart, model: state.model };
  }

  const ch = c.choices?.[0];
  if (!ch) return;

  if (ch.delta?.reasoning_content) {
    // Accumulate reasoning; do not forward it on the live stream.
    state.reasoning += ch.delta.reasoning_content;
  }

  if (ch.delta?.content) {
    yield { type: EventType.ContentDelta, contentDelta: ch.delta.content };
  }

  for (const td of ch.delta?.tool_calls ?? []) {
    const ts = touchToolState(td, state);
    yield {
      type: EventType.ToolCallDelta,
      toolCallDelta: { id: ts.id, name: td.function?.name ?? "", argumentsDelta: td.function?.arguments ?? "" },
    };
  }

  if (ch.finish_reason) state.stopReason = normalizeFinishReason(ch.finish_reason);
}

/**
 * Ensure a ToolState exists for `td.index` (defaulting to 0) and fold any new
 * id or name from this delta into it. Some OpenAI-compatible backends omit
 * `tool_call` ids, so a stable id is synthesized from the index to keep the call
 * from being dropped downstream (collectStream discards id-less tool deltas).
 */
function touchToolState(td: ChunkToolCall, state: StreamState): ToolState {
  const idx = td.index ?? 0;
  let ts = state.toolByIdx.get(idx);
  if (!ts) {
    ts = { id: "", name: "" };
    state.toolByIdx.set(idx, ts);
  }
  if (td.id) ts.id = td.id;
  if (td.function?.name) ts.name = td.function.name;
  if (ts.id === "") ts.id = `call_${idx}`;
  return ts;
}
