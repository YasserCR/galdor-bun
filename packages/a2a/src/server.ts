/**
 * The A2A HTTP surface as a Bun.serve-compatible fetch handler.
 *
 * Two routes are served:
 *   - GET  /.well-known/agent.json  → the Agent Card
 *   - POST <any other path>         → JSON-RPC (tasks/send, tasks/get)
 *
 * Tasks live in an in-memory store keyed by id. Sends targeting the same id are
 * serialized through a per-entry promise chain, while the task handler itself
 * runs without holding any data lock — so a concurrent `tasks/get` observes the
 * "running" state mid-flight. The single-threaded event loop keeps each
 * synchronous section atomic.
 */

import {
  AGENT_CARD_PATH,
  appendMessage,
  ERR_INTERNAL_ERROR,
  ERR_INVALID_PARAMS,
  ERR_INVALID_REQUEST,
  ERR_INVALID_TASK_STATE,
  ERR_METHOD_NOT_FOUND,
  ERR_PARSE_ERROR,
  ERR_TASK_NOT_FOUND,
  isTerminalState,
  METHOD_TASKS_GET,
  METHOD_TASKS_SEND,
} from "./types.ts";
import type {
  AgentCard,
  RPCErrorObject,
  RPCId,
  RPCRequest,
  RPCResponse,
  Task,
  TaskMessage,
  TasksGetParams,
  TasksSendParams,
} from "./types.ts";

/**
 * Processes a single task. The handler receives the task with the user's
 * incoming message already appended and is expected to mutate it in place:
 * append agent turns and set `status.state` to a terminal value. Throwing
 * transitions the task to `"failed"`, with the thrown message recorded in
 * `status.errorMessage`.
 */
export interface Handler {
  /**
   * @param task - The task to advance; mutate it in place.
   * @param signal - Aborts when the inbound request is cancelled.
   */
  handle(task: Task, signal?: AbortSignal): Promise<void>;
}

/** Plain-function form of a {@link Handler}. */
export type HandlerFn = (task: Task, signal?: AbortSignal) => Promise<void>;

/**
 * Adapts a plain function into a {@link Handler}.
 *
 * @param fn - The task-handling function.
 * @returns A {@link Handler} that delegates to `fn`.
 */
export function handlerFunc(fn: HandlerFn): Handler {
  return { handle: fn };
}

// Inbound-request and store limits. The server accepts unauthenticated input,
// so every growth vector is bounded.
const MAX_REQUEST_BYTES = 4 << 20; // 4 MiB
const MAX_TASK_ID_LEN = 512;
const DEFAULT_MAX_TASKS = 4096;

interface TaskEntry {
  task: Task;
  updated: number;
  /** Promise chain that serializes sends targeting this task id. */
  lock: Promise<void>;
}

/**
 * Exposes an agent over the A2A HTTP surface.
 *
 * Prefer {@link newServer} for construction. Wire {@link Server.fetch} into
 * Bun.serve to start listening.
 *
 * @example
 * const server = newServer(card, async (task) => {
 *   appendMessage(task, agentText("hi"));
 *   task.status.state = "completed";
 * });
 * Bun.serve({ port: 8080, fetch: server.fetch });
 */
export class Server {
  /** The Agent Card served verbatim at the well-known path. */
  readonly card: AgentCard;
  private readonly handler: Handler;
  /** Maximum number of tasks retained in the in-memory store. */
  maxTasks = DEFAULT_MAX_TASKS;
  private readonly tasks = new Map<string, TaskEntry>();

  /**
   * @param card - The Agent Card to advertise.
   * @param handler - The handler that processes each task.
   */
  constructor(card: AgentCard, handler: Handler) {
    this.card = card;
    this.handler = handler;
  }

  /**
   * Bun.serve-compatible request handler, pre-bound so it can be passed by
   * reference. Routes GETs of the well-known path to the Agent Card, POSTs to
   * the JSON-RPC dispatcher, and rejects other methods with HTTP 405.
   *
   * @param req - The incoming HTTP request.
   * @returns The HTTP response.
   */
  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === AGENT_CARD_PATH) {
      return this.serveAgentCard();
    }
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    return this.serveJSONRPC(req);
  };

  private serveAgentCard(): Response {
    return new Response(JSON.stringify(this.card), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  private async serveJSONRPC(req: Request): Promise<Response> {
    // Bound the body: an unauthenticated peer must not drive unbounded
    // allocation with a giant POST. Reject early on a declared Content-Length
    // over the cap, and otherwise count bytes as the body streams in so an
    // unsized body is also rejected once it crosses the cap.
    const declared = req.headers.get("content-length");
    if (declared !== null) {
      const n = Number(declared);
      if (Number.isFinite(n) && n > MAX_REQUEST_BYTES) {
        return jsonResponse(errorReply(null, ERR_PARSE_ERROR, "parse error", "request body too large"));
      }
    }
    const body = await readRequestCapped(req, MAX_REQUEST_BYTES);
    if (body === null) {
      return jsonResponse(errorReply(null, ERR_PARSE_ERROR, "parse error", "request body too large"));
    }
    let msg: RPCRequest;
    try {
      msg = JSON.parse(body) as RPCRequest;
    } catch (e) {
      return jsonResponse(errorReply(null, ERR_PARSE_ERROR, "parse error", String(e)));
    }
    const id = msg.id ?? null;
    if (msg.jsonrpc !== "2.0") {
      return jsonResponse(
        errorReply(id, ERR_INVALID_REQUEST, 'jsonrpc must be "2.0"', String(msg.jsonrpc)),
      );
    }
    let reply: RPCResponse;
    switch (msg.method) {
      case METHOD_TASKS_SEND:
        reply = await this.handleTasksSend(id, msg.params, req.signal);
        break;
      case METHOD_TASKS_GET:
        reply = this.handleTasksGet(id, msg.params);
        break;
      default:
        reply = errorReply(id, ERR_METHOD_NOT_FOUND, "method not found", String(msg.method));
    }
    return jsonResponse(reply);
  }

  private async handleTasksSend(
    id: RPCId,
    rawParams: unknown,
    signal: AbortSignal,
  ): Promise<RPCResponse> {
    const p = rawParams as TasksSendParams | undefined;
    if (!p || typeof p !== "object") {
      return errorReply(id, ERR_INVALID_PARAMS, "decode params", "");
    }
    const message = p.message as TaskMessage | undefined;
    if (!message || !Array.isArray(message.parts) || message.parts.length === 0) {
      return errorReply(id, ERR_INVALID_PARAMS, "message.parts is empty", "");
    }
    const reqID = p.id ?? "";
    if (reqID.length > MAX_TASK_ID_LEN) {
      return errorReply(id, ERR_INVALID_PARAMS, "id too long", "");
    }

    // Look up or create the entry. The synchronous section is atomic on the
    // event loop. An empty id always allocates a fresh uuid-keyed task.
    let entry = reqID !== "" ? this.tasks.get(reqID) : undefined;
    if (entry === undefined) {
      if (this.tasks.size >= this.maxTasks && !this.evictOne()) {
        return errorReply(id, ERR_INTERNAL_ERROR, "task store is full", "");
      }
      const newID = reqID !== "" ? reqID : crypto.randomUUID();
      const task: Task = {
        id: newID,
        status: { state: "pending" },
        messages: [],
        ...(p.sessionId !== undefined && p.sessionId !== "" ? { sessionId: p.sessionId } : {}),
        ...(p.metadata !== undefined ? { metadata: { ...p.metadata } } : {}),
      };
      entry = { task, updated: Date.now(), lock: Promise.resolve() };
      this.tasks.set(newID, entry);
    }

    // Serialize same-id sends: chain onto the entry's lock.
    const e = entry;
    const prev = e.lock;
    let release!: () => void;
    e.lock = new Promise<void>((res) => {
      release = res;
    });
    await prev;
    try {
      return await this.processSend(id, e, message, p, signal);
    } finally {
      release();
    }
  }

  private async processSend(
    id: RPCId,
    e: TaskEntry,
    message: TaskMessage,
    p: TasksSendParams,
    signal: AbortSignal,
  ): Promise<RPCResponse> {
    // Phase 1: reject a terminal task, append the user message, flip to
    // "running" and commit — so a concurrent tasks/get observes progress.
    if (isTerminalState(e.task.status.state)) {
      return errorReply(
        id,
        ERR_INVALID_TASK_STATE,
        "task is in a terminal state and cannot be continued",
        e.task.status.state,
      );
    }
    appendMessage(e.task, message);
    if (p.sessionId !== undefined && p.sessionId !== "") {
      e.task.sessionId = p.sessionId;
    }
    if (p.metadata !== undefined && Object.keys(p.metadata).length > 0) {
      e.task.metadata = { ...(e.task.metadata ?? {}), ...p.metadata };
    }
    e.task.status = { state: "running" };
    e.updated = Date.now();

    // Detach an independent copy for the handler so its mutations can't bleed
    // into the stored task until committed.
    const wc = structuredClone(e.task);

    // Phase 2: run the handler. No data lock is held across the await, so a
    // concurrent tasks/get returns the "running" snapshot promptly.
    try {
      await this.handler.handle(wc, signal);
    } catch (err) {
      wc.status = {
        state: "failed",
        errorCode: ERR_INTERNAL_ERROR,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    if (!isTerminalState(wc.status.state)) {
      // Handler returned cleanly but forgot to set a terminal state.
      wc.status = { ...wc.status, state: "completed" };
    }

    // Phase 3: commit the result and snapshot for the reply.
    e.task = wc;
    e.updated = Date.now();
    return successReply(id, structuredClone(wc));
  }

  private evictOne(): boolean {
    let oldestID = "";
    let oldest = Number.POSITIVE_INFINITY;
    for (const [tid, e] of this.tasks) {
      if (!isTerminalState(e.task.status.state)) continue;
      if (oldestID === "" || e.updated < oldest) {
        oldestID = tid;
        oldest = e.updated;
      }
    }
    if (oldestID === "") return false;
    this.tasks.delete(oldestID);
    return true;
  }

  private handleTasksGet(id: RPCId, rawParams: unknown): RPCResponse {
    const p = rawParams as TasksGetParams | undefined;
    if (!p || typeof p !== "object") {
      return errorReply(id, ERR_INVALID_PARAMS, "decode params", "");
    }
    if (!p.id) {
      return errorReply(id, ERR_INVALID_PARAMS, "id is required", "");
    }
    const e = this.tasks.get(p.id);
    if (e === undefined) {
      return errorReply(id, ERR_TASK_NOT_FOUND, "task not found", p.id);
    }
    const snap = structuredClone(e.task);
    if (
      p.historyLength !== undefined &&
      p.historyLength > 0 &&
      snap.messages.length > p.historyLength
    ) {
      snap.messages = snap.messages.slice(snap.messages.length - p.historyLength);
    }
    return successReply(id, snap);
  }
}

/**
 * Constructs a {@link Server}, accepting either a {@link Handler} object or a
 * plain {@link HandlerFn}. The card is served verbatim at the well-known path.
 *
 * @param card - The Agent Card to advertise.
 * @param handler - The task handler, as an object or a function.
 * @returns A ready-to-serve {@link Server}.
 */
export function newServer(card: AgentCard, handler: Handler | HandlerFn): Server {
  const h: Handler = typeof handler === "function" ? { handle: handler } : handler;
  return new Server(card, h);
}

/**
 * Reads a request body, counting bytes as they arrive and aborting once the
 * cap is exceeded — so an oversized body is rejected without first being fully
 * buffered.
 *
 * @param req - The incoming request.
 * @param cap - Maximum number of body bytes to accept.
 * @returns The decoded body text, or `null` if the body exceeds `cap`.
 */
async function readRequestCapped(req: Request, cap: number): Promise<string | null> {
  const stream = req.body;
  if (stream === null) {
    return "";
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

function successReply(id: RPCId, result: unknown): RPCResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorReply(id: RPCId, code: number, message: string, detail: string): RPCResponse {
  const error: RPCErrorObject =
    detail !== "" ? { code, message, data: { detail } } : { code, message };
  return { jsonrpc: "2.0", id: id ?? null, error };
}

function jsonResponse(msg: RPCResponse): Response {
  // JSON-RPC over HTTP always returns 200 even for protocol-level errors —
  // the error lives in the response envelope.
  return new Response(JSON.stringify(msg), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
