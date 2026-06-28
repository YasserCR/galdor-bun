/**
 * Conversion between galdor's shared schema and the Anthropic Messages API
 * wire shape.
 *
 * One direction, {@link buildRequest}, lowers a galdor {@link Request} into the
 * snake_case JSON the Messages API expects: system messages are hoisted into a
 * dedicated `system` array, content parts and tool calls become typed blocks,
 * extended thinking and structured output are expressed in Anthropic's own
 * terms, and prompt-caching markers are attached to the final block of a span.
 * The other direction, {@link responseFromWire} (with
 * {@link extractStructuredOutput} and {@link usageFromWire}), collapses a wire
 * response back into a galdor {@link Response}.
 */

import type { Request, Response, ToolChoice } from "@galdor/core/provider";
import {
  ContentType,
  type ContentPart,
  type ImageContent,
  type Message,
  messageText,
  Role,
  type StopReason,
  textPart,
} from "@galdor/core/schema";

/**
 * Default `max_tokens` sent when the caller leaves {@link Request.maxTokens}
 * unset. The Messages API requires the field, so a concrete value is always
 * supplied.
 */
export const DEFAULT_MAX_TOKENS = 4096;

// ── Wire types (Anthropic JSON, snake_case) ──────────────────────────────────

/** A single Anthropic content block in its on-the-wire JSON form. */
interface WireBlock {
  type: string;
  text?: string;
  source?: { type: string; media_type?: string; data?: string; url?: string };
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  signature?: string;
  data?: string;
  tool_use_id?: string;
  content?: WireBlock[];
  is_error?: boolean;
  cache_control?: { type: string };
}

/** One turn in the Anthropic conversation array (role plus content blocks). */
interface WireMessage {
  role: string;
  content: WireBlock[];
}

/** Request body of the Anthropic Messages API in its JSON wire shape. */
export interface MessageRequest {
  model: string;
  messages: WireMessage[];
  system?: Array<{ type: string; text: string; cache_control?: { type: string } }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Array<{ name: string; description?: string; input_schema: unknown }>;
  tool_choice?: { type: string; name?: string };
  thinking?: { type: string; budget_tokens: number };
  metadata?: { user_id?: string };
}

/** Response body of a non-streaming Anthropic Messages API call. */
export interface MessageResponse {
  id: string;
  type: string;
  role: string;
  model: string;
  content: WireBlock[];
  stop_reason: string;
  stop_sequence?: string;
  usage: WireUsage;
}

/** Token-usage block reported by the Messages API, including cache counters. */
export interface WireUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Resolve the tool name used for forced structured output, defaulting when unnamed. */
function structuredToolName(name: string | undefined): string {
  return name && name !== "" ? name : "structured_output";
}

/** Encode raw image bytes as a base64 string for inline transport. */
function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

/** The non-null `source` shape of an image block. */
type WireImageSource = NonNullable<WireBlock["source"]>;

/**
 * Build the `source` of an image block, preferring a URL reference and otherwise
 * encoding inline bytes as base64.
 *
 * @throws {Error} When inline data is present but its MIME type is missing, or
 * when the part carries neither a URL nor data.
 */
function imageToWire(img: ImageContent): WireImageSource {
  if (img.url && img.url !== "") return { type: "url", url: img.url };
  if (img.data && img.data.length > 0) {
    if (!img.media) throw new Error("anthropic: inline image missing media (MIME type)");
    return { type: "base64", media_type: img.media, data: toBase64(img.data) };
  }
  throw new Error("anthropic: image part with no url or data");
}

/**
 * Convert galdor content parts into Anthropic content blocks, attaching the
 * message's cache-control marker to the final emitted block.
 *
 * Unsigned reasoning parts are dropped because they cannot be replayed without a
 * signature.
 *
 * @throws {Error} On an image part missing its image, or an unsupported part type.
 */
function partsToWire(parts: ContentPart[], cc: Message["cacheControl"]): WireBlock[] {
  const out: WireBlock[] = [];
  for (const p of parts) {
    switch (p.type) {
      case ContentType.Text:
        out.push({ type: "text", text: p.text ?? "" });
        break;
      case ContentType.Image:
        if (!p.image) throw new Error("anthropic: image part with nil image");
        out.push({ type: "image", source: imageToWire(p.image) });
        break;
      case ContentType.Thinking:
        if (!p.signature) continue; // unsigned reasoning can't be resent
        out.push({ type: "thinking", thinking: p.text ?? "", signature: p.signature });
        break;
      case ContentType.RedactedThinking:
        if (!p.signature) continue;
        out.push({ type: "redacted_thinking", data: p.signature });
        break;
      default:
        throw new Error(`anthropic: unsupported content type ${p.type}`);
    }
  }
  applyCacheControl(out, cc);
  return out;
}

/** Stamp the cache-control marker, if any, onto the last block of a span. */
function applyCacheControl(blocks: WireBlock[], cc: Message["cacheControl"]): void {
  if (cc && blocks.length > 0) blocks[blocks.length - 1]!.cache_control = { type: cc.type };
}

/**
 * Translate a galdor {@link ToolChoice} into the Anthropic `tool_choice` object.
 *
 * @returns The wire choice, or `undefined` to leave the field unset (provider default).
 */
function toolChoiceToWire(c: ToolChoice | undefined): MessageRequest["tool_choice"] {
  switch (c) {
    case "none":
      return { type: "none" };
    case "required":
      return { type: "any" };
    case "auto":
      return { type: "auto" };
    default:
      return undefined;
  }
}

/**
 * Translate a galdor {@link Request} into an Anthropic {@link MessageRequest}.
 *
 * System messages are hoisted into the `system` array; user, assistant and tool
 * messages become conversation turns, with consecutive tool results folded into
 * the preceding user turn. Enabling reasoning sets a thinking budget (clamped to
 * a minimum), grows `max_tokens` to cover it, and drops sampling controls that
 * are incompatible with extended thinking. A `json_schema` response format is
 * realized as a single forced tool call whose input schema is the requested one.
 *
 * @param req - The galdor request to lower.
 * @param stream - Whether to set the wire `stream` flag.
 * @returns The fully-formed Anthropic request body.
 * @throws {Error} When the model is empty, a role is unknown, or content cannot be converted.
 * @example
 * const wire = buildRequest({ model: "claude-haiku-4-5", messages }, false);
 */
export function buildRequest(req: Request, stream: boolean): MessageRequest {
  if (req.model === "") throw new Error("anthropic: model is required");

  let maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
  const out: MessageRequest = { model: req.model, messages: [], max_tokens: maxTokens, stream };
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.topP !== undefined) out.top_p = req.topP;
  if (req.stopSequences) out.stop_sequences = req.stopSequences;

  if (req.reasoning?.enabled) {
    let budget = req.reasoning.budget ?? 0;
    if (budget < 1024) budget = 1024;
    if (out.max_tokens <= budget) out.max_tokens = budget + maxTokens;
    out.thinking = { type: "enabled", budget_tokens: budget };
    delete out.temperature; // incompatible with extended thinking
    delete out.top_p;
  }

  for (const m of req.messages) {
    switch (m.role) {
      case Role.System:
        (out.system ??= []).push({ type: "text", text: messageText(m), ...(m.cacheControl ? { cache_control: { type: m.cacheControl.type } } : {}) });
        break;
      case Role.User:
        out.messages.push({ role: "user", content: partsToWire(m.content, m.cacheControl) });
        break;
      case Role.Assistant: {
        const blocks = partsToWire(m.content, undefined);
        for (const tc of m.toolCalls ?? []) {
          const input = tc.arguments === undefined || tc.arguments === null ? {} : tc.arguments;
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
        }
        applyCacheControl(blocks, m.cacheControl);
        out.messages.push({ role: "assistant", content: blocks });
        break;
      }
      case Role.Tool: {
        const block: WireBlock = {
          type: "tool_result",
          tool_use_id: m.toolCallId ?? "",
          content: [{ type: "text", text: messageText(m) }],
        };
        const last = out.messages.at(-1);
        if (last && last.role === "user") last.content.push(block);
        else out.messages.push({ role: "user", content: [block] });
        break;
      }
      default:
        throw new Error(`anthropic: unknown role ${m.role}`);
    }
  }

  if (req.tools && req.tools.length > 0) {
    out.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
  }
  const tc = toolChoiceToWire(req.toolChoice);
  if (tc) out.tool_choice = tc;

  // Structured output → forced single tool whose input_schema is the request's.
  if (req.responseFormat?.type === "json_schema") {
    const name = structuredToolName(req.responseFormat.name);
    out.tools = [{ name, description: "Respond by calling this tool with the structured result.", input_schema: req.responseFormat.schema }];
    out.tool_choice = { type: "tool", name };
  }

  const uid = req.metadata?.user_id;
  if (uid) out.metadata = { user_id: uid };

  return out;
}

/** Map a wire stop-reason string to a galdor {@link StopReason}, treating empty as `end_turn`. */
function normalizeStopReason(s: string): StopReason {
  switch (s) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "stop_sequence":
      return "stop_sequence";
    case "refusal":
      return "refusal";
    default:
      return (s === "" ? "end_turn" : s) as StopReason;
  }
}

/**
 * Convert a wire usage block into galdor's usage shape.
 *
 * @returns Token counts with cache-creation and cache-read figures, each
 * defaulting to zero when the field is absent.
 */
export function usageFromWire(u: WireUsage) {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}

/**
 * Collapse a non-streaming Anthropic {@link MessageResponse} into a galdor {@link Response}.
 *
 * Text and thinking blocks become assistant content parts; `tool_use` blocks
 * become tool calls; `redacted_thinking` is preserved via its signature. Empty
 * blocks are skipped.
 *
 * @returns The assembled response with message, stop reason, usage and model.
 */
export function responseFromWire(r: MessageResponse): Response {
  const message: Message = { role: Role.Assistant, content: [] };
  const toolCalls = [];
  for (const b of r.content) {
    switch (b.type) {
      case "text":
        if (b.text) message.content.push(textPart(b.text));
        break;
      case "tool_use":
        toolCalls.push({ id: b.id ?? "", name: b.name ?? "", arguments: (b.input ?? {}) as never });
        break;
      case "thinking":
        if (b.thinking) message.content.push({ type: ContentType.Thinking, text: b.thinking, ...(b.signature ? { signature: b.signature } : {}) });
        break;
      case "redacted_thinking":
        if (b.data) message.content.push({ type: ContentType.RedactedThinking, signature: b.data });
        break;
    }
  }
  if (toolCalls.length > 0) message.toolCalls = toolCalls;
  return { message, stopReason: normalizeStopReason(r.stop_reason), usage: usageFromWire(r.usage), model: r.model };
}

/**
 * Rewrite a forced structured-output tool call into plain message text.
 *
 * When the response contains the tool call that backs structured output, its
 * arguments are serialized to JSON and become the assistant message body, so
 * callers receive the structured result as text rather than a tool invocation.
 * If no matching call is found, the response is returned unchanged.
 *
 * @param resp - The response produced by {@link responseFromWire}.
 * @param schemaName - The configured schema name, resolved the same way as in {@link buildRequest}.
 * @returns The (possibly rewritten) response.
 */
export function extractStructuredOutput(resp: Response, schemaName: string | undefined): Response {
  const name = structuredToolName(schemaName);
  for (const tc of resp.message.toolCalls ?? []) {
    if (tc.name === name) {
      resp.message = { role: Role.Assistant, content: [textPart(JSON.stringify(tc.arguments))] };
      return resp;
    }
  }
  return resp;
}
