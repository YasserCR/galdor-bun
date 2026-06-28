/**
 * mcp/transports — the wire-level mediums MCP messages flow through.
 *
 * A {@link Transport} frames messages however its medium requires; the
 * {@link Client} and {@link Server} only ever exchange decoded JSON-RPC
 * messages via `send` / `receive`.
 *
 * Implementations here:
 *   - {@link InMemoryTransport} — a duplex in-process pair, for tests and for
 *     wiring a Client to a Server with no real I/O.
 *   - {@link StdioTransport} — newline-delimited JSON over Node `Readable` /
 *     `Writable` (what desktop clients speak to child-process servers).
 *   - {@link SSETransport} / {@link SSEClientTransport} — the HTTP+SSE transport
 *     from the 2024-11-05 spec (`GET /sse` + `POST /messages`).
 *   - {@link StreamableHTTPTransport} / {@link StreamableHTTPClientTransport} —
 *     the single-endpoint Streamable HTTP transport (`POST /`, session id on the
 *     `Mcp-Session-Id` header).
 *
 * A clean close surfaces as `receive` resolving to `null`. Cancellation is
 * expressed with an optional `AbortSignal` threaded through `send`/`receive`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Readable, Writable } from "node:stream";
import { type RpcMessage } from "./jsonrpc.ts";

/**
 * True when executing on Bun. The HTTP transports below use this to pick their
 * listener: `Bun.serve` on Bun, `node:http` on Node — both driving the exact
 * same runtime-agnostic `(req: Request) => Response` request handler.
 */
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * Caps the size of a single inbound JSON-RPC frame across every transport,
 * bounding the memory a peer can force us to allocate per message. 4 MiB is far
 * larger than any legitimate tool call yet small enough to stay cheap.
 */
export const maxMessageBytes = 4 << 20;

/**
 * The wire-level abstraction MCP messages flow through.
 *
 * Concurrency contract:
 *   - `send` is safe for concurrent use (frames are written atomically), so a
 *     Client can multiplex many in-flight requests.
 *   - `close` is safe to call any time, including concurrently with a blocked
 *     `receive` (it unblocks it).
 *   - `receive` is single-consumer: call it from one place at a time.
 */
export interface Transport {
  /** Serialize a message and write one frame to the peer. */
  send(msg: unknown, signal?: AbortSignal): Promise<void>;
  /**
   * Block until the next frame arrives and return it as a raw JSON string.
   * Resolves to `null` when the peer closes the medium cleanly.
   * Rejects with the signal's reason if `signal` aborts.
   */
  receive(signal?: AbortSignal): Promise<string | null>;
  /** Release medium-owned resources. Idempotent. */
  close(): void | Promise<void>;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("aborted", "AbortError");
}

/**
 * An unbounded single-consumer queue of string frames with `null`-on-close
 * semantics and `AbortSignal` support — the shared plumbing under every
 * transport's `receive`.
 */
export class FrameChannel {
  #queue: string[] = [];
  #resolvers: Array<(v: string | null) => void> = [];
  #closed = false;

  /** Enqueue a frame, waking the oldest waiter if one is parked. */
  send(frame: string): void {
    if (this.#closed) return;
    const r = this.#resolvers.shift();
    if (r) r(frame);
    else this.#queue.push(frame);
  }

  /** Pop the next frame, or `null` once closed and drained. */
  receive(signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#closed) return Promise.resolve(null);
    return new Promise<string | null>((resolve, reject) => {
      const resolver = (v: string | null): void => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onAbort = (): void => {
        const i = this.#resolvers.indexOf(resolver);
        if (i >= 0) this.#resolvers.splice(i, 1);
        reject(abortReason(signal as AbortSignal));
      };
      this.#resolvers.push(resolver);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Mark closed and wake every parked waiter with `null`. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const r of this.#resolvers.splice(0)) r(null);
  }

  get closed(): boolean {
    return this.#closed;
  }
}

/**
 * Bounds how many replies the Streamable HTTP client transport queues before
 * {@link StreamableHTTPClientTransport.send} applies backpressure. Sized above
 * the server's dispatch concurrency so an ordinary burst of concurrent calls
 * never stalls a send in practice.
 */
export const maxBufferedReplies = 64;

interface BoundedSender {
  frame: string;
  resolve: () => void;
  reject: (err: unknown) => void;
  detach: () => void;
}

/**
 * A bounded single-consumer queue of string frames with `null`-on-close
 * semantics. {@link BoundedFrameChannel.receive} pops the next frame (or `null`
 * once closed and drained); {@link BoundedFrameChannel.send} enqueues one,
 * blocking once `cap` frames are buffered until a receive frees a slot — the
 * backpressure that stops a fast producer from growing the queue without bound.
 * A blocked send can be abandoned via its {@link AbortSignal}.
 */
export class BoundedFrameChannel {
  readonly #queue: string[] = [];
  readonly #receivers: Array<(v: string | null) => void> = [];
  readonly #senders: BoundedSender[] = [];
  #closed = false;
  readonly #cap: number;

  constructor(cap: number) {
    this.#cap = cap;
  }

  /** Enqueue a frame, blocking (backpressure) once `cap` frames are buffered. */
  send(frame: string, signal?: AbortSignal): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("mcp: transport closed"));
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    // A parked receiver takes the frame directly — no buffering needed.
    const r = this.#receivers.shift();
    if (r) {
      r(frame);
      return Promise.resolve();
    }
    if (this.#queue.length < this.#cap) {
      this.#queue.push(frame);
      return Promise.resolve();
    }
    // Full: park the sender until a receive frees a slot (or close / abort).
    return new Promise<void>((resolve, reject) => {
      const sender: BoundedSender = {
        frame,
        resolve,
        reject,
        detach: () => {
          if (signal) signal.removeEventListener("abort", onAbort);
        },
      };
      const onAbort = (): void => {
        const i = this.#senders.indexOf(sender);
        if (i >= 0) this.#senders.splice(i, 1);
        reject(abortReason(signal as AbortSignal));
      };
      this.#senders.push(sender);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Pop the next frame, or `null` once closed and drained. */
  receive(signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      // A freed slot lets the oldest parked sender enqueue and unblock.
      const s = this.#senders.shift();
      if (s) {
        this.#queue.push(s.frame);
        s.detach();
        s.resolve();
      }
      return Promise.resolve(queued);
    }
    if (this.#closed) return Promise.resolve(null);
    return new Promise<string | null>((resolve, reject) => {
      const resolver = (v: string | null): void => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onAbort = (): void => {
        const i = this.#receivers.indexOf(resolver);
        if (i >= 0) this.#receivers.splice(i, 1);
        reject(abortReason(signal as AbortSignal));
      };
      this.#receivers.push(resolver);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Mark closed: wake parked receivers with `null` and fail parked senders. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const r of this.#receivers.splice(0)) r(null);
    for (const s of this.#senders.splice(0)) {
      s.detach();
      s.reject(new Error("mcp: transport closed"));
    }
  }

  get closed(): boolean {
    return this.#closed;
  }
}

const bodyDecoder = new TextDecoder();

/** Concatenate byte chunks and decode them as UTF-8. */
function decodeChunks(chunks: Uint8Array[], total: number): string {
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return bodyDecoder.decode(merged);
}

/**
 * Read an HTTP request body, enforcing a byte cap as it streams. The body is
 * rejected up front when its declared `Content-Length` already exceeds `cap`,
 * and again mid-read the instant the cumulative byte count crosses `cap` — so an
 * oversized (or length-lying) body is never buffered in full. Returns the
 * decoded text, or `null` when the cap is exceeded.
 */
async function readBodyWithCap(req: Request, cap: number): Promise<string | null> {
  const declared = req.headers.get("Content-Length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > cap) return null;
  }
  const body = req.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return decodeChunks(chunks, total);
}

/**
 * Read at most `cap` bytes from a response body and decode them, silently
 * truncating anything beyond the cap so a hostile or runaway server cannot force
 * unbounded buffering on the client. A null body decodes to "".
 */
async function readLimitedText(body: ReadableStream<Uint8Array> | null, cap: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    let chunk = value;
    if (total + chunk.byteLength > cap) chunk = chunk.subarray(0, cap - total);
    if (chunk.byteLength > 0) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    if (total >= cap) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return decodeChunks(chunks, total);
}

const frameByteEncoder = new TextEncoder();

/**
 * UTF-8 byte length of `s`. A string already longer than the cap (in UTF-16
 * code units, a lower bound on its byte length) is reported without encoding,
 * keeping the over-budget check from materializing a huge byte array.
 */
function frameByteLength(s: string): number {
  if (s.length > maxMessageBytes) return s.length;
  return frameByteEncoder.encode(s).length;
}

/** A random hex string used as an opaque session id (128 bits of entropy). */
export function newSessionID(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

// ── In-memory transport ─────────────────────────────────────────────────────

/**
 * One end of an in-process duplex pair: `send` pushes onto the outbound
 * channel, `receive` pops from the inbound one. Closing either end closes both
 * channels so the peer's `receive` sees EOF.
 */
export class InMemoryTransport implements Transport {
  readonly #out: FrameChannel;
  readonly #in: FrameChannel;
  #closed = false;

  constructor(outbound: FrameChannel, inbound: FrameChannel) {
    this.#out = outbound;
    this.#in = inbound;
  }

  async send(msg: unknown): Promise<void> {
    if (this.#closed || this.#out.closed) throw new Error("mcp: transport closed");
    this.#out.send(JSON.stringify(msg));
  }

  receive(signal?: AbortSignal): Promise<string | null> {
    return this.#in.receive(signal);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#out.close();
    this.#in.close();
  }
}

/**
 * Build a connected pair of in-memory transports. Hand the first to a
 * {@link Client} and the second to a {@link Server} (or vice versa) to wire
 * them together with no real I/O.
 *
 * @returns A two-element tuple of mutually connected {@link Transport}s.
 * @example
 * const [clientT, serverT] = inMemoryTransportPair();
 * void server.serve(serverT);
 * const client = new Client(clientT);
 */
export function inMemoryTransportPair(): [Transport, Transport] {
  const a = new FrameChannel(); // first -> second
  const b = new FrameChannel(); // second -> first
  return [new InMemoryTransport(a, b), new InMemoryTransport(b, a)];
}

// ── Stdio transport ──────────────────────────────────────────────────────────

/**
 * Reads newline-delimited JSON from `readable` and writes newline-delimited
 * JSON to `writable`. This is the transport desktop clients and IDE plugins
 * speak when they launch an MCP server as a child process.
 */
export class StdioTransport implements Transport {
  readonly #writable: Writable;
  readonly #frames = new FrameChannel();
  #acc = "";
  #closed = false;

  constructor(readable: Readable, writable: Writable) {
    this.#writable = writable;
    readable.on("data", (chunk: Buffer | string) => this.#onData(chunk));
    readable.on("end", () => this.#frames.close());
    readable.on("error", () => this.#frames.close());
  }

  #onData(chunk: Buffer | string): void {
    if (this.#closed || this.#frames.closed) return;
    this.#acc += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = this.#acc.indexOf("\n")) >= 0) {
      let line = this.#acc.slice(0, idx);
      this.#acc = this.#acc.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      // A single frame past the cap: refuse it and terminate the stream rather
      // than emit an over-budget message. Checked before the frame is queued.
      if (frameByteLength(line) > maxMessageBytes) {
        this.#terminate();
        return;
      }
      if (line.length === 0) continue; // skip blank lines
      this.#frames.send(line);
    }
    // An unterminated remainder already past the cap can never become a legal
    // frame: terminate instead of buffering unbounded memory.
    if (frameByteLength(this.#acc) > maxMessageBytes) {
      this.#terminate();
    }
  }

  /** Drop the buffer and close the receive side, ending the stream. */
  #terminate(): void {
    this.#acc = "";
    this.#frames.close();
  }

  send(msg: unknown): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("mcp: transport closed"));
    const frame = `${JSON.stringify(msg)}\n`;
    return new Promise<void>((resolve, reject) => {
      this.#writable.write(frame, (err) => (err ? reject(err) : resolve()));
    });
  }

  receive(signal?: AbortSignal): Promise<string | null> {
    return this.#frames.receive(signal);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#frames.close();
    this.#writable.end();
  }
}

// ── Origin guard (shared by the HTTP transports) ─────────────────────────────

/**
 * Implements the spec's DNS-rebinding protection: a browser includes an Origin
 * header on cross-site fetches, so a request whose Origin resolves to anything
 * other than loopback is rejected. Requests with no Origin (ordinary non-browser
 * MCP clients) are allowed.
 */
export function originAllowed(req: Request): boolean {
  const o = req.headers.get("Origin");
  if (!o) return true;
  let host: string;
  try {
    host = new URL(o).hostname;
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return true;
  }
  return false;
}

// ── HTTP listener adapter (Bun.serve / node:http) ────────────────────────────

/**
 * A runtime-agnostic request handler: the unit of behavior every HTTP transport
 * implements, oblivious to whether `Bun.serve` or `node:http` is driving it.
 */
type FetchHandler = (req: Request) => Response | Promise<Response>;

/** A started HTTP listener, exposing its bound port and a forceful stop. */
interface HttpServerHandle {
  readonly port: number;
  /**
   * Resolves once the listener is accepting connections. Await it before reading
   * {@link HttpServerHandle.port} (or a URL derived from it) when an ephemeral
   * port (`0`) was requested, since some runtimes bind asynchronously.
   */
  readonly ready: Promise<void>;
  stop(): void;
}

/**
 * Idle/header timeout (seconds) applied to inbound connections, bounding how
 * long a slow client may dribble a request before its socket is reclaimed — a
 * slowloris guard. Transports owning long-lived response streams (SSE) pass `0`
 * to opt out, since their connections are deliberately idle for long stretches.
 */
const headerIdleTimeoutSeconds = 10;

/**
 * Start an HTTP listener on `port` (0 = OS-assigned) driving `handler`. On Bun
 * this is `Bun.serve`; on Node it is a `node:http` server adapting each
 * `IncomingMessage` into a web {@link Request} and streaming the {@link Response}
 * back out (so a long-lived SSE body flows chunk by chunk).
 *
 * `idleTimeout` (seconds, default {@link headerIdleTimeoutSeconds}) caps how long
 * a connection may sit idle on Bun; `0` disables it for long-lived streams.
 */
function serveHttp(
  port: number,
  handler: FetchHandler,
  idleTimeout = headerIdleTimeoutSeconds,
): HttpServerHandle {
  if (isBun) {
    // Bun.serve binds synchronously, so the port is known at once.
    const server = Bun.serve({ port, idleTimeout, fetch: handler });
    return {
      get port(): number {
        return server.port ?? 0;
      },
      ready: Promise.resolve(),
      stop(): void {
        (server.stop as (force?: boolean) => void)(true);
      },
    };
  }
  return serveHttpNode(port, handler);
}

/** The `node:http` arm of {@link serveHttp}. */
function serveHttpNode(port: number, handler: FetchHandler): HttpServerHandle {
  const server = createServer((nodeReq, nodeRes) => {
    void driveNodeRequest(nodeReq, nodeRes, handler);
  });
  // Slowloris guard: cap the time allowed to receive a request's headers. This
  // governs only the header phase, so it never disturbs an established
  // long-lived SSE response body.
  server.headersTimeout = headerIdleTimeoutSeconds * 1000;
  // node:http binds asynchronously: server.address() is null until the
  // "listening" event. Seed boundPort with the requested port so a FIXED port is
  // correct immediately, and refine it (for an ephemeral 0) once listening. Expose
  // `ready` so callers can await the OS-assigned port for the ephemeral case.
  let boundPort = port;
  const ready = new Promise<void>((resolve) => {
    server.once("listening", () => {
      boundPort = (server.address() as AddressInfo | null)?.port ?? boundPort;
      resolve();
    });
  });
  server.listen(port);
  return {
    get port(): number {
      return boundPort;
    },
    ready,
    stop(): void {
      // Sever any keep-alive/SSE sockets so the listener actually closes.
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close();
    },
  };
}

/** Run `handler` for one Node request and pump its response back. */
async function driveNodeRequest(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  handler: FetchHandler,
): Promise<void> {
  try {
    const res = await handler(await nodeRequestToWeb(nodeReq));
    await writeWebResponse(res, nodeReq, nodeRes);
  } catch (err) {
    if (!nodeRes.headersSent) nodeRes.writeHead(500);
    nodeRes.end(`internal error: ${String(err)}`);
  }
}

/** Adapt a Node `IncomingMessage` into a web {@link Request}. */
async function nodeRequestToWeb(nodeReq: IncomingMessage): Promise<Request> {
  const host = nodeReq.headers.host ?? "localhost";
  const url = `http://${host}${nodeReq.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeReq.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  const method = nodeReq.method ?? "GET";
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") init.body = await readNodeBody(nodeReq);
  return new Request(url, init);
}

/** Buffer a Node request body into a single byte array. */
function readNodeBody(nodeReq: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    nodeReq.on("data", (chunk: Buffer) => chunks.push(chunk));
    nodeReq.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    nodeReq.on("error", reject);
  });
}

/**
 * Stream a web {@link Response} out through a Node `ServerResponse`. The body is
 * read incrementally rather than buffered, so an open-ended SSE stream is
 * forwarded frame by frame; a client disconnect cancels the reader, which fires
 * the stream's `cancel` callback (releasing the SSE session).
 */
async function writeWebResponse(
  res: Response,
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
): Promise<void> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  nodeRes.writeHead(res.status, headers);
  if (!res.body) {
    nodeRes.end();
    return;
  }
  const reader = res.body.getReader();
  const onClose = (): void => void reader.cancel();
  nodeReq.on("close", onClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) nodeRes.write(value);
    }
  } catch {
    // Reader was cancelled (client gone) or the source stream errored.
  } finally {
    nodeReq.off("close", onClose);
    nodeRes.end();
  }
}

// ── SSE transport (server side) ──────────────────────────────────────────────

interface SseSession {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
}

/**
 * Runs a `Bun.serve` HTTP server speaking the MCP "HTTP+SSE" transport. Two
 * routes are mounted:
 *   - `GET  /sse`      — clients open a Server-Sent Events stream. The first
 *     event is `endpoint`, whose data is the URL to POST requests to.
 *   - `POST /messages` — clients POST JSON-RPC requests (acknowledged 202); the
 *     reply is pushed back down the SSE stream as a `message` event.
 *
 * One instance owns one listener and surfaces the active session to the host
 * loop. A new GET stream supersedes the previous one.
 */
export class SSETransport implements Transport {
  readonly #server: HttpServerHandle;
  readonly #incoming = new FrameChannel();
  readonly #encoder = new TextEncoder();
  #session: SseSession | null = null;
  #closed = false;

  constructor(port = 0) {
    // SSE holds the GET stream open indefinitely, so opt out of the Bun idle
    // timeout (0); the Node listener still applies a header-phase timeout, which
    // a long-lived response body is unaffected by.
    this.#server = serveHttp(port, (req) => this.#handle(req), 0);
  }

  /** The OS-assigned port (useful when constructed with port 0). */
  get port(): number {
    return this.#server.port;
  }

  /** Resolves once the listener is accepting connections (await before reading {@link url} with an ephemeral port). */
  get ready(): Promise<void> {
    return this.#server.ready;
  }

  /** The base URL a client transport should dial. Await {@link ready} first when constructed with port `0`. */
  get url(): string {
    return `http://localhost:${this.port}`;
  }

  #handle(req: Request): Response | Promise<Response> {
    if (!originAllowed(req)) return new Response("forbidden origin", { status: 403 });
    const url = new URL(req.url);
    if (url.pathname === "/sse" && req.method === "GET") return this.#handleSSE();
    if (url.pathname === "/messages" && req.method === "POST") return this.#handlePost(req, url);
    return new Response("not found", { status: 404 });
  }

  #handleSSE(): Response {
    const id = newSessionID();
    let session!: SseSession;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        session = { id, controller, closed: false };
        const endpoint = `/messages?sessionId=${id}`;
        controller.enqueue(this.#encoder.encode(`event: endpoint\ndata: ${endpoint}\n\n`));
      },
      cancel: () => {
        session.closed = true;
        if (this.#session === session) this.#session = null;
      },
    });
    const prev = this.#session;
    this.#session = session;
    if (prev) this.#closeSession(prev);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  async #handlePost(req: Request, url: URL): Promise<Response> {
    const sid = url.searchParams.get("sessionId");
    const sess = this.#session;
    if (!sess || !sid || sid !== sess.id) {
      return new Response("missing or unknown session id", { status: 404 });
    }
    const body = await readBodyWithCap(req, maxMessageBytes);
    if (body === null) return new Response("frame too large", { status: 413 });
    this.#incoming.send(body);
    return new Response(null, { status: 202 });
  }

  #closeSession(sess: SseSession): void {
    if (sess.closed) return;
    sess.closed = true;
    try {
      sess.controller.close();
    } catch {
      // stream already torn down by the peer disconnecting
    }
  }

  async send(msg: unknown): Promise<void> {
    if (this.#closed) throw new Error("mcp: transport closed");
    const sess = this.#session;
    if (!sess) throw new Error("mcp: sse: no active session");
    if (sess.closed) throw new Error("mcp: sse: session closed");
    sess.controller.enqueue(this.#encoder.encode(`event: message\ndata: ${JSON.stringify(msg)}\n\n`));
  }

  receive(signal?: AbortSignal): Promise<string | null> {
    return this.#incoming.receive(signal);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#session) {
      this.#closeSession(this.#session);
      this.#session = null;
    }
    this.#incoming.close();
    this.#server.stop();
  }
}

/** Returns the bound address of an {@link SSETransport}, or null otherwise. */
export function sseTransportAddr(t: Transport): string | null {
  return t instanceof SSETransport ? t.url : null;
}

// ── SSE transport (client side) ──────────────────────────────────────────────

/** The slice of the `EventSource` web API this transport uses. */
interface EventSourceLike {
  addEventListener(type: string, listener: (e: { data?: unknown }) => void): void;
  close(): void;
}

function openEventSource(url: string): EventSourceLike {
  const ctor = (globalThis as { EventSource?: new (u: string) => EventSourceLike }).EventSource;
  if (ctor) return new ctor(url);
  return new FetchEventSource(url);
}

/**
 * A `fetch`-based stand-in for the `EventSource` web API, for runtimes (such as
 * a bare Node) that ship no global `EventSource`. It opens the stream with
 * `fetch`, reads the response body, and parses the Server-Sent Events wire
 * format into `event`/`data` frames, dispatching them to listeners registered
 * with {@link addEventListener} — the small slice {@link SSEClientTransport}
 * relies on. Only the fields this transport needs (`event`, `data`) are
 * honored; `id`/`retry`/reconnection are intentionally omitted.
 */
class FetchEventSource implements EventSourceLike {
  readonly #listeners = new Map<string, Array<(e: { data?: unknown }) => void>>();
  readonly #controller = new AbortController();
  #closed = false;

  // SSE frame-parser state: the current event's `event:` name and `data:` lines.
  #buf = "";
  #eventType = "message";
  #dataLines: string[] = [];

  constructor(url: string) {
    // Deferred to a microtask via the fetch promise, so the constructing
    // transport can register its listeners synchronously before any frame lands.
    void this.#run(url);
  }

  addEventListener(type: string, listener: (e: { data?: unknown }) => void): void {
    const arr = this.#listeners.get(type);
    if (arr) arr.push(listener);
    else this.#listeners.set(type, [listener]);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort();
  }

  #emit(type: string, data?: string): void {
    const arr = this.#listeners.get(type);
    if (!arr) return;
    for (const l of arr) l({ data });
  }

  async #run(url: string): Promise<void> {
    try {
      const res = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        signal: this.#controller.signal,
      });
      if (!res.ok || !res.body) {
        if (!this.#closed) this.#emit("error");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.#feed(decoder.decode(value, { stream: true }));
      }
      if (!this.#closed) this.#emit("error"); // stream ended without an explicit close
    } catch {
      if (!this.#closed) this.#emit("error");
    }
  }

  /** Buffer incoming text and cut it into complete (CR?LF-terminated) lines. */
  #feed(text: string): void {
    this.#buf += text;
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      let line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#onLine(line);
    }
  }

  /** Apply one SSE line: a blank line dispatches the accumulated event. */
  #onLine(line: string): void {
    if (line === "") {
      if (this.#dataLines.length > 0) this.#emit(this.#eventType, this.#dataLines.join("\n"));
      this.#eventType = "message";
      this.#dataLines = [];
      return;
    }
    if (line.startsWith(":")) return; // comment line
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.#eventType = value;
    else if (field === "data") this.#dataLines.push(value);
    // `id`, `retry`, and any unknown field are ignored.
  }
}

/**
 * Dials an {@link SSETransport}. Opens the `GET /sse` stream, learns the POST
 * endpoint from the first `endpoint` event, POSTs each outbound frame there, and
 * queues inbound `message` events for `receive`.
 */
export class SSEClientTransport implements Transport {
  readonly #base: string;
  readonly #es: EventSourceLike;
  readonly #frames = new FrameChannel();
  #endpoint: string | null = null;
  readonly #endpointReady: Promise<void>;
  #closed = false;

  constructor(baseURL: string) {
    this.#base = baseURL.replace(/\/$/, "");
    let resolveReady!: () => void;
    let rejectReady!: (e: unknown) => void;
    this.#endpointReady = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    this.#es = openEventSource(`${this.#base}/sse`);
    this.#es.addEventListener("endpoint", (e) => {
      this.#endpoint = String(e.data ?? "");
      resolveReady();
    });
    this.#es.addEventListener("message", (e) => {
      this.#frames.send(String(e.data ?? ""));
    });
    this.#es.addEventListener("error", () => {
      if (!this.#endpoint) rejectReady(new Error("mcp: sse: stream failed before endpoint"));
    });
  }

  async send(msg: unknown): Promise<void> {
    if (this.#closed) throw new Error("mcp: transport closed");
    await this.#endpointReady;
    const ep = this.#endpoint as string;
    const url = ep.startsWith("http") ? ep : `${this.#base}${ep}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
    if (!res.ok) {
      const text = (await res.text()).trim();
      throw new Error(`mcp: server returned HTTP ${res.status}: ${text || res.statusText}`);
    }
  }

  receive(signal?: AbortSignal): Promise<string | null> {
    return this.#frames.receive(signal);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#es.close();
    this.#frames.close();
  }
}

// ── Streamable HTTP transport (server side) ──────────────────────────────────

interface PendingHttp {
  resolve: (reply: string) => void;
  reject: (err: unknown) => void;
}

/**
 * Runs a `Bun.serve` HTTP server speaking the MCP "Streamable HTTP" transport.
 * One endpoint is mounted:
 *   - `POST /` — clients POST JSON-RPC requests; the matching JSON-RPC response
 *     comes back as a single `application/json` body.
 *
 * The session id rides on the `Mcp-Session-Id` header: assigned on the response
 * to `initialize` and echoed by the client on every subsequent request. Replies
 * are correlated to the waiting POST handler by JSON-RPC id, so overlapping
 * same-session requests can be in flight at once.
 */
export class StreamableHTTPTransport implements Transport {
  readonly #server: HttpServerHandle;
  readonly #incoming = new FrameChannel();
  readonly #pending = new Map<string, PendingHttp>();
  #sessionID = "";
  #closed = false;

  constructor(port = 0) {
    this.#server = serveHttp(port, (req) => this.#handle(req));
  }

  /** The OS-assigned port (useful when constructed with port 0). */
  get port(): number {
    return this.#server.port;
  }

  /** Resolves once the listener is accepting connections (await before reading {@link url} with an ephemeral port). */
  get ready(): Promise<void> {
    return this.#server.ready;
  }

  /** The base URL a client transport should dial. Await {@link ready} first when constructed with port `0`. */
  get url(): string {
    return `http://localhost:${this.port}`;
  }

  async #handle(req: Request): Promise<Response> {
    if (!originAllowed(req)) return new Response("forbidden origin", { status: 403 });
    switch (req.method) {
      case "POST":
        return this.#handlePost(req);
      case "DELETE": {
        const sid = req.headers.get("Mcp-Session-Id");
        if (sid && sid === this.#sessionID) this.#sessionID = "";
        return new Response(null, { status: 204 });
      }
      default:
        return new Response("method not allowed", { status: 405 });
    }
  }

  async #handlePost(req: Request): Promise<Response> {
    const body = await readBodyWithCap(req, maxMessageBytes);
    if (body === null) return new Response("frame too large", { status: 413 });

    let probe: RpcMessage;
    try {
      probe = JSON.parse(body) as RpcMessage;
    } catch (err) {
      return new Response(`parse JSON-RPC: ${String(err)}`, { status: 400 });
    }

    const sid = req.headers.get("Mcp-Session-Id");
    if (this.#sessionID && probe.method !== "initialize" && sid !== this.#sessionID) {
      return new Response("missing or unknown session id", { status: 404 });
    }

    const isNotification = probe.id === undefined || probe.id === null;
    if (isNotification) {
      this.#incoming.send(body);
      return new Response(null, { status: 202 });
    }

    const key = JSON.stringify(probe.id);
    if (this.#pending.has(key)) {
      return new Response("duplicate in-flight request id", { status: 409 });
    }

    const reply = await new Promise<string | null>((resolve) => {
      this.#pending.set(key, {
        resolve: (r) => resolve(r),
        reject: () => resolve(null),
      });
      this.#incoming.send(body);
    });

    if (reply === null) return new Response("transport closed", { status: 503 });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (probe.method === "initialize") {
      if (!this.#sessionID) this.#sessionID = newSessionID();
      headers["Mcp-Session-Id"] = this.#sessionID;
    }
    return new Response(reply, { status: 200, headers });
  }

  async send(msg: unknown): Promise<void> {
    if (this.#closed) throw new Error("mcp: transport closed");
    const buf = JSON.stringify(msg);
    const id = (msg as { id?: unknown }).id;
    if (id === undefined || id === null) return; // notification reply: no waiter
    const key = JSON.stringify(id);
    const waiter = this.#pending.get(key);
    if (!waiter) return; // request already gave up
    this.#pending.delete(key);
    waiter.resolve(buf);
  }

  receive(signal?: AbortSignal): Promise<string | null> {
    return this.#incoming.receive(signal);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const w of this.#pending.values()) w.reject(new Error("mcp: transport closed"));
    this.#pending.clear();
    this.#incoming.close();
    this.#server.stop();
  }
}

/** Returns the bound address of a {@link StreamableHTTPTransport}, else null. */
export function streamableHTTPTransportAddr(t: Transport): string | null {
  return t instanceof StreamableHTTPTransport ? t.url : null;
}

// ── Streamable HTTP transport (client side) ──────────────────────────────────

/**
 * Strips a leading SSE `data:` framing if a server wraps the JSON-RPC reply in
 * an event stream. This package's own server replies with a bare
 * `application/json` body, so this is a defensive accommodation for other
 * spec-compliant peers.
 */
function normalizeReplyBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("data:")) return trimmed;
  let out = "";
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (l.startsWith("data:")) out += l.slice("data:".length).trim();
  }
  return out;
}

/**
 * Dials a Streamable HTTP MCP server. Each outbound frame is POSTed; the reply
 * body (if any) is queued for the next `receive`. The `Mcp-Session-Id` the
 * server mints on the initialize response is captured and echoed on every later
 * request. A request/response client: it does not handle server-initiated
 * requests.
 */
export class StreamableHTTPClientTransport implements Transport {
  readonly #url: string;
  // Bounded so a burst of concurrent replies applies backpressure on send rather
  // than growing the queue without bound; the dispatch loop drains it.
  readonly #replies = new BoundedFrameChannel(maxBufferedReplies);
  #sessionID = "";
  #closed = false;

  private constructor(url: string) {
    this.#url = url;
  }

  /** Validate `rawURL` (absolute http/https) and construct the transport. */
  static create(rawURL: string): StreamableHTTPClientTransport {
    let u: URL;
    try {
      u = new URL(rawURL);
    } catch (err) {
      throw new Error(`mcp: parse url: ${String(err)}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`mcp: url scheme must be http or https, got ${JSON.stringify(u.protocol)}`);
    }
    if (!u.host) throw new Error(`mcp: url has no host: ${JSON.stringify(rawURL)}`);
    return new StreamableHTTPClientTransport(rawURL);
  }

  async send(msg: unknown, signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw new Error("mcp: transport closed");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.#sessionID) headers["Mcp-Session-Id"] = this.#sessionID;

    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(msg),
    };
    if (signal) init.signal = signal;
    const res = await fetch(this.#url, init);

    const got = res.headers.get("Mcp-Session-Id");
    if (got && !this.#sessionID) this.#sessionID = got;

    // Cap the reply read so a runaway server can't force unbounded buffering.
    const raw = await readLimitedText(res.body, maxMessageBytes);
    if (!res.ok) {
      const m = raw.trim() || res.statusText;
      throw new Error(`mcp: server returned HTTP ${res.status}: ${m}`);
    }
    const reply = normalizeReplyBody(raw);
    if (reply.length === 0) return; // notification (202): nothing to deliver
    await this.#replies.send(reply, signal);
  }

  receive(signal?: AbortSignal): Promise<string | null> {
    return this.#replies.receive(signal);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#replies.close();
  }
}
