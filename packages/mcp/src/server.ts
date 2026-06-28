/**
 * mcp/server — the MCP server.
 *
 * A {@link Server} exposes a core `Registry` over the MCP wire, serving one peer
 * at a time over the configured {@link Transport}. It handles the initialize
 * handshake, `tools/list` and `tools/call`; tool errors come back as a normal
 * result flagged `isError` (so a model can see them) rather than as
 * transport-level JSON-RPC errors.
 */

import type { Registry } from "@galdor/core/tool";
import type { RunContext } from "@galdor/core/provider";
import {
  type ContentPart,
  ErrCodeInternalError,
  ErrCodeInvalidParams,
  ErrCodeInvalidRequest,
  ErrCodeMethodNotFound,
  ErrCodeParseError,
  errorReply,
  type InitializeParams,
  MethodInitialize,
  MethodInitialized,
  MethodToolsCall,
  MethodToolsList,
  ProtocolVersion,
  type RpcMessage,
  type ServerInfo,
  successReply,
  supportedProtocolVersions,
  type ToolDef,
  type ToolsCallParams,
} from "./jsonrpc.ts";
import type { Transport } from "./transports.ts";

/**
 * Bounds how many requests a single {@link Server.serve} loop handles
 * concurrently, capping unbounded concurrent growth under a flood of frames.
 */
const maxConcurrentDispatch = 64;

/**
 * A counting semaphore. {@link Semaphore.acquire} resolves once a permit is
 * free, parking the caller behind any earlier waiters when none is;
 * {@link Semaphore.release} returns a permit, handing it straight to the oldest
 * parked waiter if one exists. A pending acquire can be abandoned via its
 * {@link AbortSignal}, in which case it resolves `false` without taking a permit.
 */
class Semaphore {
  #permits: number;
  readonly #waiters: Array<(ok: boolean) => void> = [];

  constructor(permits: number) {
    this.#permits = permits;
  }

  acquire(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (this.#permits > 0) {
      this.#permits--;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter = (ok: boolean): void => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const onAbort = (): void => {
        const i = this.#waiters.indexOf(waiter);
        if (i >= 0) this.#waiters.splice(i, 1);
        resolve(false);
      };
      this.#waiters.push(waiter);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  release(): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(true);
    else this.#permits++;
  }
}

/**
 * An MCP server that publishes a tool registry to a connected peer.
 *
 * Construct it with the registry to expose and the identity to advertise, then
 * call {@link Server.serve} with a {@link Transport} to handle frames until the
 * peer disconnects.
 *
 * @example
 * const server = new Server(registry, { name: "my-server", version: "1.0" });
 * const [clientT, serverT] = inMemoryTransportPair();
 * await server.serve(serverT);
 */
export class Server {
  readonly #reg: Registry;
  readonly #info: ServerInfo;

  /**
   * When true, rejects requests received before the initialize handshake
   * completes. Most clients send initialize first anyway; turning this on
   * catches misbehaving clients early.
   */
  strict = false;

  /**
   * @param reg - The tool registry whose tools are exposed to peers.
   * @param info - Server name/version advertised in the initialize response;
   *   blank fields fall back to defaults.
   */
  constructor(reg: Registry, info: ServerInfo) {
    this.#reg = reg;
    this.#info = {
      name: info.name || "galdor-mcp",
      version: info.version || "0",
    };
  }

  /**
   * Handle MCP frames over `transport` until `signal` aborts, the peer closes
   * the medium cleanly, or a fatal transport error occurs. Requests are
   * dispatched concurrently so a slow tool doesn't block the receive loop. The
   * transport is closed when this resolves.
   *
   * @param transport - The connected medium to the peer.
   * @param signal - Optional signal to stop serving and return.
   * @returns A promise that resolves once the peer disconnects or `signal` aborts.
   * @throws If the transport's `receive` fails for a reason other than abort.
   */
  async serve(transport: Transport, signal?: AbortSignal): Promise<void> {
    const inflight = new Set<Promise<void>>();
    // Bound concurrent in-flight dispatches so a peer can't flood the server
    // into spawning unbounded work. A full semaphore applies backpressure: the
    // loop blocks on acquire before reading the next frame.
    const sem = new Semaphore(maxConcurrentDispatch);
    let initialized = false;
    try {
      for (;;) {
        if (signal?.aborted) break;
        let frame: string | null;
        try {
          frame = await transport.receive(signal);
        } catch (err) {
          if (signal?.aborted) break;
          throw err;
        }
        if (frame === null) break; // clean EOF

        let msg: RpcMessage;
        try {
          msg = JSON.parse(frame) as RpcMessage;
        } catch (err) {
          // Can't recover an id from an unparseable frame; reply with id=null.
          await transport.send(errorReply(null, ErrCodeParseError, "parse error", String(err)));
          continue;
        }

        // Notifications (no id) get no reply; just route by method.
        if (msg.id === undefined || msg.id === null) {
          if (msg.method === MethodInitialized) initialized = true;
          continue;
        }

        if (this.strict && !initialized && msg.method !== MethodInitialize) {
          await transport.send(
            errorReply(msg.id, ErrCodeInvalidRequest, "server not initialized", "send initialize first"),
          );
          continue;
        }

        // Acquire a dispatch slot before handing off: when maxConcurrentDispatch
        // requests are already running this blocks, applying backpressure rather
        // than reading the next frame.
        const acquired = await sem.acquire(signal);
        if (!acquired) break; // aborted while waiting for a slot

        const p = (async () => {
          try {
            const reply = await this.#dispatchSafe(msg, signal);
            try {
              await transport.send(reply);
            } catch {
              // Best-effort: nothing we can do if the peer is gone.
            }
          } finally {
            sem.release();
          }
        })();
        inflight.add(p);
        void p.finally(() => inflight.delete(p));
      }
    } finally {
      await Promise.all(inflight);
      transport.close();
    }
  }

  async #dispatchSafe(req: RpcMessage, signal?: AbortSignal): Promise<RpcMessage> {
    try {
      return await this.#dispatch(req, signal);
    } catch (err) {
      return errorReply(req.id ?? null, ErrCodeInternalError, `tool panicked: ${String(err)}`);
    }
  }

  async #dispatch(req: RpcMessage, signal?: AbortSignal): Promise<RpcMessage> {
    if (req.jsonrpc !== "2.0") {
      return errorReply(req.id ?? null, ErrCodeInvalidRequest, "invalid request", '"jsonrpc" must be "2.0"');
    }
    switch (req.method) {
      case MethodInitialize:
        return this.#handleInitialize(req);
      case MethodToolsList:
        return this.#handleToolsList(req);
      case MethodToolsCall:
        return this.#handleToolsCall(req, signal);
      default:
        return errorReply(req.id ?? null, ErrCodeMethodNotFound, "method not found", req.method);
    }
  }

  #handleInitialize(req: RpcMessage): RpcMessage {
    const params = (req.params ?? {}) as Partial<InitializeParams>;
    let version = ProtocolVersion;
    if (params.protocolVersion && supportedProtocolVersions.has(params.protocolVersion)) {
      version = params.protocolVersion;
    }
    return successReply(req.id ?? null, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: this.#info,
    });
  }

  #handleToolsList(req: RpcMessage): RpcMessage {
    const tools: ToolDef[] = this.#reg.tools().map((t) => {
      const description = t.description();
      return description
        ? { name: t.name(), description, inputSchema: t.schema() }
        : { name: t.name(), inputSchema: t.schema() };
    });
    return successReply(req.id ?? null, { tools });
  }

  async #handleToolsCall(req: RpcMessage, signal?: AbortSignal): Promise<RpcMessage> {
    const params = (req.params ?? {}) as Partial<ToolsCallParams>;
    if (!params.name) {
      return errorReply(req.id ?? null, ErrCodeInvalidParams, "decode tools/call params", "missing tool name");
    }
    const t = this.#reg.get(params.name);
    if (!t) {
      return errorReply(req.id ?? null, ErrCodeMethodNotFound, "tool not found", params.name);
    }
    const ctx: RunContext | undefined = signal ? { signal } : undefined;
    try {
      const out = await t.executeJSON(params.arguments ?? null, ctx);
      const content: ContentPart[] = [{ type: "text", text: JSON.stringify(out) }];
      return successReply(req.id ?? null, { content });
    } catch (err) {
      // Tool errors come back as a normal result with isError=true so the model
      // can see them, not as transport-level JSON-RPC errors.
      const text = err instanceof Error ? err.message : String(err);
      const content: ContentPart[] = [{ type: "text", text }];
      return successReply(req.id ?? null, { content, isError: true });
    }
  }
}
