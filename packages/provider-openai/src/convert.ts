/**
 * Conversion between galdor's shared schema and the OpenAI Chat Completions API
 * wire shape.
 *
 * On the wire OpenAI carries the system prompt as a `role: system` message and
 * tool results as `role: tool` messages keyed by `tool_call_id`. The wire types
 * declared below model OpenAI's snake_case JSON exactly. The two entry points are
 * {@link buildRequest} (galdor request to wire request) and
 * {@link responseFromWire} (wire response to galdor response).
 */

import type { Request, Response } from "@galdor/core/provider";
import {
  ContentType,
  type ContentPart,
  type ImageContent,
  type JSONValue,
  type Message,
  messageText,
  Role,
  type StopReason,
  textPart,
  thinkingPart,
  type ToolCall,
} from "@galdor/core/schema";

// ── Wire types (OpenAI JSON, snake_case) ─────────────────────────────────────

interface WireImageURL {
  url: string;
  detail?: string;
}

interface WireContentPart {
  type: string;
  text?: string;
  image_url?: WireImageURL;
}

interface WireFuncCall {
  name?: string;
  arguments?: string;
}

interface WireToolCall {
  id?: string;
  type?: string;
  function: WireFuncCall;
  /** Only set on streaming deltas. */
  index?: number;
}

interface WireMessage {
  role: string;
  content?: string | WireContentPart[];
  name?: string;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  /** Reasoning from OpenAI-compatible models (e.g. DeepSeek-R1). Inbound only. */
  reasoning_content?: string;
}

interface WireFuncDecl {
  name: string;
  description?: string;
  parameters: unknown;
}

interface WireTool {
  type: string;
  function: WireFuncDecl;
}

interface WireJSONSchema {
  name?: string;
  strict?: boolean;
  schema: unknown;
}

interface WireRespFormat {
  type: string;
  json_schema?: WireJSONSchema;
}

/** Serialized request body for the OpenAI /chat/completions endpoint. */
export interface ChatRequest {
  model: string;
  messages: WireMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  tools?: WireTool[];
  tool_choice?: string;
  response_format?: WireRespFormat;
  reasoning_effort?: string;
  user?: string;
}

interface WireTokenDetails {
  cached_tokens?: number;
}

/** Token accounting block as returned by OpenAI, in its snake_case form. */
export interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: WireTokenDetails;
}

interface WireResponseMessage {
  role?: string;
  content?: string | WireContentPart[];
  tool_calls?: WireToolCall[];
  reasoning_content?: string;
}

interface WireChoice {
  index?: number;
  message: WireResponseMessage;
  finish_reason?: string;
}

/** Decoded body of a non-streaming OpenAI /chat/completions response. */
export interface ChatResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: WireChoice[];
  usage?: WireUsage;
}

// ── Request building ─────────────────────────────────────────────────────────

function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

/** Render an image part as OpenAI's image_url.url (direct URL or data: URL). */
function imageToURL(img: ImageContent): string {
  if (img.url && img.url !== "") return img.url;
  if (img.data && img.data.length > 0) {
    if (!img.media) throw new Error("openai: inline image missing media (MIME type)");
    return `data:${img.media};base64,${toBase64(img.data)}`;
  }
  throw new Error("openai: image part with no url or data");
}

function partsToWire(parts: ContentPart[]): WireContentPart[] {
  const out: WireContentPart[] = [];
  for (const p of parts) {
    switch (p.type) {
      case ContentType.Text:
        out.push({ type: "text", text: p.text ?? "" });
        break;
      case ContentType.Image:
        if (!p.image) throw new Error("openai: image part with nil image");
        out.push({ type: "image_url", image_url: { url: imageToURL(p.image) } });
        break;
      case ContentType.Thinking:
      case ContentType.RedactedThinking:
        // Reasoning is model output, not input: never echo it back.
        continue;
      default:
        throw new Error(`openai: unsupported content type ${p.type}`);
    }
  }
  return out;
}

function roleToWire(r: Role): string {
  switch (r) {
    case Role.System:
      return "system";
    case Role.User:
      return "user";
    case Role.Assistant:
      return "assistant";
    case Role.Tool:
      return "tool";
    default:
      throw new Error(`openai: unknown role ${r}`);
  }
}

function messageToWire(m: Message): WireMessage {
  const wm: WireMessage = { role: roleToWire(m.role) };
  if (m.name) wm.name = m.name;
  if (m.toolCallId) wm.tool_call_id = m.toolCallId;

  // Assistant tool calls.
  const toolCalls: WireToolCall[] = [];
  for (const tc of m.toolCalls ?? []) {
    toolCalls.push({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: stringifyArguments(tc.arguments) },
    });
  }
  if (toolCalls.length > 0) wm.tool_calls = toolCalls;

  // Content. Prefer the plain-string form when all parts are text; use the
  // array form when any non-text part is present.
  const allText = m.content.every((p) => p.type === ContentType.Text);
  if (m.content.length === 0 && toolCalls.length > 0) {
    // Assistant tool-call-only messages omit content.
  } else if (allText) {
    wm.content = messageText(m);
  } else {
    wm.content = partsToWire(m.content);
  }

  return wm;
}

function stringifyArguments(args: JSONValue): string {
  if (args === undefined || args === null) return "{}";
  if (typeof args === "string") return args;
  return JSON.stringify(args);
}

function toolChoiceToWire(c: Request["toolChoice"]): string | undefined {
  switch (c) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "required":
      return "required";
    default:
      return undefined;
  }
}

function responseFormatToWire(rf: Request["responseFormat"]): WireRespFormat | undefined {
  if (!rf) return undefined;
  switch (rf.type) {
    case "json_object":
      return { type: "json_object" };
    case "json_schema":
      return {
        type: "json_schema",
        json_schema: { ...(rf.name ? { name: rf.name } : {}), strict: true, schema: rf.schema },
      };
    default:
      return undefined;
  }
}

/**
 * Translate a galdor {@link Request} into an OpenAI Chat Completions wire
 * request.
 *
 * Maps messages, tools, tool choice and response format; toggles
 * `stream`/`stream_options` for streaming; and applies o-series reasoning rules,
 * where the effort level is set and `max_tokens` is moved to
 * `max_completion_tokens` while `temperature` and `top_p` are dropped (those
 * models reject them).
 *
 * @param req - The provider-neutral galdor request to translate.
 * @param stream - When true, request a streamed response with usage included.
 * @returns The wire-ready {@link ChatRequest}.
 * @throws {Error} When `req.model` is empty, or a message contains an unknown
 * role or unsupported content type.
 * @example
 * ```ts
 * const wire = buildRequest({ model: "gpt-4o-mini", messages }, false);
 * ```
 */
export function buildRequest(req: Request, stream: boolean): ChatRequest {
  if (req.model === "") throw new Error("openai: model is required");

  const out: ChatRequest = { model: req.model, messages: req.messages.map(messageToWire) };
  if (req.maxTokens !== undefined) out.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.topP !== undefined) out.top_p = req.topP;
  // Only emit `stop` when non-empty; an empty array is a no-op some backends reject.
  if (req.stopSequences && req.stopSequences.length > 0) out.stop = req.stopSequences;
  if (stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }

  if (req.tools && req.tools.length > 0) {
    out.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.schema },
    }));
  }

  const tc = toolChoiceToWire(req.toolChoice);
  if (tc) out.tool_choice = tc;

  const rf = responseFormatToWire(req.responseFormat);
  if (rf) out.response_format = rf;

  if (req.reasoning?.enabled) {
    // OpenAI is effort-based (o-series): map the effort level, defaulting to
    // medium. Budget is ignored.
    out.reasoning_effort = req.reasoning.effort ?? "medium";
    // o-series reasoning models reject max_tokens (use max_completion_tokens)
    // and reject temperature / top_p. Move and drop them so the request is
    // accepted.
    if (out.max_tokens !== undefined) out.max_completion_tokens = out.max_tokens;
    delete out.max_tokens;
    delete out.temperature;
    delete out.top_p;
  }

  const uid = req.metadata?.user_id;
  if (uid) out.user = uid;

  return out;
}

// ── Response decoding ────────────────────────────────────────────────────────

/** Concatenate text from either content form (plain string or part array). */
function decodeContent(content: string | WireContentPart[] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  let out = "";
  for (const p of content) {
    if (p.type === "text" && p.text) out += p.text;
  }
  return out;
}

function parseArguments(raw: string | undefined): JSONValue {
  if (!raw || raw === "") return {};
  try {
    return JSON.parse(raw) as JSONValue;
  } catch {
    return raw;
  }
}

/**
 * Convert OpenAI's wire usage block into galdor's {@link Usage} shape.
 *
 * @param u - The wire usage object, or `undefined` when absent.
 * @returns A usage record; missing fields default to 0. Cached prompt tokens are
 * reported as cache reads; cache-creation tokens are always 0.
 */
export function usageFromWire(u: WireUsage | undefined) {
  return {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    cacheCreationTokens: 0,
    cacheReadTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

/**
 * Map an OpenAI `finish_reason` string to a galdor {@link StopReason}.
 *
 * @param s - The wire finish reason (e.g. `"stop"`, `"length"`, `"tool_calls"`).
 * @returns The corresponding {@link StopReason}; an empty or absent value
 * becomes `"end_turn"`, and an unrecognized value is passed through unchanged.
 */
export function normalizeFinishReason(s: string | undefined): StopReason {
  switch (s) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return (s === undefined || s === "" ? "end_turn" : s) as StopReason;
  }
}

/**
 * Collapse a non-streaming Chat Completions response into a galdor
 * {@link Response}.
 *
 * Reads the first choice: surfaces any reasoning content as a thinking part,
 * appends decoded text, and collects tool calls (parsing their JSON arguments).
 *
 * @param r - The decoded wire response.
 * @param raw - Optional raw response bytes, attached as `providerRaw` when given.
 * @returns The assembled galdor {@link Response} with message, stop reason,
 * usage and model.
 */
export function responseFromWire(r: ChatResponse, raw?: Uint8Array): Response {
  const message: Message = { role: Role.Assistant, content: [] };
  let stopReason: StopReason = "end_turn";

  const choice = r.choices?.[0];
  if (choice) {
    stopReason = normalizeFinishReason(choice.finish_reason);

    if (choice.message.reasoning_content) {
      // Reasoning from an OpenAI-compatible model (e.g. DeepSeek). messageText
      // skips it, so the answer stays clean.
      message.content.push(thinkingPart(choice.message.reasoning_content));
    }
    const text = decodeContent(choice.message.content);
    if (text !== "") message.content.push(textPart(text));

    const toolCalls: ToolCall[] = [];
    for (const t of choice.message.tool_calls ?? []) {
      toolCalls.push({ id: t.id ?? "", name: t.function.name ?? "", arguments: parseArguments(t.function.arguments) });
    }
    if (toolCalls.length > 0) message.toolCalls = toolCalls;
  }

  return {
    message,
    stopReason,
    usage: usageFromWire(r.usage),
    model: r.model ?? "",
    ...(raw ? { providerRaw: raw } : {}),
  };
}
