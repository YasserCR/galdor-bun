/**
 * Shared message and wire types for galdor.
 *
 * This module defines the common vocabulary every other package speaks:
 * conversation {@link Message}s, their {@link ContentPart}s, {@link ToolDef}
 * and {@link ToolCall} structures, {@link CacheControl}, and token
 * {@link Usage} accounting. Keeping these types in one place lets providers,
 * agents, and stores exchange data without depending on one another.
 *
 * Tool arguments and JSON Schemas are represented as already-parsed JSON via
 * {@link JSONValue} rather than raw byte strings, so callers work with native
 * objects and never re-parse. Message constructors are plain functions
 * ({@link userMessage}, {@link systemMessage}, and friends) to keep the type
 * definitions free of behavior.
 */

/**
 * Any value expressible as JSON: primitives, arrays, and string-keyed objects.
 *
 * Used for tool arguments and JSON Schema payloads, which are stored in
 * already-parsed form so consumers never need to deserialize them again.
 */
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

// ── Roles ────────────────────────────────────────────────────────────────────

/**
 * The four conversational roles a {@link Message} can take.
 *
 * Acts as both a value namespace (`Role.User`) and, via the companion type
 * below, the union of its string values.
 */
export const Role = {
  System: "system",
  User: "user",
  Assistant: "assistant",
  Tool: "tool",
} as const;
/** Union of the valid role string values: `"system" | "user" | "assistant" | "tool"`. */
export type Role = (typeof Role)[keyof typeof Role];

/**
 * Type guard reporting whether an arbitrary string is a recognized {@link Role}.
 *
 * @param r - The candidate role string, typically from untrusted input.
 * @returns `true` if `r` is one of the four known roles, narrowing it to {@link Role}.
 * @example
 * if (isValidRole(raw)) {
 *   // raw is now typed as Role
 * }
 */
export function isValidRole(r: string): r is Role {
  return r === Role.System || r === Role.User || r === Role.Assistant || r === Role.Tool;
}

// ── Content parts ──────────────────────────────────────────────────────────────

/**
 * The kinds of content a single {@link ContentPart} can carry, from plain text
 * to images and model thinking blocks.
 */
export const ContentType = {
  Text: "text",
  Image: "image",
  Thinking: "thinking",
  RedactedThinking: "redacted_thinking",
} as const;
/** Union of the valid content-type string values. */
export type ContentType = (typeof ContentType)[keyof typeof ContentType];

/**
 * Image payload for an {@link ContentPart} of type {@link ContentType.Image}.
 *
 * An image is supplied either by reference ({@link ImageContent.url}) or by
 * value ({@link ImageContent.data}); the two forms are mutually exclusive.
 */
export interface ImageContent {
  /** Remote URL of the image; mutually exclusive with {@link ImageContent.data}. */
  url?: string;
  /** Inline image bytes, base64-encoded when serialized for transport. */
  data?: Uint8Array;
  /** IANA media type of the image, e.g. `"image/png"`. */
  media?: string;
}

/**
 * One discrete piece of a {@link Message}'s content.
 *
 * The active field is determined by {@link ContentPart.type}: text parts use
 * {@link ContentPart.text}, image parts use {@link ContentPart.image}, and
 * thinking parts may carry a {@link ContentPart.signature}.
 */
export interface ContentPart {
  /** Discriminator selecting which payload field is meaningful. */
  type: ContentType;
  /** Text payload for text and thinking parts. */
  text?: string;
  /** Image payload for image parts. */
  image?: ImageContent;
  /** Cryptographic signature attached to a provider-issued thinking block. */
  signature?: string;
}

/**
 * Build a plain text {@link ContentPart}.
 *
 * @param text - The text to wrap.
 * @returns A content part of type {@link ContentType.Text}.
 */
export function textPart(text: string): ContentPart {
  return { type: ContentType.Text, text };
}

/**
 * Build a thinking {@link ContentPart} carrying intermediate model reasoning.
 *
 * @param text - The thinking text to wrap.
 * @returns A content part of type {@link ContentType.Thinking}.
 */
export function thinkingPart(text: string): ContentPart {
  return { type: ContentType.Thinking, text };
}

/**
 * Build an image {@link ContentPart} that references an image by URL.
 *
 * @param url - Remote location of the image.
 * @returns A content part of type {@link ContentType.Image}.
 */
export function imagePartURL(url: string): ContentPart {
  return { type: ContentType.Image, image: { url } };
}

/**
 * Build an image {@link ContentPart} from inline bytes.
 *
 * @param data - Raw image bytes.
 * @param media - IANA media type of the bytes, e.g. `"image/png"`.
 * @returns A content part of type {@link ContentType.Image}.
 */
export function imagePartData(data: Uint8Array, media: string): ContentPart {
  return { type: ContentType.Image, image: { data, media } };
}

// ── Tools ──────────────────────────────────────────────────────────────────────

/**
 * Declaration of a tool a model may invoke: its name, a human-readable
 * description, and the JSON Schema describing its input.
 */
export interface ToolDef {
  /** Unique tool name the model uses to select this tool. */
  name: string;
  /** Natural-language description guiding when and how to call the tool. */
  description: string;
  /** JSON Schema for the tool input, as an already-parsed JSON object. */
  schema: JSONValue;
}

/**
 * A model's request to run a specific tool with concrete arguments.
 *
 * The {@link ToolCall.id} is later echoed back by a tool-result message (see
 * {@link toolResultMessage}) to correlate the result with this call.
 */
export interface ToolCall {
  /** Identifier correlating this call with its eventual result. */
  id: string;
  /** Name of the {@link ToolDef} being invoked. */
  name: string;
  /** Invocation arguments as already-parsed JSON. */
  arguments: JSONValue;
}

// ── Cache control ────────────────────────────────────────────────────────────

/** Cache-control type value marking content for short-lived ("ephemeral") caching. */
export const CacheTypeEphemeral = "ephemeral" as const;

/**
 * Hint instructing a provider how to cache the content it is attached to.
 */
export interface CacheControl {
  /** Cache strategy identifier, e.g. {@link CacheTypeEphemeral}. */
  type: string;
}

/**
 * Build a {@link CacheControl} requesting ephemeral caching.
 *
 * @returns A cache-control hint of type {@link CacheTypeEphemeral}.
 */
export function ephemeralCache(): CacheControl {
  return { type: CacheTypeEphemeral };
}

// ── Messages ───────────────────────────────────────────────────────────────────

/**
 * A single turn in a conversation: a {@link Role} paired with one or more
 * {@link ContentPart}s, plus optional tool-call metadata and cache hints.
 */
export interface Message {
  /** Who is speaking this message. */
  role: Role;
  /** Ordered content parts that make up the message body. */
  content: ContentPart[];
  /** Optional speaker name, e.g. labeling a tool or function result. */
  name?: string;
  /** Tool invocations requested by an assistant message, if any. */
  toolCalls?: ToolCall[];
  /** On a tool-result message, the {@link ToolCall.id} this result answers. */
  toolCallId?: string;
  /** Optional caching hint for this message's content. */
  cacheControl?: CacheControl;
}

/**
 * Concatenate the text of every text part in a message, ignoring images and
 * thinking blocks.
 *
 * @param m - The message to read.
 * @returns The joined text of all {@link ContentType.Text} parts, or `""` if none.
 * @example
 * messageText(userMessage("hello")); // "hello"
 */
export function messageText(m: Message): string {
  let out = "";
  for (const part of m.content) {
    if (part.type === ContentType.Text && part.text) out += part.text;
  }
  return out;
}

/**
 * Build a system {@link Message} from a single text string.
 *
 * @param text - The system instruction text.
 * @returns A message with role {@link Role.System}.
 * @example
 * systemMessage("You are a helpful assistant.");
 */
export function systemMessage(text: string): Message {
  return { role: Role.System, content: [textPart(text)] };
}

/**
 * Build a user {@link Message} from a single text string.
 *
 * @param text - The user's text.
 * @returns A message with role {@link Role.User}.
 */
export function userMessage(text: string): Message {
  return { role: Role.User, content: [textPart(text)] };
}

/**
 * Build an assistant {@link Message} from a single text string.
 *
 * @param text - The assistant's text.
 * @returns A message with role {@link Role.Assistant}.
 */
export function assistantMessage(text: string): Message {
  return { role: Role.Assistant, content: [textPart(text)] };
}

/**
 * Build a tool-result {@link Message} that answers a prior {@link ToolCall}.
 *
 * @param callId - The {@link ToolCall.id} this result corresponds to.
 * @param result - The tool's textual output.
 * @returns A message with role {@link Role.Tool} and {@link Message.toolCallId} set to `callId`.
 */
export function toolResultMessage(callId: string, result: string): Message {
  return { role: Role.Tool, content: [textPart(result)], toolCallId: callId };
}

// ── Usage & stop reasons ──────────────────────────────────────────────────────

/**
 * Token accounting for a single model response, split across input, output,
 * and cache buckets.
 */
export interface Usage {
  /** Tokens consumed by the request prompt. */
  inputTokens: number;
  /** Tokens produced in the response. */
  outputTokens: number;
  /** Tokens written into the provider cache. */
  cacheCreationTokens: number;
  /** Tokens served from the provider cache. */
  cacheReadTokens: number;
}

/**
 * Sum every token bucket in a {@link Usage} record.
 *
 * @param u - The usage record to total.
 * @returns The combined input, output, and cache token count.
 */
export function usageTotal(u: Usage): number {
  return u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens;
}

/**
 * Why a model stopped generating: normal completion, a limit, a tool request,
 * a stop sequence, a refusal, or an error.
 */
export const StopReason = {
  EndTurn: "end_turn",
  MaxTokens: "max_tokens",
  ToolUse: "tool_use",
  StopSequence: "stop_sequence",
  Refusal: "refusal",
  Error: "error",
} as const;
/** Union of the valid stop-reason string values. */
export type StopReason = (typeof StopReason)[keyof typeof StopReason];
