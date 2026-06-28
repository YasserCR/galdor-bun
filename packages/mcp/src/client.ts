/**
 * mcp/client — the MCP client.
 *
 * A {@link Client} speaks MCP to a single remote server over a
 * {@link Transport}, multiplexing many outstanding requests: each gets a unique
 * numeric id and a background dispatch loop routes the matching reply back to
 * the awaiting caller.
 */

import { Registry, type AnyTool } from "@galdor/core/tool";
import type { JSONValue } from "@galdor/core/schema";
import type { RunContext } from "@galdor/core/provider";
import {
  type ClientInfo,
  concatText,
  type InitializeResult,
  MethodInitialize,
  MethodInitialized,
  MethodToolsCall,
  MethodToolsList,
  ProtocolVersion,
  RpcError,
  type RpcMessage,
  type ServerInfo,
  type ToolDef,
  ToolCallError,
  type ToolsCallParams,
  type ToolsCallResult,
  type ToolsListResult,
} from "./jsonrpc.ts";
import type { Transport } from "./transports.ts";

/** Options for {@link Client}. */
export interface ClientOptions {
  /** Name/version reported during the initialize handshake. */
  info?: ClientInfo;
  /**
   * Default per-call timeout (ms) applied when a call carries no `signal`.
   * Without it a stalled server leaves a call blocked forever. A value `<= 0`
   * disables the default. Defaults to 30000.
   */
  callTimeoutMs?: number;
}

/** Bounds a call whose caller passed no AbortSignal of its own. */
const defaultCallTimeoutMs = 30_000;

interface Pending {
  resolve: (msg: RpcMessage) => void;
  reject: (err: unknown) => void;
  cleanup?: () => void;
}

/**
 * An MCP client bound to one server over a {@link Transport}.
 *
 * Construct it, run {@link Client.initialize} to complete the handshake, then
 * {@link Client.listTools} / {@link Client.call} to drive the server — or
 * {@link Client.asRegistry} to surface its tools as a core `Registry` an agent
 * can consume. A background loop dispatches replies, so calls may overlap.
 *
 * @example
 * const [clientT, serverT] = inMemoryTransportPair();
 * void server.serve(serverT);
 * const client = new Client(clientT, { info: { name: "app", version: "1.0" } });
 * await client.initialize();
 * const sum = await client.call("add", { a: 2, b: 3 });
 * client.close();
 */
export class Client {
  readonly #transport: Transport;
  readonly #info: ClientInfo;
  readonly #callTimeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  #nextID = 0;
  #closed = false;
  #recvErr: unknown;

  #serverInfo: ServerInfo = { name: "", version: "" };
  #serverVer = "";

  /**
   * Bind a client to `transport` and start its background dispatch loop.
   *
   * @param transport - The connected medium to the server. The client takes
   *   ownership and closes it on {@link Client.close}.
   * @param opts - Optional client info and call-timeout overrides.
   */
  constructor(transport: Transport, opts: ClientOptions = {}) {
    this.#transport = transport;
    this.#info = opts.info ?? { name: "galdor", version: "0" };
    this.#callTimeoutMs = opts.callTimeoutMs ?? defaultCallTimeoutMs;
    void this.#dispatchLoop();
  }

  /** Name/version the server reported during initialize. Empty before then. */
  serverInfo(): ServerInfo {
    return this.#serverInfo;
  }

  /** Protocol version the server reported during initialize. Empty before then. */
  protocolVersion(): string {
    return this.#serverVer;
  }

  /**
   * Perform the MCP handshake: send `initialize`, await the response, then send
   * the `notifications/initialized` follow-up the spec requires. Records the
   * server info and negotiated protocol version for later inspection.
   *
   * @param signal - Optional cancellation/timeout for the handshake.
   * @throws {RpcError} If the server answers `initialize` with an error.
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    const params = {
      protocolVersion: ProtocolVersion,
      capabilities: { tools: {} },
      clientInfo: this.#info,
    };
    const msg = await this.#request(MethodInitialize, params, signal);
    const out = (msg.result ?? {}) as InitializeResult;
    if (out.serverInfo) this.#serverInfo = out.serverInfo;
    if (out.protocolVersion) this.#serverVer = out.protocolVersion;
    await this.#notify(MethodInitialized, {});
  }

  /** Fetch the tool catalog from the server. */
  async listTools(signal?: AbortSignal): Promise<ToolDef[]> {
    const msg = await this.#request(MethodToolsList, {}, signal);
    return (msg.result as ToolsListResult | undefined)?.tools ?? [];
  }

  /**
   * Invoke a remote tool and return the concatenated text content of the reply.
   *
   * @param toolName - Name of the tool to invoke, as advertised by the server.
   * @param args - Optional JSON arguments matching the tool's input schema.
   * @param signal - Optional cancellation/timeout for this call.
   * @returns The joined text content of the tool's result.
   * @throws {ToolCallError} When the server flags the result `isError`.
   * @throws {RpcError} When the server answers with a JSON-RPC error.
   */
  async call(toolName: string, args?: JSONValue, signal?: AbortSignal): Promise<string> {
    const params: ToolsCallParams =
      args === undefined ? { name: toolName } : { name: toolName, arguments: args };
    const msg = await this.#request(MethodToolsCall, params, signal);
    const out = (msg.result ?? { content: [] }) as ToolsCallResult;
    const text = concatText(out.content ?? []);
    if (out.isError) {
      throw new ToolCallError(toolName, text || "(server returned isError with no text content)");
    }
    return text;
  }

  /**
   * Convert every tool advertised by the server into an `AnyTool` and return
   * a {@link Registry} holding them. Each adapter's `executeJSON` proxies to
   * {@link call}, so invocations flow over the transport transparently and the
   * free-form text result is wrapped as `{ text }` JSON.
   */
  async asRegistry(signal?: AbortSignal): Promise<Registry> {
    const defs = await this.listTools(signal);
    const reg = new Registry();
    for (const d of defs) {
      reg.add(this.#adapt(d));
    }
    return reg;
  }

  #adapt(def: ToolDef): AnyTool {
    const client = this;
    const description = def.description ?? "";
    return {
      name: () => def.name,
      description: () => description,
      schema: () => def.inputSchema,
      async executeJSON(input: JSONValue, ctx?: RunContext): Promise<JSONValue> {
        const text = await client.call(def.name, input, ctx?.signal);
        return { text };
      },
    };
  }

  /** Shut down the dispatcher and close the transport. */
  close(): void {
    this.#fail(new Error("mcp: client closed"));
  }

  // ── request plumbing ──────────────────────────────────────────────────────

  async #request(method: string, params: unknown, callerSignal?: AbortSignal): Promise<RpcMessage> {
    if (this.#closed) {
      throw this.#recvErr instanceof Error
        ? new Error(`mcp: connection closed: ${this.#recvErr.message}`)
        : new Error("mcp: connection closed");
    }

    // Apply the default timeout only when the caller gave no signal of its own.
    let signal = callerSignal;
    if (!signal && this.#callTimeoutMs > 0) signal = AbortSignal.timeout(this.#callTimeoutMs);

    const id = ++this.#nextID;
    const result = new Promise<RpcMessage>((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      if (signal) {
        if (signal.aborted) {
          reject(signal.reason ?? new DOMException("aborted", "AbortError"));
          return;
        }
        const onAbort = (): void => {
          this.#pending.delete(id);
          reject(signal!.reason ?? new DOMException("aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup = () => signal!.removeEventListener("abort", onAbort);
      }
      this.#pending.set(id, entry);
    });

    const req: RpcMessage = { jsonrpc: "2.0", id, method, params };
    try {
      await this.#transport.send(req, callerSignal);
    } catch (err) {
      const entry = this.#pending.get(id);
      entry?.cleanup?.();
      this.#pending.delete(id);
      throw err;
    }

    const msg = await result;
    if (msg.error) throw new RpcError(msg.error);
    return msg;
  }

  async #notify(method: string, params: unknown): Promise<void> {
    await this.#transport.send({ jsonrpc: "2.0", method, params });
  }

  async #dispatchLoop(): Promise<void> {
    for (;;) {
      let frame: string | null;
      try {
        frame = await this.#transport.receive();
      } catch (err) {
        this.#fail(err);
        return;
      }
      if (frame === null) {
        this.#fail(new Error("mcp: connection closed"));
        return;
      }
      let msg: RpcMessage;
      try {
        msg = JSON.parse(frame) as RpcMessage;
      } catch {
        continue; // malformed frame — drop and keep going
      }
      // A frame carrying a method is a server-initiated request/notification,
      // never a reply to one of our calls. We don't service those yet.
      if (msg.method !== undefined && msg.method !== "") continue;
      if (msg.id === undefined || msg.id === null) continue;
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
      if (Number.isNaN(id)) continue;
      const entry = this.#pending.get(id);
      if (entry) {
        this.#pending.delete(id);
        entry.cleanup?.();
        entry.resolve(msg);
      }
    }
  }

  #fail(err: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#recvErr = err;
    for (const entry of this.#pending.values()) {
      entry.cleanup?.();
      entry.reject(err);
    }
    this.#pending.clear();
    this.#transport.close();
  }
}
