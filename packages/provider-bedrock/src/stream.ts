/**
 * Bedrock Runtime streaming over the binary event stream.
 *
 * Translates the Converse stream's typed events (`messageStart`,
 * `contentBlockStart`, `contentBlockDelta`, `contentBlockStop`, `messageStop`,
 * `metadata`) into galdor's provider {@link Event} stream
 * ({@link EventType.MessageStart}, {@link EventType.ContentDelta},
 * {@link EventType.ToolCallDelta}, {@link EventType.MessageStop}). The transport
 * frames are decoded by {@link decodeEventStream}; this module interprets each
 * frame's JSON payload, accumulates usage, stop reason and any streamed
 * reasoning, and emits a terminal {@link EventType.MessageStop} once the body is
 * exhausted. Consume the result with `for await`, or fold it back into a single
 * Response with `collectStream`.
 */

import { type Event, EventType } from "@galdor/core/provider";
import { ContentType, type Message, Role, type StopReason, type Usage } from "@galdor/core/schema";
import { normalizeStopReason } from "./convert.ts";
import { normalizeHTTPError, streamException } from "./errors.ts";
import { decodeEventStream } from "./eventstream.ts";

/** A zero-valued usage accumulator to fill in as the stream reports token counts. */
function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

/** Decoded payload of a Converse stream event; fields are populated by event type. */
interface StreamEvent {
  // messageStart
  role?: string;
  // contentBlockStart / contentBlockDelta
  contentBlockIndex?: number;
  start?: { toolUse?: { toolUseId?: string; name?: string } };
  delta?: {
    text?: string;
    toolUse?: { input?: string };
    reasoningContent?: { text?: string; signature?: string };
  };
  // messageStop
  stopReason?: string;
  // metadata
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number };
  // exception frames
  message?: string;
}

/**
 * POST a Converse stream request and yield galdor provider events.
 *
 * Reads the event-stream body incrementally: each frame is decoded into a typed
 * event and converted into zero or more {@link Event}s. A {@link EventType.MessageStart}
 * is emitted on the first content-bearing frame; running token usage, the stop
 * reason, and any streamed reasoning are accumulated and emitted in a final
 * {@link EventType.MessageStop}. Reasoning deltas are kept off the live stream
 * and surfaced only on the terminal message.
 *
 * @param url - Full converse-stream endpoint to POST to.
 * @param headers - Signed request headers, including auth and content type.
 * @param body - The serialized Converse request body.
 * @param model - Model id to stamp on every emitted event.
 * @param signal - Optional abort signal to cancel the in-flight request.
 * @returns An async generator of provider events, ending with a MessageStop.
 * @throws {APIError} When the response status is not 2xx, or an exception frame arrives mid-stream.
 * @throws {Error} When a 2xx response unexpectedly carries no body.
 */
export async function* streamConverse(
  url: string,
  headers: Record<string, string>,
  body: string,
  model: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<Event> {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body,
    ...(signal ? { signal } : {}),
  });
  if (Math.floor(res.status / 100) !== 2) throw await normalizeHTTPError(res);
  if (!res.body) throw new Error("bedrock: streaming response had no body");

  // Maps a content-block index to its tool-call id+name so later toolUse input
  // deltas (which carry only the index) can be attributed to the right call.
  const toolByIndex = new Map<number, { id: string; name: string }>();
  const usage = emptyUsage();
  let stopReason: StopReason = "end_turn";
  let started = false;
  let reasoning = "";
  let signature = "";

  const decoder = new TextDecoder();

  for await (const frame of decodeEventStream(res.body as unknown as AsyncIterable<Uint8Array>)) {
    const messageType = frame.headers[":message-type"];
    const eventType = frame.headers[":event-type"];
    const payload = frame.payload.length > 0 ? (JSON.parse(decoder.decode(frame.payload)) as StreamEvent) : {};

    if (messageType === "exception" || messageType === "error") {
      throw streamException(frame.headers[":exception-type"], payload.message ?? "");
    }

    // Any content-bearing event implies the message has begun; metadata can
    // arrive late, so it does not synthesize a start on its own.
    if (!started && eventType !== "metadata") {
      started = true;
      yield { type: EventType.MessageStart, model, usage: emptyUsage() };
    }

    switch (eventType) {
      case "messageStart":
        // The start event was already emitted above.
        break;
      case "contentBlockStart": {
        const tu = payload.start?.toolUse;
        if (tu) {
          const id = tu.toolUseId ?? "";
          const name = tu.name ?? "";
          toolByIndex.set(payload.contentBlockIndex ?? 0, { id, name });
          yield { type: EventType.ToolCallDelta, toolCallDelta: { id, name, argumentsDelta: "" } };
        }
        break;
      }
      case "contentBlockDelta": {
        const d = payload.delta;
        if (d && typeof d.text === "string") {
          yield { type: EventType.ContentDelta, contentDelta: d.text };
        } else if (d?.toolUse) {
          const st = toolByIndex.get(payload.contentBlockIndex ?? 0);
          yield {
            type: EventType.ToolCallDelta,
            toolCallDelta: { id: st?.id ?? "", name: st?.name ?? "", argumentsDelta: d.toolUse.input ?? "" },
          };
        } else if (d?.reasoningContent) {
          if (typeof d.reasoningContent.text === "string") reasoning += d.reasoningContent.text;
          if (typeof d.reasoningContent.signature === "string") signature += d.reasoningContent.signature;
        }
        break;
      }
      case "messageStop":
        stopReason = normalizeStopReason(payload.stopReason ?? "");
        break;
      case "metadata":
        if (payload.usage) {
          usage.inputTokens = payload.usage.inputTokens ?? 0;
          usage.outputTokens = payload.usage.outputTokens ?? 0;
          usage.cacheReadTokens = payload.usage.cacheReadInputTokens ?? 0;
          usage.cacheCreationTokens = payload.usage.cacheWriteInputTokens ?? 0;
        }
        break;
      // contentBlockStop: nothing to emit mid-stream.
    }
  }

  if (!started) yield { type: EventType.MessageStart, model, usage: emptyUsage() };

  // Carry any streamed reasoning on the terminal message so collectStream can
  // place it ahead of the answer text.
  const message: Message | undefined =
    reasoning !== ""
      ? { role: Role.Assistant, content: [{ type: ContentType.Thinking, text: reasoning, ...(signature ? { signature } : {}) }] }
      : undefined;

  yield { type: EventType.MessageStop, stopReason, usage, model, ...(message ? { message } : {}) };
}
