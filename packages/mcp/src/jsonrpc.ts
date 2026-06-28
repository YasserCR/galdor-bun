/**
 * mcp/jsonrpc — JSON-RPC 2.0 framing for the Model Context Protocol.
 *
 * These are the wire types every transport carries and both the {@link Client}
 * and {@link Server} speak. Field names are the exact JSON keys MCP requires
 * (`inputSchema`, `protocolVersion`, `clientInfo`, …) so an object can be
 * `JSON.stringify`d straight onto the wire.
 */

import type { JSONValue } from "@galdor/core/schema";

/**
 * The MCP revision negotiated in the initialize handshake. Pinned to the
 * published 2024-11-05 revision; servers reporting a newer version are still
 * accepted as long as the methods we use keep their shape.
 */
export const ProtocolVersion = "2024-11-05";

/**
 * The set of MCP revisions this server will negotiate. The server echoes the
 * client's requested version only when it appears here; otherwise it answers
 * with its own {@link ProtocolVersion}.
 */
export const supportedProtocolVersions: ReadonlySet<string> = new Set([ProtocolVersion]);

/** JSON-RPC 2.0 method names we implement. */
export const MethodInitialize = "initialize";
export const MethodInitialized = "notifications/initialized";
export const MethodToolsList = "tools/list";
export const MethodToolsCall = "tools/call";

/** JSON-RPC 2.0 standard error codes. */
export const ErrCodeParseError = -32700;
export const ErrCodeInvalidRequest = -32600;
export const ErrCodeMethodNotFound = -32601;
export const ErrCodeInvalidParams = -32602;
export const ErrCodeInternalError = -32603;

/** A JSON-RPC id: a number for our requests, null for unattributable errors. */
export type JsonId = string | number | null;

/** The JSON-RPC 2.0 error envelope. */
export interface RpcErrorBody {
  code: number;
  message: string;
  data?: JSONValue;
}

/**
 * The union of JSON-RPC request, response and notification shapes —
 * distinguishable by which fields are present. Every inbound frame decodes
 * into this type and is routed on the non-empty fields.
 */
export interface RpcMessage {
  jsonrpc: string;
  id?: JsonId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcErrorBody;
}

/** Thrown when a peer answers a request with a JSON-RPC error envelope. */
export class RpcError extends Error {
  override name = "RpcError";
  readonly code: number;
  readonly data?: JSONValue;
  constructor(body: RpcErrorBody) {
    super(`mcp: JSON-RPC ${body.code}: ${body.message}`);
    this.code = body.code;
    if (body.data !== undefined) this.data = body.data;
  }
}

/** Thrown when a `tools/call` result is flagged `isError`. */
export class ToolCallError extends Error {
  override name = "ToolCallError";
  readonly tool: string;
  constructor(tool: string, text: string) {
    super(`mcp: tool ${JSON.stringify(tool)} returned error: ${text}`);
    this.tool = tool;
  }
}

/** Identifies the calling application in the initialize request. */
export interface ClientInfo {
  name: string;
  version: string;
}

/** The server-side counterpart, returned in the initialize response. */
export interface ServerInfo {
  name: string;
  version: string;
}

/** Advertises which optional protocol features a side supports. */
export interface Capabilities {
  tools?: ToolsCapability;
}

/** Inner shape of {@link Capabilities.tools}. */
export interface ToolsCapability {
  listChanged?: boolean;
}

/** Params payload for the `initialize` method. */
export interface InitializeParams {
  protocolVersion: string;
  capabilities: Capabilities;
  clientInfo: ClientInfo;
}

/** Response payload for the `initialize` method. */
export interface InitializeResult {
  protocolVersion: string;
  capabilities: Capabilities;
  serverInfo: ServerInfo;
}

/**
 * The MCP-shape tool description. Conceptually identical to core's schema
 * `ToolDef` but with the JSON key layout MCP requires (`inputSchema`).
 */
export interface ToolDef {
  name: string;
  description?: string;
  inputSchema: JSONValue;
}

/** Response payload for `tools/list`. */
export interface ToolsListResult {
  tools: ToolDef[];
}

/** Params payload for `tools/call`. */
export interface ToolsCallParams {
  name: string;
  arguments?: JSONValue;
}

/**
 * One element of a tool-call result's content list. MCP defines several types
 * ("text", "image", "resource"); we only emit and consume "text".
 */
export interface ContentPart {
  type: string;
  text?: string;
}

/** Response payload for `tools/call`. */
export interface ToolsCallResult {
  content: ContentPart[];
  isError?: boolean;
}

/**
 * Builds a successful JSON-RPC 2.0 reply carrying `result`.
 *
 * @param id - The id echoed back from the request being answered.
 * @param result - The method's result payload.
 * @returns A well-formed {@link RpcMessage} ready to serialize.
 * @example
 * const reply = successReply(req.id ?? null, { tools });
 */
export function successReply(id: JsonId, result: unknown): RpcMessage {
  return { jsonrpc: "2.0", id, result };
}

/**
 * Builds a JSON-RPC 2.0 error reply.
 *
 * @param id - The request id; pass `undefined` (or `null`) when none can be
 *   recovered, in which case the reply carries `id: null`.
 * @param code - One of the JSON-RPC error codes, e.g. {@link ErrCodeInvalidParams}.
 * @param message - Short human-readable error summary.
 * @param detail - Optional extra context, attached under `error.data.detail`.
 * @returns A well-formed error {@link RpcMessage}.
 */
export function errorReply(
  id: JsonId | undefined,
  code: number,
  message: string,
  detail?: string,
): RpcMessage {
  const error: RpcErrorBody = detail
    ? { code, message, data: { detail } }
    : { code, message };
  return { jsonrpc: "2.0", id: id ?? null, error };
}

/**
 * Joins all "text" parts of a content list into a single string, newline-
 * separated. Non-text parts (e.g. "image", "resource") are skipped.
 *
 * @param parts - The `content` array from a {@link ToolsCallResult}.
 * @returns The concatenated text, or an empty string when there is none.
 */
export function concatText(parts: ContentPart[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) {
    const p = parts[0];
    return p && p.type === "text" ? (p.text ?? "") : "";
  }
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || p.type !== "text") continue;
    if (i > 0 && out !== "") out += "\n";
    out += p.text ?? "";
  }
  return out;
}
