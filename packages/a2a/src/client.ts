/**
 * A2A client speaking JSON-RPC 2.0 over HTTP to a single remote agent.
 *
 * Each {@link Client} instance issues auto-incrementing JSON-RPC ids that are
 * unique within that client. Response bodies are size-capped so a hostile
 * agent cannot exhaust memory with an oversized reply, every request is bound
 * by a default deadline, and redirects are confined to the original host so
 * card discovery cannot be turned into a server-side request forgery pivot.
 */

import { A2AError, AGENT_CARD_PATH, METHOD_TASKS_GET, METHOD_TASKS_SEND, RPCError } from "./types.ts";
import type { AgentCard, RPCResponse, Task, TaskMessage, TasksGetParams, TasksSendParams } from "./types.ts";

/**
 * Upper bound, in bytes, on how much of a remote agent's response is buffered
 * or decoded. A hostile or compromised agent could otherwise stream an
 * arbitrarily large body and exhaust client memory; 4 MiB is far larger than
 * any legitimate Agent Card or task reply needs.
 */
const MAX_RESPONSE_BYTES = 4 << 20;

/**
 * Default per-request deadline, in milliseconds. A request that has not
 * completed within this window is aborted. Callers can pass their own
 * {@link AbortSignal}; both bounds are honored together.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Maximum number of HTTP redirects followed for a single request before the
 * client gives up. Bounds the same-host redirect loop so a server cannot pin
 * the client in an endless redirect cycle.
 */
const MAX_REDIRECTS = 10;

/** HTTP status codes that request a redirect to the `Location` header. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Options for {@link Client.sendTask}. */
export interface SendOptions {
  /** Id of an existing task to continue (multi-turn conversation). */
  taskId?: string;
  /** Logical session id grouping related tasks together. */
  sessionId?: string;
  /** Metadata to attach to the task on the server. */
  metadata?: Record<string, unknown>;
  /** Abort signal to cancel the in-flight request. */
  signal?: AbortSignal;
}

/**
 * Client for one remote A2A agent, identified by its base URL.
 *
 * @example
 * const client = new Client("https://agent.example.com");
 * const task = await client.sendTask(userText("hello"));
 * console.log(task.status.state);
 */
export class Client {
  private readonly baseURL: string;
  private id = 0;

  /**
   * Overrides the default card-discovery URL ({@link AGENT_CARD_PATH} appended
   * to the base URL). Set this when the Agent Card is served from a different
   * host than the JSON-RPC endpoint.
   */
  agentCardURL?: string;

  /**
   * @param baseURL - The agent's base URL; any trailing slashes are stripped.
   */
  constructor(baseURL: string) {
    this.baseURL = baseURL.replace(/\/+$/, "");
  }

  /**
   * Fetches and parses the agent's card from the well-known path.
   *
   * @param signal - Optional abort signal, combined with the default deadline.
   * @returns The parsed {@link AgentCard}.
   * @throws {A2AError} On a non-2xx HTTP status, an oversized body, a
   * cross-host redirect, or invalid JSON.
   */
  async fetchAgentCard(signal?: AbortSignal): Promise<AgentCard> {
    const url = this.agentCardURL ?? this.baseURL + AGENT_CARD_PATH;
    const resp = await sameHostFetch(url, { method: "GET" }, signal);
    const raw = await readCapped(resp);
    if (resp.status < 200 || resp.status >= 300) {
      throw new A2AError(`a2a: agent card HTTP ${resp.status}: ${raw}`);
    }
    try {
      return JSON.parse(raw) as AgentCard;
    } catch (e) {
      throw new A2AError(`a2a: decode agent card: ${String(e)}`);
    }
  }

  /**
   * Posts a `tasks/send` request and returns the resulting task.
   *
   * When `opts.taskId` is omitted the server allocates a fresh id; reuse the
   * returned task's id on follow-up sends to continue a multi-turn
   * conversation.
   *
   * @param message - The user message to send; must contain at least one part.
   * @param opts - Optional task continuation, session, metadata and abort
   * controls.
   * @returns The task after the server has processed this turn.
   * @throws {A2AError} If the message has no parts, on a transport/decoding
   * failure, an oversized response, or a cross-host redirect.
   * @throws {RPCError} If the agent returns a JSON-RPC error envelope.
   * @example
   * const task = await client.sendTask(userText("hi"), { sessionId: "s1" });
   */
  async sendTask(message: TaskMessage, opts: SendOptions = {}): Promise<Task> {
    if (!message.parts || message.parts.length === 0) {
      throw new A2AError("a2a: sendTask: message has no parts");
    }
    const params: TasksSendParams = {
      message,
      ...(opts.taskId !== undefined ? { id: opts.taskId } : {}),
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
    };
    return this.call<Task>(METHOD_TASKS_SEND, params, opts.signal);
  }

  /**
   * Fetches the current state of a task by id.
   *
   * @param taskId - Id of the task to fetch; required.
   * @param historyLength - When greater than 0, truncates the returned message
   * log to the most-recent N messages.
   * @param signal - Optional abort signal, combined with the default deadline.
   * @returns The task's current {@link Task} snapshot.
   * @throws {A2AError} If `taskId` is empty, on a transport/decoding failure,
   * an oversized response, or a cross-host redirect.
   * @throws {RPCError} If the agent returns a JSON-RPC error (e.g. unknown id).
   */
  async getTask(taskId: string, historyLength = 0, signal?: AbortSignal): Promise<Task> {
    if (!taskId) {
      throw new A2AError("a2a: getTask: id is required");
    }
    const params: TasksGetParams = {
      id: taskId,
      ...(historyLength > 0 ? { historyLength } : {}),
    };
    return this.call<Task>(METHOD_TASKS_GET, params, signal);
  }

  /** Issues a JSON-RPC request and decodes the reply. */
  private async call<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    this.id += 1;
    const body = JSON.stringify({ jsonrpc: "2.0", id: this.id, method, params });
    const resp = await sameHostFetch(
      this.baseURL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body,
      },
      signal,
    );
    const raw = await readCapped(resp);
    if (resp.status < 200 || resp.status >= 300) {
      throw new A2AError(`a2a: HTTP ${resp.status}: ${raw}`);
    }
    let msg: RPCResponse;
    try {
      msg = JSON.parse(raw) as RPCResponse;
    } catch (e) {
      throw new A2AError(`a2a: decode response: ${String(e)}`);
    }
    if (msg.error) {
      throw new RPCError(msg.error.code, msg.error.message, msg.error.data);
    }
    return msg.result as T;
  }
}

/**
 * Issues a fetch that follows only same-host 3xx redirects and is bound by the
 * default deadline together with any caller-supplied signal.
 *
 * Redirects are resolved manually: a redirect whose target host differs from
 * the previous request's host is refused, so a semi-trusted discovery URL
 * cannot bounce the client onto an internal address (a 302 to 169.254.169.254
 * or localhost). Same-host redirects are followed, up to {@link MAX_REDIRECTS}.
 *
 * @param url - The initial request URL.
 * @param init - Request init, applied to every hop; `redirect` is forced to
 * `"manual"`.
 * @param signal - Optional caller signal, combined with the default deadline
 * via {@link AbortSignal.any}.
 * @returns The first non-redirect {@link Response}.
 * @throws {A2AError} On a cross-host redirect or after too many redirects.
 */
async function sameHostFetch(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let current = url;
  for (let hop = 0; ; hop++) {
    const resp = await fetch(current, { ...init, redirect: "manual", signal: combined });
    if (!REDIRECT_STATUSES.has(resp.status)) {
      return resp;
    }
    const location = resp.headers.get("location");
    if (location === null || location === "") {
      // A redirect status without a usable target: treat as final.
      return resp;
    }
    if (hop >= MAX_REDIRECTS) {
      throw new A2AError(`a2a: too many redirects (>${MAX_REDIRECTS})`);
    }
    const next = new URL(location, current);
    if (next.host !== new URL(current).host) {
      throw new A2AError(`a2a: refusing cross-host redirect to "${next.host}"`);
    }
    current = next.toString();
  }
}

/**
 * Reads a response body, counting bytes as they arrive and aborting once the
 * size cap is exceeded — so an oversized body is rejected without first being
 * fully buffered.
 *
 * @param resp - The response whose body to read.
 * @returns The decoded body text.
 * @throws {A2AError} If the body exceeds {@link MAX_RESPONSE_BYTES}.
 */
async function readCapped(resp: Response): Promise<string> {
  const stream = resp.body;
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
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new A2AError(`a2a: response exceeds ${MAX_RESPONSE_BYTES} bytes`);
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
