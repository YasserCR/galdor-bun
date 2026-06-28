/**
 * Conversion between galdor's shared schema and the Gemini generateContent wire
 * shape, in both directions.
 *
 * Wire objects use Google's JSON shapes (contents[].parts[], role "user"/"model",
 * functionCall/functionResponse, systemInstruction, generationConfig,
 * usageMetadata). They are deliberately kept separate from galdor's schema so
 * quirks of the wire format stay contained and never leak into application code.
 */

import type { Request, Response, ToolChoice } from "@galdor/core/provider";
import {
  ContentType,
  type ContentPart,
  type ImageContent,
  type JSONValue,
  type Message,
  Role,
  type StopReason,
  type ToolCall,
  textPart,
  thinkingPart,
  type Usage,
} from "@galdor/core/schema";

// ── Wire types (Gemini JSON, camelCase) ──────────────────────────────────────

/** Inline binary payload (e.g. an image) sent to Gemini as base64 with its MIME type. */
export interface WireBlob {
  mimeType: string;
  data: string; // base64
}

interface WireFileData {
  mimeType: string;
  fileUri: string;
}

interface WireFunctionCall {
  name: string;
  args?: JSONValue;
}

interface WireFunctionResponse {
  name: string;
  response: JSONValue;
}

/** One element of a Gemini content block: exactly one of its fields is set per part. */
export interface WirePart {
  text?: string;
  inlineData?: WireBlob;
  fileData?: WireFileData;
  functionCall?: WireFunctionCall;
  functionResponse?: WireFunctionResponse;
  /** Thought-summary marker (Gemini 2.5 thinking models). */
  thought?: boolean;
}

/** A Gemini content block: an optional role ("user" or "model") and its ordered parts. */
export interface WireContent {
  role?: string;
  parts: WirePart[];
}

interface WireFuncDecl {
  name: string;
  description?: string;
  parameters?: unknown;
}

interface WireTool {
  functionDeclarations?: WireFuncDecl[];
}

interface WireFCCfg {
  mode?: string; // "AUTO" | "ANY" | "NONE"
  allowedFunctionNames?: string[];
}

interface WireToolConfig {
  functionCallingConfig?: WireFCCfg;
}

interface WireThinkingCfg {
  includeThoughts?: boolean;
  thinkingBudget?: number;
}

interface WireGenerationCfg {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  responseMimeType?: string;
  responseSchema?: unknown;
  thinkingConfig?: WireThinkingCfg;
}

interface WireSafety {
  category: string;
  threshold: string;
}

/** The full request body for a generateContent (or streamGenerateContent) call. */
export interface GenerateRequest {
  contents: WireContent[];
  systemInstruction?: WireContent;
  tools?: WireTool[];
  toolConfig?: WireToolConfig;
  generationConfig?: WireGenerationCfg;
  safetySettings?: WireSafety[];
  cachedContent?: string;
}

/** Token accounting block returned by Gemini, mapped to galdor {@link Usage} by {@link usageFromWire}. */
export interface WireUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

interface WireCandidate {
  content?: WireContent;
  finishReason?: string;
  index?: number;
}

/** Prompt-level feedback; a non-empty {@code blockReason} means the safety filter rejected the prompt. */
export interface WirePromptFeedback {
  blockReason?: string;
}

/** google.rpc-style error block, shared by HTTP errors and in-stream error frames. */
export interface WireErrorBody {
  code?: number;
  message?: string;
  status?: string;
  details?: Array<{ "@type"?: string; reason?: string }>;
}

/**
 * Body of a successful non-streaming call, and also a single server-sent frame
 * on the streaming endpoint. `error` is populated only on a streamed error frame.
 */
export interface GenerateResponse {
  candidates?: WireCandidate[];
  usageMetadata?: WireUsage;
  modelVersion?: string;
  promptFeedback?: WirePromptFeedback;
  error?: WireErrorBody;
}

// ── Request building ─────────────────────────────────────────────────────────

function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

/**
 * A Gemini inlineData blob. Gemini does not accept http(s) URLs directly; for
 * URL-based images, callers must download them beforehand or use the File API.
 */
function imageToWire(img: ImageContent): WireBlob {
  if (img.data && img.data.length > 0) {
    if (!img.media) throw new Error("google: inline image missing media (MIME type)");
    return { mimeType: img.media, data: toBase64(img.data) };
  }
  if (img.url && img.url !== "") {
    throw new Error(
      "google: Gemini does not accept image URLs in inline content; fetch the bytes or upload via the File API",
    );
  }
  throw new Error("google: image part with no data");
}

function partsToWire(parts: ContentPart[]): WirePart[] {
  const out: WirePart[] = [];
  for (const p of parts) {
    switch (p.type) {
      case ContentType.Text:
        if (!p.text) continue;
        out.push({ text: p.text });
        break;
      case ContentType.Image:
        if (!p.image) throw new Error("google: image part with nil image");
        out.push({ inlineData: imageToWire(p.image) });
        break;
      case ContentType.Thinking:
        // Reasoning parts are model output, not input: never echo them back.
        continue;
      default:
        throw new Error(`google: unsupported content type ${p.type}`);
    }
  }
  return out;
}

function toolConfigFromChoice(c: ToolChoice | undefined): WireToolConfig | undefined {
  switch (c) {
    case "auto":
      return { functionCallingConfig: { mode: "AUTO" } };
    case "none":
      return { functionCallingConfig: { mode: "NONE" } };
    case "required":
      return { functionCallingConfig: { mode: "ANY" } };
    default:
      return undefined;
  }
}

/**
 * Wrap a plain text tool result into the JSON object shape Gemini's
 * functionResponse.response expects. If text already looks like a JSON object,
 * it is passed through (parsed) verbatim.
 */
function toolResponseJSON(text: string): JSONValue {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      return JSON.parse(trimmed) as JSONValue;
    } catch {
      /* fall through to wrapping */
    }
  }
  return { result: text };
}

/**
 * Build a stable, parseable ID for a function call coming back from Gemini.
 * The format embeds the function name so a later tool result can recover it,
 * since Gemini matches tool results by name rather than by an opaque call ID.
 *
 * @param name - The function (tool) name from the model's call.
 * @param partIndex - Index of the call among the candidate's parts, for uniqueness.
 * @returns An ID of the form {@code gfc_<index>_<name>}.
 */
export function synthToolID(name: string, partIndex: number): string {
  return `gfc_${partIndex}_${name}`;
}

function buildGenerationConfig(req: Request): WireGenerationCfg | undefined {
  const cfg: WireGenerationCfg = {};
  if (req.temperature !== undefined) cfg.temperature = req.temperature;
  if (req.topP !== undefined) cfg.topP = req.topP;
  if (req.maxTokens !== undefined) cfg.maxOutputTokens = req.maxTokens;
  if (req.stopSequences && req.stopSequences.length > 0) cfg.stopSequences = req.stopSequences;

  const rf = req.responseFormat;
  if (rf) {
    if (rf.type === "json_object") {
      cfg.responseMimeType = "application/json";
    } else if (rf.type === "json_schema") {
      cfg.responseMimeType = "application/json";
      if (rf.schema !== undefined) cfg.responseSchema = rf.schema;
    }
  }

  const rc = req.reasoning;
  if (rc?.enabled) {
    // Gemini is budget-based: ask for thought summaries and, when a budget is
    // given, cap the reasoning tokens. Effort is ignored.
    const tc: WireThinkingCfg = { includeThoughts: true };
    if (rc.budget !== undefined && rc.budget > 0) tc.thinkingBudget = rc.budget;
    cfg.thinkingConfig = tc;
  }

  // Return undefined when nothing was set, to keep the request body small.
  if (
    cfg.temperature === undefined &&
    cfg.topP === undefined &&
    cfg.maxOutputTokens === undefined &&
    !cfg.stopSequences &&
    !cfg.responseMimeType &&
    cfg.responseSchema === undefined &&
    !cfg.thinkingConfig
  ) {
    return undefined;
  }
  return cfg;
}

/**
 * Translate a galdor {@link Request} into the Gemini {@link GenerateRequest}
 * shape. System messages are hoisted into systemInstruction (and concatenated
 * when there is more than one); assistant tool calls become functionCall parts;
 * and tool-role messages are folded back onto a "user" content block as
 * functionResponse parts, merged into the trailing user block when possible.
 *
 * @param req - The provider-agnostic request to translate.
 * @returns The Gemini request body ready to serialize.
 * @throws {Error} When the model is empty, an image part is malformed, or a content type/role is unsupported.
 */
export function buildRequest(req: Request): GenerateRequest {
  if (req.model === "") throw new Error("google: model is required");

  const out: GenerateRequest = { contents: [] };

  // Look up tool calls by ID across the assistant messages so a later tool
  // result can recover the function name (Gemini matches by name, not ID).
  const toolIDToName = new Map<string, string>();
  for (const m of req.messages) {
    if (m.role !== Role.Assistant) continue;
    for (const tc of m.toolCalls ?? []) {
      if (tc.id !== "") toolIDToName.set(tc.id, tc.name);
    }
  }

  for (const m of req.messages) {
    switch (m.role) {
      case Role.System: {
        // Append, don't overwrite: multiple system messages must all reach Gemini.
        if (!out.systemInstruction) out.systemInstruction = { parts: [] };
        out.systemInstruction.parts.push({ text: messageTextOf(m) });
        break;
      }
      case Role.User:
        out.contents.push({ role: "user", parts: partsToWire(m.content) });
        break;
      case Role.Assistant: {
        const parts = partsToWire(m.content);
        for (const tc of m.toolCalls ?? []) {
          parts.push({ functionCall: { name: tc.name, ...(tc.arguments !== undefined ? { args: tc.arguments } : {}) } });
        }
        out.contents.push({ role: "model", parts });
        break;
      }
      case Role.Tool: {
        // Fallback: some callers pass the function name directly in toolCallId.
        const name = toolIDToName.get(m.toolCallId ?? "") ?? m.toolCallId ?? "";
        const block: WirePart = {
          functionResponse: { name, response: toolResponseJSON(messageTextOf(m)) },
        };
        // Function responses live in a "user"-role content block. Merge into the
        // trailing user message when possible so parallel results stay grouped.
        const last = out.contents.at(-1);
        if (last && last.role === "user") last.parts.push(block);
        else out.contents.push({ role: "user", parts: [block] });
        break;
      }
      default:
        throw new Error(`google: unknown role ${m.role}`);
    }
  }

  const gc = buildGenerationConfig(req);
  if (gc) out.generationConfig = gc;

  if (req.tools && req.tools.length > 0) {
    const decls: WireFuncDecl[] = req.tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.schema !== undefined ? { parameters: t.schema } : {}),
    }));
    out.tools = [{ functionDeclarations: decls }];
  }

  const tc = toolConfigFromChoice(req.toolChoice);
  if (tc) out.toolConfig = tc;

  return out;
}

/** Concatenate the text parts of a message into a single string, ignoring non-text parts. */
function messageTextOf(m: Message): string {
  let out = "";
  for (const part of m.content) {
    if (part.type === ContentType.Text && part.text) out += part.text;
  }
  return out;
}

// ── Response parsing ─────────────────────────────────────────────────────────

/**
 * Map a Gemini {@link WireUsage} block onto galdor's {@link Usage}, treating
 * missing counts as zero. Thinking tokens are folded into outputTokens, and
 * cached-content tokens are reported as cache reads.
 *
 * @param u - The usage block, possibly undefined.
 * @returns A fully populated {@link Usage} record.
 */
export function usageFromWire(u: WireUsage | undefined): Usage {
  const w = u ?? {};
  return {
    inputTokens: w.promptTokenCount ?? 0,
    outputTokens: (w.candidatesTokenCount ?? 0) + (w.thoughtsTokenCount ?? 0),
    cacheCreationTokens: 0,
    cacheReadTokens: w.cachedContentTokenCount ?? 0,
  };
}

/**
 * Map a Gemini finishReason onto galdor's {@link StopReason}. STOP becomes
 * "end_turn", MAX_TOKENS becomes "max_tokens", and the safety-related reasons
 * (SAFETY, RECITATION, BLOCKLIST, PROHIBITED_CONTENT, SPII) all become "refusal".
 * An empty or absent reason yields the empty stop reason; anything else is
 * lower-cased and passed through.
 *
 * @param s - The wire finishReason, possibly undefined.
 * @returns The corresponding {@link StopReason}.
 */
export function normalizeFinishReason(s: string | undefined): StopReason {
  switch (s) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "refusal";
    case undefined:
    case "":
      return "" as StopReason;
    default:
      return s.toLowerCase() as StopReason;
  }
}

/**
 * Collapse a non-streaming Gemini {@link GenerateResponse} into a galdor
 * {@link Response}. The first candidate is used: its text parts become message
 * content, thought parts become thinking parts, and functionCall parts become
 * {@link ToolCall}s with synthesized IDs.
 *
 * @param r - The decoded response body.
 * @param raw - Optional raw response bytes, attached as {@code providerRaw} when present.
 * @returns The assembled galdor response.
 */
export function responseFromWire(r: GenerateResponse, raw?: Uint8Array): Response {
  const message: Message = { role: Role.Assistant, content: [] };
  let stopReason: StopReason = "" as StopReason;
  const toolCalls: ToolCall[] = [];

  const candidates = r.candidates ?? [];
  const c = candidates[0];
  if (c) {
    stopReason = normalizeFinishReason(c.finishReason);
    const parts = c.content?.parts ?? [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (p.functionCall) {
        toolCalls.push({
          id: synthToolID(p.functionCall.name, i),
          name: p.functionCall.name,
          arguments: p.functionCall.args ?? {},
        });
      } else if (p.thought && p.text) {
        // Thought summaries surface as a separate thinking part; messageText skips it.
        message.content.push(thinkingPart(p.text));
      } else if (p.text) {
        message.content.push(textPart(p.text));
      }
    }
  }

  if (toolCalls.length > 0) message.toolCalls = toolCalls;
  return {
    message,
    stopReason,
    usage: usageFromWire(r.usageMetadata),
    model: r.modelVersion ?? "",
    ...(raw !== undefined ? { providerRaw: raw } : {}),
  };
}
