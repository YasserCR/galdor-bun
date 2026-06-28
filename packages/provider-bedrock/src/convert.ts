/**
 * Conversion between galdor's shared schema and the Bedrock Runtime Converse API
 * wire shape.
 *
 * {@link buildConverseRequest} lowers a galdor {@link Request} into the JSON the
 * Converse endpoint expects: system messages are hoisted into a dedicated
 * `system` array (Bedrock, like the Claude Messages API, treats system as a
 * separate channel rather than a role), content parts and tool calls become
 * tagged content blocks, tool results are folded onto the preceding user turn,
 * and extended thinking is requested through `additionalModelRequestFields`. The
 * reverse, {@link responseFromWire} (with {@link usageFromWire} and
 * {@link normalizeStopReason}), collapses a Converse response back into a galdor
 * {@link Response}.
 */

import type { Request, Response, ToolChoice } from "@galdor/core/provider";
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
  type ToolCall,
  type ToolDef,
  type Usage,
} from "@galdor/core/schema";

// ── Wire types (Converse JSON) ───────────────────────────────────────────────

/** A Converse content block; exactly one field is populated, tagging the block kind. */
interface ContentBlock {
  text?: string;
  image?: { format: string; source: { bytes: string } };
  toolUse?: { toolUseId: string; name: string; input: unknown };
  toolResult?: { toolUseId: string; content: Array<{ text: string }> };
  reasoningContent?: { reasoningText?: { text: string; signature?: string }; redactedContent?: string };
}

/** One turn in the Converse conversation array (role plus content blocks). */
interface ConverseMessage {
  role: string;
  content: ContentBlock[];
}

/** Tool choice selector accepted by Converse: pick freely, force any tool, or force one. */
type WireToolChoice = { auto: Record<string, never> } | { any: Record<string, never> } | { tool: { name: string } };

/** Sampling and length controls passed to the model. */
interface InferenceConfig {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
}

/** Request body of the Bedrock Runtime Converse API in its JSON wire shape. */
export interface ConverseRequest {
  messages: ConverseMessage[];
  system?: Array<{ text: string }>;
  inferenceConfig?: InferenceConfig;
  toolConfig?: {
    tools: Array<{ toolSpec: { name: string; description: string; inputSchema: { json: unknown } } }>;
    toolChoice?: WireToolChoice;
  };
  additionalModelRequestFields?: Record<string, unknown>;
  requestMetadata?: Record<string, string>;
}

/** Response body of a non-streaming Converse call. */
export interface ConverseResponse {
  output?: { message?: { role?: string; content?: ContentBlock[] } };
  stopReason?: string;
  usage?: WireUsage;
}

/** Token-usage block reported by Converse, including cache counters. */
export interface WireUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

/** Lowest reasoning budget Bedrock accepts when extended thinking is enabled. */
const MIN_REASONING_BUDGET = 1024;

/** Encode raw image bytes as a base64 string; Converse blob fields travel as base64. */
function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

/**
 * Map an image MIME type to the Converse `format` enum.
 *
 * @throws {Error} When the MIME type is outside Bedrock's accepted set.
 */
function imageFormatFromMIME(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpeg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      throw new Error(`bedrock: unsupported image MIME ${mime}`);
  }
}

/**
 * Build the Converse `image` block from a galdor image part.
 *
 * Bedrock accepts only inline bytes, so URL-only images are rejected at build
 * time rather than failing on the server.
 *
 * @throws {Error} When the image has no inline data or is missing its MIME type.
 */
function imageToBlock(img: ImageContent): ContentBlock {
  if (!img.data || img.data.length === 0) throw new Error("bedrock: image requires inline bytes; URL-only images are not accepted");
  if (!img.media) throw new Error("bedrock: inline image missing media (MIME type)");
  return { image: { format: imageFormatFromMIME(img.media), source: { bytes: toBase64(img.data) } } };
}

/**
 * Convert galdor content parts into Converse content blocks.
 *
 * Empty text parts are dropped, and unsigned reasoning is skipped because it
 * cannot be replayed; signed thinking is re-emitted with its signature so a
 * reasoning + tools turn can complete.
 *
 * @throws {Error} On an image part missing its image, or an unsupported part type.
 */
function partsToBlocks(parts: ContentPart[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const p of parts) {
    switch (p.type) {
      case ContentType.Text:
        if (p.text) out.push({ text: p.text });
        break;
      case ContentType.Image:
        if (!p.image) throw new Error("bedrock: image part with nil image");
        out.push(imageToBlock(p.image));
        break;
      case ContentType.Thinking:
        if (!p.signature) continue; // unsigned reasoning can't be resent
        out.push({ reasoningContent: { reasoningText: { text: p.text ?? "", signature: p.signature } } });
        break;
      case ContentType.RedactedThinking:
        if (!p.signature) continue;
        out.push({ reasoningContent: { redactedContent: p.signature } });
        break;
      default:
        throw new Error(`bedrock: unsupported content type ${p.type}`);
    }
  }
  return out;
}

/**
 * Assemble the `inferenceConfig` from the request's sampling and length fields,
 * returning `undefined` when none were set so the model's defaults apply.
 */
function buildInferenceConfig(req: Request): InferenceConfig | undefined {
  const cfg: InferenceConfig = {};
  let set = false;
  if (req.maxTokens !== undefined) {
    cfg.maxTokens = req.maxTokens;
    set = true;
  }
  if (req.temperature !== undefined) {
    cfg.temperature = req.temperature;
    set = true;
  }
  if (req.topP !== undefined) {
    cfg.topP = req.topP;
    set = true;
  }
  if (req.stopSequences && req.stopSequences.length > 0) {
    cfg.stopSequences = req.stopSequences;
    set = true;
  }
  return set ? cfg : undefined;
}

/** Translate a galdor {@link ToolChoice} into the Converse `toolChoice`, if any. */
function toolChoiceToWire(c: ToolChoice | undefined): WireToolChoice | undefined {
  switch (c) {
    case "auto":
      return { auto: {} };
    case "required":
      return { any: {} };
    // Converse has no "none": keep the tool definitions visible (a follow-up
    // turn validates prior tool_result blocks against them) and force no call.
    default:
      return undefined;
  }
}

/** Build the `toolConfig` block from the request's tool definitions and choice. */
function buildToolConfig(tools: ToolDef[], choice: ToolChoice | undefined): NonNullable<ConverseRequest["toolConfig"]> {
  const out: NonNullable<ConverseRequest["toolConfig"]> = {
    tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.schema } } })),
  };
  const tc = toolChoiceToWire(choice);
  if (tc) out.toolChoice = tc;
  return out;
}

/**
 * Translate a galdor {@link Request} into a Converse {@link ConverseRequest}.
 *
 * System messages are hoisted into the `system` array; user, assistant and tool
 * messages become conversation turns, with consecutive tool results folded into
 * the preceding user turn. Enabling reasoning sets a thinking budget (clamped to
 * a minimum) via `additionalModelRequestFields`, grows `maxTokens` to cover it,
 * and drops sampling controls that are incompatible with extended thinking.
 *
 * @param req - The galdor request to lower.
 * @returns The fully-formed Converse request body.
 * @throws {Error} When the model is empty, a role is unknown, or content cannot be converted.
 */
export function buildConverseRequest(req: Request): ConverseRequest {
  if (req.model === "") throw new Error("bedrock: model is required");

  const out: ConverseRequest = { messages: [] };

  for (const m of req.messages) {
    switch (m.role) {
      case Role.System:
        (out.system ??= []).push({ text: messageText(m) });
        break;
      case Role.User:
        out.messages.push({ role: "user", content: partsToBlocks(m.content) });
        break;
      case Role.Assistant: {
        const blocks = partsToBlocks(m.content);
        for (const tc of m.toolCalls ?? []) {
          const input = tc.arguments === undefined || tc.arguments === null ? {} : tc.arguments;
          blocks.push({ toolUse: { toolUseId: tc.id, name: tc.name, input } });
        }
        out.messages.push({ role: "assistant", content: blocks });
        break;
      }
      case Role.Tool: {
        const block: ContentBlock = {
          toolResult: { toolUseId: m.toolCallId ?? "", content: [{ text: messageText(m) }] },
        };
        const last = out.messages.at(-1);
        if (last && last.role === "user") last.content.push(block);
        else out.messages.push({ role: "user", content: [block] });
        break;
      }
      default:
        throw new Error(`bedrock: unknown role ${m.role}`);
    }
  }

  const inference = buildInferenceConfig(req);
  if (inference) out.inferenceConfig = inference;

  if (req.reasoning?.enabled) {
    let budget = req.reasoning.budget ?? 0;
    if (budget < MIN_REASONING_BUDGET) budget = MIN_REASONING_BUDGET;
    const ic: InferenceConfig = out.inferenceConfig ?? {};
    let maxTokens = budget + MIN_REASONING_BUDGET;
    if (ic.maxTokens !== undefined && ic.maxTokens > budget) maxTokens = ic.maxTokens;
    ic.maxTokens = maxTokens;
    delete ic.temperature; // incompatible with extended thinking
    delete ic.topP;
    out.inferenceConfig = ic;
    out.additionalModelRequestFields = { reasoning_config: { type: "enabled", budget_tokens: budget } };
  }

  if (req.tools && req.tools.length > 0) out.toolConfig = buildToolConfig(req.tools, req.toolChoice);

  // Forward only the user_id metadata, matching the other galdor adapters; other
  // keys are ignored per the Request.metadata contract.
  const uid = req.metadata?.["user_id"];
  if (uid) out.requestMetadata = { user_id: uid };

  return out;
}

/**
 * Map a Converse stop-reason string to a galdor {@link StopReason}.
 *
 * Guardrail and content-filter stops collapse to `refusal`; an empty value is
 * passed through unchanged; anything else is lowercased and used as-is.
 */
export function normalizeStopReason(s: string): StopReason {
  switch (s.toLowerCase()) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "stop_sequence":
      return "stop_sequence";
    case "guardrail_intervened":
    case "content_filtered":
      return "refusal";
    default:
      return (s === "" ? "" : s.toLowerCase()) as StopReason;
  }
}

/**
 * Convert a Converse usage block into galdor's usage shape.
 *
 * @returns Token counts with cache-write and cache-read figures, each defaulting
 * to zero when the field is absent.
 */
export function usageFromWire(u: WireUsage | undefined): Usage {
  return {
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cacheCreationTokens: u?.cacheWriteInputTokens ?? 0,
    cacheReadTokens: u?.cacheReadInputTokens ?? 0,
  };
}

/**
 * Collapse a non-streaming {@link ConverseResponse} into a galdor {@link Response}.
 *
 * Text blocks become assistant content parts; `toolUse` blocks become tool
 * calls; `reasoningContent` text is preserved with its signature. The model
 * field is left empty for the caller to fill from the request, since Converse
 * does not echo the model id in its body.
 *
 * @returns The assembled response with message, stop reason and usage.
 */
export function responseFromWire(body: ConverseResponse): Response {
  const message: Message = { role: Role.Assistant, content: [] };
  const toolCalls: ToolCall[] = [];
  for (const b of body.output?.message?.content ?? []) {
    if (typeof b.text === "string") {
      if (b.text) message.content.push(textPart(b.text));
    } else if (b.toolUse) {
      toolCalls.push({ id: b.toolUse.toolUseId ?? "", name: b.toolUse.name ?? "", arguments: (b.toolUse.input ?? {}) as JSONValue });
    } else if (b.reasoningContent?.reasoningText) {
      const rt = b.reasoningContent.reasoningText;
      if (rt.text) message.content.push({ type: ContentType.Thinking, text: rt.text, ...(rt.signature ? { signature: rt.signature } : {}) });
    }
  }
  if (toolCalls.length > 0) message.toolCalls = toolCalls;
  return { message, stopReason: normalizeStopReason(body.stopReason ?? ""), usage: usageFromWire(body.usage), model: "" };
}
