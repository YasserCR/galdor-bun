/**
 * @galdor/a2a — Agent-to-Agent (A2A) protocol over JSON-RPC 2.0 and HTTP.
 *
 * Expose an agent over HTTP with {@link newServer}, which returns a
 * Bun.serve-compatible fetch handler, and call a remote agent with
 * {@link Client}. Shared wire types, constants and helpers live alongside.
 */

export {
  AGENT_CARD_PATH,
  PROTOCOL_VERSION,
  METHOD_TASKS_SEND,
  METHOD_TASKS_GET,
  ERR_PARSE_ERROR,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_INVALID_PARAMS,
  ERR_INTERNAL_ERROR,
  ERR_TASK_NOT_FOUND,
  ERR_INVALID_TASK_STATE,
  textPart,
  userText,
  agentText,
  messageText,
  appendMessage,
  isTerminalState,
  A2AError,
  RPCError,
} from "./types.ts";
export type {
  AgentCard,
  AgentProvider,
  AgentCapabilities,
  AgentSkill,
  Part,
  Role,
  TaskMessage,
  TaskState,
  TaskStatus,
  Task,
  RPCId,
  RPCRequest,
  RPCResponse,
  RPCErrorObject,
  TasksSendParams,
  TasksGetParams,
} from "./types.ts";

export { Server, newServer, handlerFunc } from "./server.ts";
export type { Handler, HandlerFn } from "./server.ts";

export { Client } from "./client.ts";
export type { SendOptions } from "./client.ts";
