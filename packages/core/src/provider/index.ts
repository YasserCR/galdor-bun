/**
 * core/provider — the central abstraction for talking to an LLM.
 *
 * Every model call in the framework flows through a {@link Provider}, so
 * swapping backends is a configuration line rather than a code change. This
 * module defines the request and response shapes ({@link Request},
 * {@link Response}), the capability descriptor ({@link Capabilities}), the
 * streaming event protocol ({@link Event}/{@link EventType}), and
 * {@link collectStream} for folding a stream back into a single response.
 *
 * Streaming is exposed as an `AsyncIterable<Event>`: consume it with
 * `for await (const ev of provider.stream(req))`. Cancellation is carried by an
 * optional {@link RunContext}, whose `AbortSignal` lets callers abort an
 * in-flight generation.
 */

import {
  ContentType,
  type Message,
  Role,
  type StopReason,
  textPart,
  type ToolCall,
  type ToolDef,
  type Usage,
} from "../schema/index.ts";

import type { RunContext } from "../runtime/context.ts";

export * from "./errors.ts";
export type { RunContext } from "../runtime/context.ts";

// ── Request ──────────────────────────────────────────────────────────────────

/**
 * How the model should treat the supplied tools: pick automatically (`"auto"`),
 * never call a tool (`"none"`), or be forced to call one (`"required"`).
 */
export type ToolChoice = "auto" | "none" | "required";

/**
 * Enumerates the structured-output modes: a free-form JSON object, or a JSON
 * value constrained by a supplied JSON Schema.
 */
export const ResponseFormatType = {
  JSONObject: "json_object",
  JSONSchema: "json_schema",
} as const;
/** One of the {@link ResponseFormatType} string values. */
export type ResponseFormatType = (typeof ResponseFormatType)[keyof typeof ResponseFormatType];

/** Requests that the model return structured output of a given {@link ResponseFormatType}. */
export interface ResponseFormat {
  /** Selects free-form JSON or schema-constrained JSON. */
  type: ResponseFormatType;
  /** JSON Schema (already-parsed) when type is json_schema. */
  schema?: unknown;
  /** Optional name for the schema, surfaced to providers that support it. */
  name?: string;
}

/** Relative amount of reasoning effort to request from a reasoning-capable model. */
export type ReasoningEffort = "low" | "medium" | "high";

/** Controls a model's internal reasoning / thinking behavior for a request. */
export interface ReasoningConfig {
  /** Whether reasoning is turned on for this request. */
  enabled: boolean;
  /** Optional token budget the model may spend on reasoning. */
  budget?: number;
  /** Optional qualitative effort level; an alternative to an explicit `budget`. */
  effort?: ReasoningEffort;
}

/** A single, provider-agnostic generation request. */
export interface Request {
  /** Identifier of the model to invoke. */
  model: string;
  /** Conversation so far, in order. */
  messages: Message[];
  /** Tools the model may call, if any. */
  tools?: ToolDef[];
  /** Constrains whether and how the model may use the supplied {@link Request.tools}. */
  toolChoice?: ToolChoice;
  /** Sampling temperature. */
  temperature?: number;
  /** Nucleus-sampling probability mass. */
  topP?: number;
  /** Upper bound on generated tokens. */
  maxTokens?: number;
  /** Strings that, when produced, stop generation. */
  stopSequences?: string[];
  /** Requests structured output of a particular shape. */
  responseFormat?: ResponseFormat;
  /** Requests and tunes model reasoning. */
  reasoning?: ReasoningConfig;
  /** Arbitrary key/value metadata forwarded to providers that accept it. */
  metadata?: Record<string, string>;
}

// ── Response ─────────────────────────────────────────────────────────────────

/** The complete result of a non-streaming generation. */
export interface Response {
  /** The assistant message produced by the model. */
  message: Message;
  /** Why generation stopped. */
  stopReason: StopReason;
  /** Token accounting for the call. */
  usage: Usage;
  /** Identifier of the model that actually served the request. */
  model: string;
  /** Raw provider payload, for debugging / replay fidelity. */
  providerRaw?: Uint8Array;
}

// ── Capabilities ─────────────────────────────────────────────────────────────

/** Describes which optional features a {@link Provider} supports. */
export interface Capabilities {
  /** Whether incremental streaming is available. */
  streaming: boolean;
  /** Whether the provider can call tools. */
  toolCalling: boolean;
  /** Whether structured (JSON / schema-constrained) output is available. */
  structuredOutput: boolean;
  /** Whether prompt caching is available. */
  promptCaching: boolean;
  /** Whether image input is accepted. */
  visionInput: boolean;
  /** Whether reasoning / thinking can be requested. */
  reasoning: boolean;
  /** Maximum context window, in tokens. */
  maxContextTokens: number;
}

// ── Streaming events ─────────────────────────────────────────────────────────

/** The kinds of {@link Event} a {@link Provider.stream} call can emit, in lifecycle order. */
export const EventType = {
  /** Emitted once at the start; carries initial model + (often empty) usage. */
  MessageStart: "message_start",
  /** Emitted per text fragment. */
  ContentDelta: "content_delta",
  /** Emitted as a tool call is built up; deltas share a stable `id`. */
  ToolCallDelta: "tool_call_delta",
  /** Emitted once at the end; carries final stopReason, usage and assembled message. */
  MessageStop: "message_stop",
} as const;
/** One of the {@link EventType} string values. */
export type EventType = (typeof EventType)[keyof typeof EventType];

/** An incremental fragment of a tool call delivered during streaming. */
export interface ToolCallDelta {
  /** Stable identifier shared by every delta belonging to the same call. */
  id: string;
  /** Set on the first delta for that call. */
  name: string;
  /** Appended to the running raw-JSON arguments by the consumer. */
  argumentsDelta: string;
}

/**
 * A single streaming event. The populated fields depend on {@link Event.type};
 * see {@link EventType} for which fields accompany each kind.
 */
export interface Event {
  /** Discriminator selecting which of the optional fields are meaningful. */
  type: EventType;
  /** Set when type is ContentDelta. */
  contentDelta?: string;
  /** Set when type is ToolCallDelta. */
  toolCallDelta?: ToolCallDelta;
  /** Set on MessageStop. */
  stopReason?: StopReason;
  /** Set on MessageStart (initial estimate) and MessageStop (final). */
  usage?: Usage;
  /** Assembled assistant message, optionally set on MessageStop. */
  message?: Message;
  /** Set on MessageStart. */
  model?: string;
}

// ── The interface ────────────────────────────────────────────────────────────

/**
 * The provider-agnostic contract every backend implements. Consumers depend on
 * this interface rather than any concrete provider.
 */
export interface Provider {
  /** @returns A short, stable identifier for the provider. */
  name(): string;
  /** @returns The provider's {@link Capabilities}. */
  capabilities(): Capabilities;
  /**
   * Run a single generation and return the complete {@link Response}.
   * @param req - The request to send.
   * @param ctx - Optional {@link RunContext} carrying an `AbortSignal` for cancellation.
   */
  generate(req: Request, ctx?: RunContext): Promise<Response>;
  /**
   * Run a generation and yield {@link Event}s incrementally.
   * @param req - The request to send.
   * @param ctx - Optional {@link RunContext} carrying an `AbortSignal` for cancellation.
   * @returns An async iterable of streaming events; see {@link collectStream} to fold it into a {@link Response}.
   */
  stream(req: Request, ctx?: RunContext): AsyncIterable<Event>;
}

const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
});

const isEmptyUsage = (u: Usage): boolean =>
  u.inputTokens === 0 &&
  u.outputTokens === 0 &&
  u.cacheCreationTokens === 0 &&
  u.cacheReadTokens === 0;

interface ToolBuilder {
  id: string;
  name: string;
  args: string;
}

/**
 * Consume a stream to completion and assemble a single {@link Response}.
 *
 * Acts as the bridge between streaming and non-streaming consumers:
 * concatenates content deltas, joins tool-call deltas by id (preserving
 * first-seen order), and places any thinking parts from the terminal message
 * ahead of the answer text.
 *
 * @param stream - The event stream to drain, typically from {@link Provider.stream}.
 * @returns The fully assembled response.
 * @throws SyntaxError If a tool call's accumulated arguments are not valid JSON.
 * @example
 * ```ts
 * const res = await collectStream(provider.stream(req));
 * console.log(res.message, res.usage);
 * ```
 */
export async function collectStream(stream: AsyncIterable<Event>): Promise<Response> {
  let text = "";
  const toolByID = new Map<string, ToolBuilder>();
  const toolOrder: string[] = [];
  let stopReason: StopReason = "end_turn";
  let usage = emptyUsage();
  let model = "";
  const thinking: Message["content"] = [];

  for await (const ev of stream) {
    switch (ev.type) {
      case EventType.MessageStart:
        if (ev.model) model = ev.model;
        if (ev.usage && !isEmptyUsage(ev.usage)) usage = ev.usage;
        break;
      case EventType.ContentDelta:
        if (ev.contentDelta) text += ev.contentDelta;
        break;
      case EventType.ToolCallDelta: {
        const d = ev.toolCallDelta;
        if (!d || d.id === "") continue;
        let tb = toolByID.get(d.id);
        if (!tb) {
          tb = { id: d.id, name: "", args: "" };
          toolByID.set(d.id, tb);
          toolOrder.push(d.id);
        }
        if (d.name) tb.name = d.name;
        if (d.argumentsDelta) tb.args += d.argumentsDelta;
        break;
      }
      case EventType.MessageStop:
        if (ev.stopReason) stopReason = ev.stopReason;
        if (ev.usage && !isEmptyUsage(ev.usage)) usage = ev.usage;
        if (ev.model) model = ev.model;
        if (ev.message) {
          for (const part of ev.message.content) {
            if (part.type === ContentType.Thinking) thinking.push(part);
          }
        }
        break;
    }
  }

  const content: Message["content"] = [...thinking];
  if (text !== "") content.push(textPart(text));

  const toolCalls: ToolCall[] = toolOrder.map((id) => {
    const tb = toolByID.get(id)!;
    return { id: tb.id, name: tb.name, arguments: tb.args === "" ? {} : JSON.parse(tb.args) };
  });

  const message: Message = { role: Role.Assistant, content };
  if (toolCalls.length > 0) message.toolCalls = toolCalls;

  return { message, stopReason, usage, model };
}

// ── Opt-in helpers ─────────────────────────────────────────────────────────────
//
// These wrappers and checks are exported for callers who want them; provider
// adapters do not install or invoke them automatically.

export { validateRequest } from "./capabilities.ts";
export { validateToolCalls, ToolCallInvariantError } from "./toolcalls.ts";
export {
  withRetry,
  withDefaultRetry,
  isRetryable,
  defaultRetryConfig,
  type RetryConfig,
} from "./retry.ts";
export { stripThinkingBlocks, extractThinkingBlocks } from "./strip-thinking.ts";
