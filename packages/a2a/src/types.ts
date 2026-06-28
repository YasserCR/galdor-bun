/**
 * Wire types, constants, message helpers and errors for the Agent-to-Agent
 * (A2A) protocol carried as JSON-RPC 2.0 over HTTP.
 *
 * Field names are camelCase and serialize directly to the on-wire JSON. Data
 * shapes are plain interfaces; failures are represented as {@link Error}
 * subclasses ({@link A2AError}, {@link RPCError}).
 *
 * Scope notes for this implementation:
 *   - {@link TaskState} is the four-value pending|running|completed|failed
 *     lifecycle.
 *   - {@link TaskStatus} exposes an optional terminal `result` plus
 *     `errorCode`/`errorMessage` for failures.
 *   - A task's full message log lives in {@link Task.messages}.
 */

/**
 * Well-known location of an agent's card. The A2A spec mandates this exact
 * suffix; clients discover an agent at `<baseURL>/.well-known/agent.json`.
 */
export const AGENT_CARD_PATH = "/.well-known/agent.json";

/** A2A protocol revision this implementation targets. */
export const PROTOCOL_VERSION = "0.1";

/** JSON-RPC method name for creating or continuing a task. */
export const METHOD_TASKS_SEND = "tasks/send";
/** JSON-RPC method name for fetching a task's current state. */
export const METHOD_TASKS_GET = "tasks/get";

// JSON-RPC 2.0 standard error codes.
/** Malformed JSON in the request body. */
export const ERR_PARSE_ERROR = -32700;
/** Request envelope is not a valid JSON-RPC request. */
export const ERR_INVALID_REQUEST = -32600;
/** Requested method is not implemented. */
export const ERR_METHOD_NOT_FOUND = -32601;
/** Method params are missing or invalid. */
export const ERR_INVALID_PARAMS = -32602;
/** Unexpected server-side failure. */
export const ERR_INTERNAL_ERROR = -32603;
// A2A-specific error codes defined by the protocol.
/** No task exists for the supplied id. */
export const ERR_TASK_NOT_FOUND = -32001;
/** Task cannot accept the request in its current state (e.g. terminal). */
export const ERR_INVALID_TASK_STATE = -32002;

/** AgentProvider identifies the organization running the agent. */
export interface AgentProvider {
  organization: string;
  url: string;
}

/** AgentCapabilities advertises optional protocol features. */
export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
}

/** AgentSkill is one discrete capability the agent advertises. */
export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
}

/** AgentCard is the metadata document served at /.well-known/agent.json. */
export interface AgentCard {
  name: string;
  description?: string;
  url: string;
  version?: string;
  provider?: AgentProvider;
  capabilities: AgentCapabilities;
  skills: AgentSkill[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

/**
 * Part is one element of a message's content. The A2A spec defines "text",
 * "file" and "data" parts; only "text" is implemented. `type` is the
 * discriminator so future parts deserialize without breaking older readers.
 */
export interface Part {
  type: string;
  /** Text is set when type === "text". */
  text?: string;
  metadata?: Record<string, unknown>;
}

/** Role identifies who sent a message. */
export type Role = "user" | "agent";

/** TaskMessage is one turn in a task's message log. */
export interface TaskMessage {
  role: Role;
  parts: Part[];
}

/** TaskState is the discrete lifecycle state of a task. */
export type TaskState = "pending" | "running" | "completed" | "failed";

/** TaskStatus is the status block of a Task. */
export interface TaskStatus {
  state: TaskState;
  /** Optional terminal result payload set by a handler. */
  result?: string;
  /** Set with errorMessage when a handler fails. */
  errorCode?: number;
  errorMessage?: string;
}

/**
 * Task is the unit of work the protocol revolves around. Clients create one
 * with tasks/send; servers append messages and transition Status as they
 * process it; clients poll via tasks/get until the state is terminal.
 */
export interface Task {
  id: string;
  sessionId?: string;
  status: TaskStatus;
  /** The message log: the user turn(s) followed by agent turn(s). */
  messages: TaskMessage[];
  /** Optional alternate/truncated view (unused by this server). */
  history?: TaskMessage[];
  metadata?: Record<string, unknown>;
}

/**
 * Builds a text {@link Part} from a string.
 *
 * @param s - The text content.
 * @returns A part with `type` `"text"`.
 */
export function textPart(s: string): Part {
  return { type: "text", text: s };
}

/**
 * Builds a user-role {@link TaskMessage} carrying a single text part.
 *
 * @param s - The user's text.
 * @returns A message with role `"user"`.
 * @example
 * client.sendTask(userText("What is the weather?"));
 */
export function userText(s: string): TaskMessage {
  return { role: "user", parts: [textPart(s)] };
}

/**
 * Builds an agent-role {@link TaskMessage} carrying a single text part; the
 * agent-side counterpart of {@link userText}.
 *
 * @param s - The agent's text.
 * @returns A message with role `"agent"`.
 */
export function agentText(s: string): TaskMessage {
  return { role: "agent", parts: [textPart(s)] };
}

/**
 * Concatenates the text of every text part in a message, joined by newlines.
 * Non-text parts are skipped.
 *
 * @param m - The message to flatten.
 * @returns The combined text, or an empty string if the message has no text
 * parts.
 */
export function messageText(m: TaskMessage): string {
  let out = "";
  for (const p of m.parts) {
    if (p.type === "text") {
      if (out !== "") out += "\n";
      out += p.text ?? "";
    }
  }
  return out;
}

/**
 * Appends a message to a task's log, mutating the task in place.
 *
 * @param task - The task whose log to extend.
 * @param m - The message to append.
 */
export function appendMessage(task: Task, m: TaskMessage): void {
  task.messages.push(m);
}

/**
 * Reports whether a task state is terminal (no further work will occur).
 *
 * @param state - The state to test.
 * @returns `true` for `"completed"` or `"failed"`.
 */
export function isTerminalState(state: TaskState): boolean {
  return state === "completed" || state === "failed";
}

/** Base error for transport and protocol failures raised by this library. */
export class A2AError extends Error {
  override name = "A2AError";
}

/**
 * Error carrying a JSON-RPC error envelope returned by a remote agent.
 *
 * @example
 * try {
 *   await client.getTask("missing");
 * } catch (e) {
 *   if (e instanceof RPCError) console.error(e.code, e.message);
 * }
 */
export class RPCError extends A2AError {
  override name = "RPCError";
  /** The JSON-RPC numeric error code. */
  readonly code: number;
  /** Optional implementation-defined error detail. */
  readonly data?: unknown;
  /**
   * @param code - JSON-RPC error code.
   * @param message - Human-readable error message.
   * @param data - Optional structured error detail.
   */
  constructor(code: number, message: string, data?: unknown) {
    super(`a2a: JSON-RPC ${code}: ${message}`);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** JSON-RPC id: a number, string, or null. */
export type RPCId = number | string | null;

/** RPCRequest is an inbound JSON-RPC request envelope. */
export interface RPCRequest {
  jsonrpc: "2.0";
  id?: RPCId;
  method?: string;
  params?: unknown;
}

/** RPCErrorObject is the `error` member of a JSON-RPC response. */
export interface RPCErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** RPCResponse is an outbound JSON-RPC response envelope. */
export interface RPCResponse {
  jsonrpc: "2.0";
  id: RPCId;
  result?: unknown;
  error?: RPCErrorObject;
}

/** tasksSendParams is the params payload for `tasks/send`. */
export interface TasksSendParams {
  id?: string;
  sessionId?: string;
  message: TaskMessage;
  metadata?: Record<string, unknown>;
}

/** tasksGetParams is the params payload for `tasks/get`. */
export interface TasksGetParams {
  id: string;
  historyLength?: number;
}
