/**
 * Embedded observability dashboard for galdor.
 *
 * A self-contained web UI served over either {@link Bun.serve} (under Bun) or
 * `node:http` (under Node), chosen at runtime by {@link startDashboard}. It reads
 * the SQLite span store that the CLI and exporter write to and renders a full
 * trace explorer:
 *
 *   - `GET /`                          run list with a live (SSE) tail
 *   - `GET /runs/:id`                  run detail: timeline, span tree, graph topology
 *   - `GET /runs/:id/steps`            step-by-step walkthrough of the run
 *   - `GET /runs/:id/spans/:spanId`    one span: metadata, attributes, captured messages
 *   - `GET /api/runs`                  JSON run summaries
 *   - `GET /api/runs/:id/spans`        JSON spans for a run
 *   - `GET /api/runs/:id/spans/:spanId`JSON for a single span
 *   - `GET /api/runs/:id/graph`        JSON graph topology recorded for a run
 *   - `GET /api/orphans`               orphan-span count
 *   - `GET /events`                    Server-Sent Events live-tail of the run list
 *
 * All HTML, CSS, and the one small client script are inlined in this module —
 * the interactive timeline and graph are rendered server-side as SVG, so the UI
 * works without any client-side framework and ships as a single importable unit.
 *
 * @see {@link startDashboard} to launch the server.
 * @see {@link createHandler} to obtain the request handler on its own.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { END, type GraphSpec, START } from "@galdor/core/graph";
import type { Message } from "@galdor/core/schema";
import { runDuration, runStatus, type Span, spanDuration, Store } from "@galdor/core/store";

/** `true` when running on the Bun runtime; `false` under Node (or any other host). */
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * Attribute keys and span names recorded by the tracing layer. These mirror the
 * constants exported from `@galdor/core/observability`; they are kept local so
 * the viewer depends only on the span store, not on the tracing SDK.
 */
const A = {
  node: "galdor.node.name",
  label: "galdor.span.label",
  provider: "galdor.provider.name",
  streaming: "galdor.provider.streaming",
  step: "galdor.step",
  prompt: "gen_ai.prompt",
  completion: "gen_ai.completion",
  reasoning: "gen_ai.reasoning",
  reqModel: "gen_ai.request.model",
  respModel: "gen_ai.response.model",
  finish: "gen_ai.response.finish_reasons",
  inTokens: "gen_ai.usage.input_tokens",
  outTokens: "gen_ai.usage.output_tokens",
  toolName: "gen_ai.tool.name",
  toolIn: "gen_ai.tool.input_size_bytes",
  toolOut: "gen_ai.tool.output_size_bytes",
  reqTools: "gen_ai.request.tools",
  system: "gen_ai.system",
} as const;

const SPAN = {
  run: "galdor.graph.run",
  node: "galdor.graph.node",
  generate: "galdor.provider.generate",
  stream: "galdor.provider.stream",
  tool: "galdor.tool.execute",
} as const;

/** The four kinds of span the UI colour-codes, plus a catch-all. */
type Kind = "run" | "node" | "model" | "tool" | "other";

/** Map a span name to its display kind. */
function kindOf(name: string): Kind {
  if (name === SPAN.run) return "run";
  if (name === SPAN.node) return "node";
  if (name === SPAN.generate || name === SPAN.stream) return "model";
  if (name === SPAN.tool) return "tool";
  return "other";
}

/** CSS custom-property colour for each span kind. */
const KIND_FILL: Record<Kind, string> = {
  run: "var(--accent)",
  node: "var(--slate)",
  model: "var(--blue)",
  tool: "var(--violet)",
  other: "var(--subtle)",
};

/**
 * Configuration for {@link startDashboard}.
 *
 * Provide either a {@link DashboardOptions.store | store} to serve from an
 * already-open {@link Store}, or a {@link DashboardOptions.dbPath | dbPath} to
 * open one on demand.
 */
export interface DashboardOptions {
  /** Path to the span database; `":memory:"` for tests, or a file path for the real store. */
  dbPath?: string;
  /** An already-open {@link Store} to serve from. Takes precedence over {@link DashboardOptions.dbPath | dbPath}. */
  store?: Store;
  /** Listen host. Defaults to `127.0.0.1` (loopback only). */
  hostname?: string;
  /** Listen port. Defaults to `7777`; pass `0` to bind an ephemeral port. */
  port?: number;
}

/** Convert a nanosecond count to whole milliseconds. */
const nanosToMs = (n: bigint): number => Number(n / 1_000_000n);

/** Like {@link JSON.stringify} but renders `bigint` values as decimal numbers (safe at millisecond scale). */
function toJSON(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
}

/** Wrap a value as a JSON {@link Response} with the given status. */
function json(value: unknown, status = 200): Response {
  return new Response(toJSON(value), { status, headers: { "content-type": "application/json" } });
}

/** Wrap an HTML body as a UTF-8 {@link Response} with the given status. */
function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** Wrap an SVG document as an `image/svg+xml` {@link Response}. */
function svg(body: string): Response {
  return new Response(body, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-cache" } });
}

/**
 * Build the dashboard request handler bound to a span store.
 *
 * The returned function routes requests to the HTML pages, JSON endpoints, and
 * the SSE live-tail described in the module overview, and answers `404` for any
 * unmatched path. Use it directly when embedding the dashboard in an existing
 * server, or let {@link startDashboard} wire it into {@link Bun.serve} for you.
 *
 * @param store - The {@link Store} whose runs and spans are served.
 * @returns A fetch handler that maps a {@link Request} to a {@link Response}.
 * @example
 * ```ts
 * const handler = createHandler(Store.openExisting("spans.db"));
 * const res = handler(new Request("http://x/api/runs"));
 * ```
 */
export function createHandler(store: Store): (req: Request) => Response {
  return (req: Request): Response => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/") return html(runListPage(store));
    if (path === "/api/runs") return json(runListJSON(store));
    if (path === "/api/orphans") return json({ orphans: store.orphanSpanCount() });
    if (path === "/events") return sseLiveTail(store);

    let m = path.match(/^\/api\/runs\/([^/]+)\/spans\/([^/]+)$/);
    if (m) {
      const s = findSpan(store, decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
      return s ? json(spanJSON(s)) : json({ error: "span not found" }, 404);
    }

    m = path.match(/^\/api\/runs\/([^/]+)\/spans$/);
    if (m) return json(spansJSON(store, decodeURIComponent(m[1]!)));

    m = path.match(/^\/api\/runs\/([^/]+)\/graph\/model$/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const spec = graphSpec(store, id);
      return spec
        ? json(graphModel(spec, store.spansForRun(id)))
        : json({ error: "no graph topology recorded for this run" }, 404);
    }

    m = path.match(/^\/api\/runs\/([^/]+)\/graph\/svg$/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const spec = graphSpec(store, id);
      if (!spec) return json({ error: "no graph topology recorded for this run" }, 404);
      const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
      return svg(graphSVG(id, spec, store.spansForRun(id), { standalone: true, theme }));
    }

    m = path.match(/^\/api\/runs\/([^/]+)\/graph$/);
    if (m) {
      const spec = graphSpec(store, decodeURIComponent(m[1]!));
      return spec ? json(spec) : json({ error: "no graph topology recorded for this run" }, 404);
    }

    m = path.match(/^\/runs\/([^/]+)\/spans\/([^/]+)$/);
    if (m) return html(spanDetailPage(store, decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)));

    m = path.match(/^\/runs\/([^/]+)\/steps$/);
    if (m) return html(stepsPage(store, decodeURIComponent(m[1]!)));

    m = path.match(/^\/runs\/([^/]+)$/);
    if (m) return html(runDetailPage(store, decodeURIComponent(m[1]!)));

    return new Response("not found", { status: 404 });
  };
}

/**
 * A running dashboard server, exposed uniformly across runtimes.
 *
 * Both the Bun and Node backends return a value matching this shape so callers
 * and tests can stay runtime-agnostic.
 */
export interface DashboardServer {
  /**
   * The bound listen port. When an ephemeral port (`0`) was requested, the
   * OS-assigned port is only known once the server is listening — await
   * {@link DashboardServer.ready} before reading `.port` in that case. For a
   * fixed port it is valid immediately.
   */
  port: number;
  /** The bound listen host. */
  hostname: string;
  /**
   * Resolves once the server is accepting connections. Await it before reading
   * {@link DashboardServer.port} when an ephemeral port (`0`) was requested.
   */
  ready: Promise<void>;
  /**
   * Shut the server down.
   *
   * @param force - When `true`, also tear down active connections (e.g. open
   *   Server-Sent Events streams) so the listener can close promptly.
   */
  stop(force?: boolean): void;
}

/**
 * Start the dashboard HTTP server.
 *
 * Serves from {@link DashboardOptions.store} when provided, otherwise opens the
 * store at {@link DashboardOptions.dbPath} (defaulting to an in-memory store).
 *
 * The transport is chosen by runtime: on Bun the server is backed by
 * {@link Bun.serve}; on Node it is backed by `node:http`, with an adapter that
 * converts each incoming request into a Web {@link Request}, runs the same
 * {@link createHandler} handler, and streams the Web {@link Response} back —
 * including unbounded Server-Sent Events bodies. Either way the return value
 * conforms to {@link DashboardServer}.
 *
 * @param opts - Server and store {@link DashboardOptions | options}.
 * @returns The running {@link DashboardServer}; call `.stop()` to shut it down.
 * @example
 * ```ts
 * const server = startDashboard({ dbPath: "spans.db", port: 7777 });
 * // ...later
 * server.stop();
 * ```
 */
export function startDashboard(opts: DashboardOptions = {}): DashboardServer {
  const store = opts.store ?? Store.openExisting(opts.dbPath ?? ":memory:");
  const handler = createHandler(store);
  const hostname = opts.hostname ?? "127.0.0.1";
  const port = opts.port ?? 7777;

  if (isBun) {
    const server = Bun.serve({ hostname, port, fetch: handler });
    return {
      get port() {
        return server.port ?? port;
      },
      get hostname() {
        return server.hostname ?? hostname;
      },
      // Bun resolves the ephemeral port synchronously, so the server is ready at once.
      ready: Promise.resolve(),
      stop(force?: boolean) {
        void server.stop(force);
      },
    };
  }
  return startNodeDashboard(handler, hostname, port);
}

// ── Node (node:http) transport ───────────────────────────────────────────────────

/**
 * Back the dashboard with `node:http` when not running under Bun.
 *
 * For every request the Node {@link IncomingMessage} is adapted to a Web
 * {@link Request} (see {@link toWebRequest}), passed through the shared handler,
 * and the resulting Web {@link Response} is written back to the
 * {@link ServerResponse} by streaming its body (see {@link writeWebResponse}).
 * Open responses are tracked so {@link DashboardServer.stop | stop} can tear
 * down live SSE streams and let the listener close.
 */
function startNodeDashboard(handler: (req: Request) => Response, hostname: string, port: number): DashboardServer {
  const active = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    active.add(res);
    res.on("close", () => active.delete(res));
    let webRes: Response;
    try {
      webRes = handler(toWebRequest(req, hostname, boundPort()));
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end((e as Error).message);
      return;
    }
    void writeWebResponse(res, webRes);
  });
  // node:http binds asynchronously: server.address() (and thus an ephemeral
  // port) is null until the "listening" event fires. Expose that as `ready`.
  const ready = new Promise<void>((resolve) => server.once("listening", () => resolve()));
  server.listen(port, hostname);

  /** The OS-assigned port once listening, falling back to the requested port. */
  const boundPort = (): number => {
    const addr = server.address();
    return addr && typeof addr === "object" ? addr.port : port;
  };

  return {
    get port() {
      return boundPort();
    },
    hostname,
    ready,
    stop() {
      // Destroy live connections (notably open SSE streams) so close() can settle.
      for (const res of active) res.destroy();
      active.clear();
      server.close();
    },
  };
}

/**
 * Adapt a Node {@link IncomingMessage} to a Web {@link Request}.
 *
 * Reconstructs the absolute URL from the `Host` header (or the bound address),
 * copies method and headers, and — for methods that carry a body — wraps the
 * request stream in a {@link ReadableStream}. The dashboard only serves `GET`,
 * but body forwarding keeps the adapter general.
 */
function toWebRequest(req: IncomingMessage, hostname: string, port: number): Request {
  const host = req.headers.host ?? `${hostname}:${port}`;
  const url = `http://${host}${req.url ?? "/"}`;
  const method = req.method ?? "GET";

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }

  const hasBody = method !== "GET" && method !== "HEAD";
  if (!hasBody) return new Request(url, { method, headers });

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      req.on("end", () => controller.close());
      req.on("error", (err) => controller.error(err));
    },
  });
  // `duplex` is required when streaming a request body but is missing from the lib DOM types.
  return new Request(url, { method, headers, body, duplex: "half" } as RequestInit & { duplex: "half" });
}

/**
 * Write a Web {@link Response} back to a Node {@link ServerResponse}.
 *
 * The status and headers are flushed first, then the response body is streamed
 * chunk-by-chunk. This handles both finite bodies (HTML/JSON, whose stream ends)
 * and the unbounded SSE live-tail (whose stream only ends when the client
 * disconnects): when the socket closes, the reader is cancelled, which runs the
 * body's `cancel()` and clears the SSE interval. String chunks (the SSE handler
 * enqueues strings) and byte chunks are both encoded to a {@link Buffer}.
 */
async function writeWebResponse(res: ServerResponse, webRes: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  webRes.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(webRes.status, headers);

  const body = webRes.body;
  if (!body) {
    res.end();
    return;
  }

  const reader = body.getReader();
  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel().catch(() => {});
  };
  // If the client hangs up (e.g. closes the SSE connection), stop pulling.
  res.on("close", cancel);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = typeof value === "string" ? Buffer.from(value) : Buffer.from(value as Uint8Array);
      if (!res.write(chunk)) await new Promise<void>((resolve) => res.once("drain", resolve));
    }
  } catch {
    // Stream errored or was aborted mid-flight — fall through to end the response.
  }
  if (!res.writableEnded) res.end();
}

// ── JSON shaping ───────────────────────────────────────────────────────────────

function runListJSON(store: Store) {
  return store.listRuns(100).map((r) => ({
    runId: r.runId,
    traceId: r.traceId,
    startMs: nanosToMs(r.startTimeUnixNano),
    durationMs: nanosToMs(runDuration(r)),
    spanCount: r.spanCount,
    errorCount: r.errorCount,
    status: runStatus(r),
  }));
}

/** Parse the graph topology recorded for a run, or `undefined` when none exists. */
function graphSpec(store: Store, runId: string): GraphSpec | undefined {
  const raw = store.getGraphSpec(runId);
  if (raw === "") return undefined;
  try {
    return normalizeSpec(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Normalize a recorded graph spec into {@link GraphSpec}.
 *
 * Accepts two equivalent encodings: nodes as plain names with `edges` /
 * `conditional`, or nodes as `{name}` objects with `static_edges` /
 * `conditional_edges` whose branches are `[{label,to}]`. Both describe the same
 * topology, so either renders identically.
 */
function normalizeSpec(v: unknown): GraphSpec | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const entry = typeof o.entry === "string" ? o.entry : "";

  const rawNodes = Array.isArray(o.nodes) ? o.nodes : [];
  const nodes = rawNodes
    .map((n) => (typeof n === "string" ? n : n && typeof (n as { name?: unknown }).name === "string" ? (n as { name: string }).name : ""))
    .filter((n): n is string => n.length > 0);

  const rawEdges = Array.isArray(o.edges) ? o.edges : Array.isArray(o.static_edges) ? o.static_edges : [];
  const edges = rawEdges
    .filter((e): e is { from: string; to: string } => !!e && typeof (e as { from?: unknown }).from === "string" && typeof (e as { to?: unknown }).to === "string")
    .map((e) => ({ from: e.from, to: e.to }));

  let conditional: GraphSpec["conditional"] = [];
  if (Array.isArray(o.conditional)) {
    conditional = o.conditional
      .filter((c): c is { from: string; labels?: Record<string, string> } => !!c && typeof (c as { from?: unknown }).from === "string")
      .map((c) => (c.labels ? { from: c.from, labels: c.labels } : { from: c.from }));
  } else if (Array.isArray(o.conditional_edges)) {
    conditional = (o.conditional_edges as Array<{ from?: unknown; branches?: Array<{ label?: unknown; to?: unknown }> }>)
      .filter((c): c is { from: string; branches?: Array<{ label: string; to: string }> } => !!c && typeof c.from === "string")
      .map((c) => {
        if (Array.isArray(c.branches) && c.branches.length > 0) {
          const labels: Record<string, string> = {};
          for (const b of c.branches) {
            if (b && typeof b.label === "string" && typeof b.to === "string") labels[b.label] = b.to;
          }
          return { from: c.from, labels };
        }
        return { from: c.from };
      });
  }

  if (!entry && nodes.length === 0 && edges.length === 0 && conditional.length === 0) return undefined;
  return { entry, nodes, edges, conditional };
}

function spanJSON(s: Span) {
  return {
    spanId: s.spanId,
    parentSpanId: s.parentSpanId,
    traceId: s.traceId,
    name: s.name,
    startMs: nanosToMs(s.startTimeUnixNano),
    durationMs: Number(spanDuration(s)) / 1e6,
    statusCode: s.statusCode,
    statusMessage: s.statusMessage,
    attributes: s.attributes,
    events: s.events.map((e) => ({ name: e.name, timeMs: nanosToMs(e.timeUnixNano), attributes: e.attributes })),
  };
}

function spansJSON(store: Store, runId: string) {
  return store.spansForRun(runId).map(spanJSON);
}

function findSpan(store: Store, runId: string, spanId: string): Span | undefined {
  return store.spansForRun(runId).find((s) => s.spanId === spanId);
}

// ── SSE live tail ───────────────────────────────────────────────────────────────

function sseLiveTail(store: Store): Response {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const push = () => {
        try {
          controller.enqueue(`event: runs\ndata: ${toJSON(runListJSON(store))}\n\n`);
        } catch {
          if (timer) clearInterval(timer);
        }
      };
      push();
      timer = setInterval(push, 2000);
      timer.unref?.();
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

// ── formatting helpers ───────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

const enc = encodeURIComponent;

/** Format a nanosecond duration as a compact, human-readable string. */
function fmtDur(ns: bigint): string {
  const ms = Number(ns) / 1e6;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 1) return `${ms.toFixed(1)} ms`;
  if (ms > 0) return `${ms.toFixed(2)} ms`;
  return "0 ms";
}

/** Truncate a long id to `head…tail` form for compact display. */
function shortId(s: string): string {
  return s.length > 18 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

/** Strip the `galdor.` prefix from a span name for readability. */
function shortName(name: string): string {
  return name.replace(/^galdor\./, "");
}

/** Display label for a graph node, naming the sentinel start/end nodes. */
function nodeLabel(n: string): string {
  return n === START ? "start" : n === END ? "end" : n;
}

/** Read a string attribute, or `undefined` when absent or not a string. */
function attrStr(attrs: Record<string, unknown>, key: string): string | undefined {
  const v = attrs[key];
  return typeof v === "string" ? v : undefined;
}

/** Read a numeric attribute, coercing numeric strings, or `undefined`. */
function attrNum(attrs: Record<string, unknown>, key: string): number | undefined {
  const v = attrs[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

/** Render an arbitrary attribute value for the attributes table. */
function fmtVal(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ── span ordering ────────────────────────────────────────────────────────────────

interface Ordered {
  span: Span;
  depth: number;
}

/** Lay spans out in depth-first preorder (children under parents, by start time). */
function orderSpans(spans: Span[]): Ordered[] {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const children = new Map<string, Span[]>();
  const roots: Span[] = [];
  for (const s of spans) {
    const p = s.parentSpanId;
    if (p && byId.has(p)) {
      const arr = children.get(p) ?? [];
      arr.push(s);
      children.set(p, arr);
    } else {
      roots.push(s);
    }
  }
  const cmp = (a: Span, b: Span): number =>
    a.startTimeUnixNano < b.startTimeUnixNano ? -1 : a.startTimeUnixNano > b.startTimeUnixNano ? 1 : 0;
  const out: Ordered[] = [];
  const walk = (s: Span, depth: number): void => {
    out.push({ span: s, depth });
    for (const c of (children.get(s.spanId) ?? []).sort(cmp)) walk(c, depth + 1);
  };
  for (const r of roots.sort(cmp)) walk(r, 0);
  return out;
}

/** The earliest start and latest end across a set of spans. */
function runBounds(spans: Span[]): { t0: bigint; t1: bigint } {
  let t0 = spans[0]!.startTimeUnixNano;
  let t1 = spans[0]!.endTimeUnixNano;
  for (const s of spans) {
    if (s.startTimeUnixNano < t0) t0 = s.startTimeUnixNano;
    if (s.endTimeUnixNano > t1) t1 = s.endTimeUnixNano;
  }
  return { t0, t1 };
}

// ── HTML shell ───────────────────────────────────────────────────────────────────

const STYLE = `
:root{
  --bg:#131314; --bg2:#1b1c1d; --panel:#1e1f20; --panel2:#28292b; --raised:#2d2f31;
  --border:#303134; --border2:#3c4043; --fg:#e3e3e3; --muted:#bdc1c6; --subtle:#9aa0a6;
  --accent:#8ab4f8; --accent-soft:rgba(138,180,248,.12);
  --blue:#8ab4f8; --violet:#c58af9; --slate:#9aa0a6;
  --ok:#81c995; --err:#f28b82; --warn:#fdd663;
  --edge:#5b636f; --node-stroke:#454a52; --grid:#34363a;
  --radius:12px; --mono:"Roboto Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --sans:"Google Sans","Google Sans Text","Product Sans",Inter,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
}
:root,:root[data-theme="dark"]{color-scheme:dark;}
:root[data-theme="light"]{
  color-scheme:light;
  --bg:#ffffff; --bg2:#f0f4f9; --panel:#ffffff; --panel2:#f3f6fc; --raised:#e9eef6;
  --border:#dde3ea; --border2:#c4cad1; --fg:#1f1f1f; --muted:#444746; --subtle:#6f7378;
  --accent:#0b57d0; --accent-soft:rgba(11,87,208,.08);
  --blue:#0b57d0; --violet:#8430ce; --slate:#5f6368;
  --ok:#188038; --err:#c5221f; --warn:#9a6700;
  --edge:#80868b; --node-stroke:#9aa0a6; --grid:#c4cad1;
}
*{box-sizing:border-box;}
html,body{margin:0;}
body{
  background:var(--bg);
  color:var(--fg); font:14px/1.55 var(--sans); -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
}
a{color:var(--accent); text-decoration:none;} a:hover{text-decoration:underline;}
code,pre,.mono{font-family:var(--mono);}
.muted{color:var(--muted);} .subtle{color:var(--subtle);}

.topbar{position:sticky; top:0; z-index:10; display:flex; align-items:center; gap:14px;
  padding:12px 26px; background:var(--bg2); border-bottom:1px solid var(--border);}
.brand{display:flex; align-items:baseline; gap:9px;}
.brand .mark{font-weight:500; font-size:16px; letter-spacing:0; color:var(--fg);}
.brand .mark a{color:var(--fg);}
.brand .tag{font-size:12px; color:var(--subtle); letter-spacing:0;}
.topbar .spacer{flex:1;}
.live{display:inline-flex; align-items:center; gap:7px; font-size:12px; color:var(--subtle);}
.icon-btn{display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px;
  border:1px solid var(--border2); border-radius:9px; background:var(--panel2); color:var(--muted);
  cursor:pointer; font:15px/1 var(--sans); transition:border-color .12s,color .12s,background .12s;}
.icon-btn:hover{border-color:var(--accent); color:var(--fg); background:var(--raised);}
.live .pulse{width:7px; height:7px; border-radius:50%; background:var(--ok); opacity:.9; animation:pulse 2.4s ease-in-out infinite;}
@keyframes pulse{0%,100%{opacity:.3;}50%{opacity:.9;}}

main{padding:26px; max-width:1180px; margin:0 auto;}
.crumbs{display:flex; gap:8px; align-items:center; font-size:13px; margin-bottom:14px; color:var(--subtle);}
.crumbs a{color:var(--muted);} .crumbs .sep{color:var(--border2);}

.page-head{display:flex; align-items:flex-start; gap:16px; flex-wrap:wrap; margin-bottom:20px;}
.page-head h1{margin:0; font-size:20px; letter-spacing:-.2px;}
.page-head .id{font-family:var(--mono); font-size:13px; color:var(--muted); word-break:break-all;}
.page-head .actions{margin-left:auto; display:flex; gap:8px;}

.btn{display:inline-block; padding:6px 13px; border:1px solid var(--border2); border-radius:8px;
  background:var(--panel2); color:var(--fg); font-size:13px; cursor:pointer;}
.btn:hover{border-color:var(--accent); text-decoration:none; background:var(--raised);}
.btn.primary{background:var(--accent-soft); border-color:var(--accent);}

.stats{display:flex; gap:10px; flex-wrap:wrap; margin-bottom:18px;}
.stat{background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); padding:10px 16px; min-width:108px;}
.stat .k{font-size:11px; text-transform:uppercase; letter-spacing:.6px; color:var(--subtle);}
.stat .v{font-size:19px; font-weight:600; margin-top:2px; font-variant-numeric:tabular-nums;}

.panel{background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); margin-bottom:20px; overflow:hidden;}
.panel > h2{margin:0; padding:13px 18px; font-size:13px; font-weight:500; letter-spacing:0;
  color:var(--muted); border-bottom:1px solid var(--border); background:var(--bg2); display:flex; gap:10px; align-items:center;}
.panel > h2 .count{color:var(--subtle); font-weight:400; letter-spacing:0;}
.panel-body{padding:16px 18px;}
.panel-scroll{overflow-x:auto;}

.banner{margin:0 0 20px; padding:11px 15px; border-radius:var(--radius); font-size:13px;
  background:rgba(253,214,99,.08); border:1px solid rgba(253,214,99,.32); color:var(--warn);}

table{width:100%; border-collapse:collapse;}
th,td{text-align:left; padding:10px 16px; border-bottom:1px solid var(--border);}
tr:last-child td{border-bottom:0;}
th{color:var(--subtle); font-weight:500; font-size:12px; letter-spacing:0;}
tbody tr{transition:background .12s;} tbody tr:hover{background:var(--panel2);}
td.num{font-variant-numeric:tabular-nums;}

.badge{display:inline-block; padding:1px 9px; border-radius:20px; font-size:11.5px; font-weight:600; line-height:1.6;}
.badge.ok{background:rgba(129,201,149,.14); color:var(--ok);}
.badge.err,.badge.error{background:rgba(242,139,130,.14); color:var(--err);}
.dot{display:inline-block; width:9px; height:9px; border-radius:50%; vertical-align:middle;}
.dot.ok{background:var(--ok);} .dot.error{background:var(--err);}
.dot.run{background:var(--accent);} .dot.node{background:var(--slate);}
.dot.model{background:var(--blue);} .dot.tool{background:var(--violet);} .dot.other{background:var(--subtle);}

/* span tree */
.tree{display:flex; flex-direction:column;}
.trow{display:flex; align-items:center; gap:12px; padding:7px 18px; border-bottom:1px solid var(--border);
  color:var(--fg); font-size:13px;}
.trow:last-child{border-bottom:0;}
.trow:hover{background:var(--panel2); text-decoration:none;}
.trow .nm{display:flex; align-items:center; gap:8px; min-width:240px; font-family:var(--mono);}
.trow .nm .lbl{color:var(--subtle); font-family:var(--sans);}
.trow .ex{margin-left:8px; color:var(--muted); font-family:var(--sans); font-size:12px; white-space:nowrap;}
.trow .ex .exk{color:var(--subtle); margin-right:3px;}
.trow .tbar{flex:1; height:8px; background:var(--bg2); border-radius:5px; position:relative; min-width:120px; overflow:hidden;}
.trow .tbar i{position:absolute; top:0; bottom:0; border-radius:5px;}
.trow .tdur{font-variant-numeric:tabular-nums; color:var(--muted); width:78px; text-align:right;}

/* timeline */
.timeline{display:block; width:100%; height:auto; font-family:var(--mono);}
.timeline .tl-grid{stroke:var(--grid); stroke-width:1;}
.timeline .tl-axis{fill:var(--subtle); font-size:10px;}
.timeline .tl-label{fill:var(--muted); font-size:11px;}
.timeline .tl-dur{fill:var(--subtle); font-size:10px;}
.timeline a .tl-hit{fill:transparent;}
.timeline a:hover .tl-hit{fill:rgba(122,162,255,.08);}
.timeline a:hover .tl-label{fill:var(--fg);}
.legend{display:flex; gap:16px; flex-wrap:wrap; padding:10px 18px 0; font-size:12px; color:var(--muted);}
.legend span{display:inline-flex; align-items:center; gap:6px;}

/* graph */
.graph{display:block; width:100%; height:auto; font-family:var(--sans);}
.graph .edge{fill:none; stroke:var(--edge); stroke-width:1.7;}
.graph .edge.cond{stroke-dasharray:5 4; stroke:var(--slate);}
.graph .arrow{fill:var(--edge);}
.graph .edge-label{fill:var(--subtle); font-size:10px; text-anchor:middle;}
.graph .gnode rect{fill:var(--raised); stroke:var(--node-stroke); stroke-width:1.5;}
.graph .gnode:hover rect{stroke:var(--accent);}
.graph .gnode.entry rect{stroke:var(--accent); fill:var(--accent-soft);}
.graph .gnode.term rect{fill:var(--panel2); stroke:var(--slate);}
.graph .gnode.err rect{stroke:var(--err);}
.graph .gnode-label{fill:var(--fg); font-size:12px; font-weight:600; text-anchor:middle;}
.graph .gnode-sub{fill:var(--muted); font-size:10px; text-anchor:middle; font-family:var(--mono);}

/* topology lists */
.topo{display:flex; gap:34px; flex-wrap:wrap;}
.topo h3{font-size:12px; text-transform:uppercase; letter-spacing:.5px; color:var(--subtle); margin:0 0 8px;}
.topo ul{margin:0; padding-left:18px; font-family:var(--mono); font-size:13px;}
.topo li{margin:3px 0;}

/* meta grid */
.meta{display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:1px; background:var(--border); border-radius:var(--radius); overflow:hidden;}
.meta .cell{background:var(--panel); padding:11px 16px;}
.meta .k{font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:var(--subtle);}
.meta .v{margin-top:3px; font-family:var(--mono); font-size:13px; word-break:break-all;}

/* messages */
.msgs{display:grid; grid-template-columns:1fr 1fr; gap:16px;}
@media(max-width:820px){.msgs{grid-template-columns:1fr;}}
.msgcol h3{font-size:12px; text-transform:uppercase; letter-spacing:.5px; color:var(--subtle); margin:0 0 10px;}
.msg{border:1px solid var(--border); border-radius:9px; margin-bottom:10px; overflow:hidden; background:var(--bg2);}
.msg-role{font-size:11px; text-transform:uppercase; letter-spacing:.6px; padding:5px 12px; color:var(--muted); border-bottom:1px solid var(--border); background:var(--panel2);}
.msg.user .msg-role{color:var(--accent);}
.msg.assistant .msg-role{color:var(--ok);}
.msg.system .msg-role{color:var(--warn);}
.msg.tool .msg-role{color:var(--violet);}
.msg-body{padding:10px 12px;}
.msg-body pre{margin:0; white-space:pre-wrap; word-break:break-word; font-size:12.5px; line-height:1.5;}
.msg-body pre.text{font-family:var(--sans);}
.toolcall{font-family:var(--mono); font-size:12.5px; color:var(--violet); margin:5px 0; word-break:break-word;}
.toolcall .tname{color:var(--fg);}
.toolcall code{color:var(--muted);}
details.reason{margin:6px 0; border-left:2px solid var(--border2); padding-left:10px;}
details.reason summary{cursor:pointer; color:var(--subtle); font-size:12px;}
details.reason pre{margin:6px 0 0; white-space:pre-wrap; font-size:12px; color:var(--muted);}

/* steps */
.step{border:1px solid var(--border); border-radius:var(--radius); margin-bottom:16px; overflow:hidden; background:var(--panel);}
.step-head{display:flex; align-items:center; gap:12px; padding:11px 16px; background:var(--bg2); border-bottom:1px solid var(--border);}
.step-head .n{width:26px; height:26px; border-radius:7px; background:var(--accent-soft); color:var(--accent); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px;}
.step-head .nm{font-weight:600;}
.step-head .meta-inline{margin-left:auto; color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums;}
.step-body{padding:14px 16px;}
.call{border:1px solid var(--border); border-radius:9px; padding:11px 13px; margin-bottom:12px; background:var(--bg2);}
.call:last-child{margin-bottom:0;}
.call-head{display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; margin-bottom:8px; font-size:13px;}
.call-head .kind{font-size:11px; text-transform:uppercase; letter-spacing:.5px; padding:1px 8px; border-radius:6px;}
.call-head .kind.model{background:rgba(138,180,248,.14); color:var(--blue);}
.call-head .kind.tool{background:rgba(197,138,249,.14); color:var(--violet);}
.call-head .meta-inline{margin-left:auto; color:var(--subtle); font-size:12px; font-variant-numeric:tabular-nums;}
.hint{font-size:12.5px; color:var(--subtle); font-style:italic;}

.empty{padding:30px; text-align:center; color:var(--subtle);}
`;

/** Top navigation bar shared by every page. */
function topbar(live: boolean): string {
  const liveDot = live
    ? `<span class="live"><span class="pulse"></span> live</span>`
    : "";
  return `<div class="topbar">
  <div class="brand"><span class="mark"><a href="/">galdor</a></span><span class="tag">trace explorer</span></div>
  <span class="spacer"></span>${liveDot}
  <button id="theme-toggle" class="icon-btn" type="button" aria-label="Toggle light or dark theme" title="Toggle light / dark"></button>
</div>`;
}

/** Inline, render-blocking theme bootstrap: applies the saved/system theme before first paint (no flash). */
const THEME_INIT = `<script>(function(){try{var s=localStorage.getItem('galdor-theme');var t=s||((window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark');document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();</script>`;

/** Wire the topbar toggle to flip and persist the theme. */
const THEME_TOGGLE = `<script>(function(){var b=document.getElementById('theme-toggle');if(!b)return;function sync(){var t=document.documentElement.getAttribute('data-theme');b.textContent=t==='light'?'\\u263E':'\\u2600';}sync();b.addEventListener('click',function(){var next=document.documentElement.getAttribute('data-theme')==='light'?'dark':'light';document.documentElement.setAttribute('data-theme',next);try{localStorage.setItem('galdor-theme',next);}catch(e){}sync();});})();</script>`;

function shell(title: string, body: string, opts: { live?: boolean } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${THEME_INIT}<title>${esc(title)} · galdor</title><style>${STYLE}</style></head>
<body>${topbar(opts.live ?? false)}<main>${body}</main>${THEME_TOGGLE}</body></html>`;
}

// ── run list page ────────────────────────────────────────────────────────────────

function runListPage(store: Store): string {
  const runs = runListJSON(store);
  const orphans = store.orphanSpanCount();
  const banner = orphans > 0
    ? `<div class="banner">⚠ ${orphans} span(s) carry no run id and won't appear below — instrument through @galdor/core/observability so every span lands in a run.</div>`
    : "";
  const rowsHtml = runs.length === 0
    ? `<tr><td colspan="5" class="empty">No runs recorded yet. Run a traced graph and they'll appear here.</td></tr>`
    : runs.map(runRow).join("");

  // Live-tail: re-render the tbody as new runs arrive over SSE.
  const script = `<script>
function row(r){
  var t=new Date(r.startMs).toLocaleTimeString();
  var dur=r.durationMs>=1000?(r.durationMs/1000).toFixed(2)+' s':r.durationMs+' ms';
  return '<tr><td><span class="dot '+r.status+'"></span> <a href="/runs/'+encodeURIComponent(r.runId)+'">'+
    (r.runId||'(no id)')+'</a></td><td><span class="badge '+r.status+'">'+r.status+'</span></td>'+
    '<td class="num">'+r.spanCount+'</td><td class="num">'+dur+'</td><td class="muted">'+t+'</td></tr>';
}
var es=new EventSource('/events');
es.addEventListener('runs',function(e){
  var runs=JSON.parse(e.data); if(!runs.length) return;
  document.querySelector('tbody').innerHTML=runs.map(row).join('');
});
</script>`;

  const body = `${banner}
<div class="page-head"><h1>Runs</h1></div>
<div class="panel panel-scroll">
  <table><thead><tr><th>run</th><th>status</th><th>spans</th><th>duration</th><th>started</th></tr></thead>
  <tbody>${rowsHtml}</tbody></table>
</div>${script}`;
  return shell("runs", body, { live: true });
}

function runRow(r: ReturnType<typeof runListJSON>[number]): string {
  const dur = r.durationMs >= 1000 ? `${(r.durationMs / 1000).toFixed(2)} s` : `${r.durationMs} ms`;
  const time = new Date(r.startMs).toLocaleTimeString();
  return `<tr>
  <td><span class="dot ${r.status}"></span> <a href="/runs/${enc(r.runId)}">${esc(r.runId || "(no id)")}</a></td>
  <td><span class="badge ${r.status}">${r.status}</span></td>
  <td class="num">${r.spanCount}</td>
  <td class="num">${dur}</td>
  <td class="muted">${esc(time)}</td>
</tr>`;
}

// ── run detail page ──────────────────────────────────────────────────────────────

function runDetailPage(store: Store, runId: string): string {
  const spans = store.spansForRun(runId);
  if (spans.length === 0) {
    return shell(
      runId,
      `${crumbs([["/", "runs"], [null, shortId(runId)]])}<div class="panel"><div class="empty">No spans recorded for <code>${esc(runId)}</code>.</div></div>`,
    );
  }
  const ordered = orderSpans(spans);
  const { t0, t1 } = runBounds(spans);
  const total = t1 > t0 ? t1 - t0 : 1n;
  const errors = spans.filter((s) => s.statusCode === "error").length;
  const status = errors > 0 ? "error" : "ok";
  const spec = graphSpec(store, runId);
  const tok = tokenTotals(spans);
  const tokStat = tok.input + tok.output > 0
    ? `<div class="stat"><div class="k">tokens</div><div class="v">${tok.input + tok.output}<span class="subtle" style="font-size:12px"> · ${tok.input}↑ ${tok.output}↓</span></div></div>`
    : "";

  const head = `<div class="page-head">
  <div><h1>Run</h1><div class="id">${esc(runId)}</div></div>
  <div class="actions"><a class="btn primary" href="/runs/${enc(runId)}/steps">Steps view →</a></div>
</div>
<div class="stats">
  <div class="stat"><div class="k">status</div><div class="v"><span class="badge ${status}">${status}</span></div></div>
  <div class="stat"><div class="k">duration</div><div class="v">${fmtDur(total)}</div></div>
  <div class="stat"><div class="k">spans</div><div class="v">${spans.length}</div></div>
  <div class="stat"><div class="k">errors</div><div class="v">${errors}</div></div>
  ${tokStat}
  <div class="stat"><div class="k">started</div><div class="v" style="font-size:13px">${esc(new Date(nanosToMs(t0)).toLocaleString())}</div></div>
</div>`;

  const timeline = `<div class="panel">
  <h2>timeline <span class="count">${ordered.length} spans</span></h2>
  ${timelineLegend()}
  <div class="panel-body panel-scroll">${timelineSVG(runId, ordered, t0, total)}</div>
</div>`;

  const tree = `<div class="panel">
  <h2>span tree</h2>
  <div class="tree">${ordered.map((o) => treeRow(runId, o, t0, total)).join("")}</div>
</div>`;

  const graph = spec ? graphPanel(runId, spec, spans) : "";

  return shell(
    runId,
    `${crumbs([["/", "runs"], [null, shortId(runId)]])}${head}${timeline}${graph}${tree}`,
  );
}

function timelineLegend(): string {
  const item = (k: Kind, label: string) => `<span><span class="dot ${k}"></span>${label}</span>`;
  return `<div class="legend">${item("run", "run")}${item("node", "node")}${item("model", "model call")}${item("tool", "tool")}<span><span class="dot error"></span>error</span></div>`;
}

/** Render the run's spans as a clickable SVG waterfall. */
function timelineSVG(runId: string, ordered: Ordered[], t0: bigint, total: bigint): string {
  const labelW = 250;
  const barW = 760;
  const padTop = 26;
  const rowH = 26;
  const W = labelW + barW + 70;
  const H = padTop + ordered.length * rowH + 8;
  const totalNum = Number(total);
  const xOf = (ns: bigint): number => labelW + (Number(ns - t0) * barW) / totalNum;

  // Time axis: 6 evenly-spaced gridlines with relative-ms labels.
  let axis = "";
  for (let i = 0; i <= 5; i++) {
    const frac = i / 5;
    const x = labelW + frac * barW;
    const ms = (totalNum * frac) / 1e6;
    const lbl = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
    axis += `<line class="tl-grid" x1="${x.toFixed(1)}" y1="${padTop}" x2="${x.toFixed(1)}" y2="${H - 6}"/>`;
    axis += `<text class="tl-axis" x="${x.toFixed(1)}" y="${padTop - 8}" text-anchor="${i === 5 ? "end" : "middle"}">${lbl}</text>`;
  }

  let rows = "";
  ordered.forEach(({ span, depth }, i) => {
    const y = padTop + i * rowH;
    const cy = y + rowH / 2;
    const dur = spanDuration(span);
    let x = xOf(span.startTimeUnixNano);
    let w = (Number(dur) * barW) / totalNum;
    if (w < 3) w = 3;
    if (x + w > labelW + barW) x = labelW + barW - w;
    const kind = kindOf(span.name);
    const fill = span.statusCode === "error" ? "var(--err)" : KIND_FILL[kind];
    const lx = 10 + depth * 11;
    const label = esc(truncate(shortName(span.name), 30 - depth * 2));
    rows += `<a href="/runs/${enc(runId)}/spans/${enc(span.spanId)}">
  <rect class="tl-hit" x="0" y="${y}" width="${W}" height="${rowH}"/>
  <text class="tl-label" x="${lx}" y="${cy + 4}">${label}</text>
  <rect x="${x.toFixed(1)}" y="${y + (rowH - 12) / 2}" width="${w.toFixed(1)}" height="12" rx="3" fill="${fill}"><title>${esc(span.name)} — ${fmtDur(dur)}</title></rect>
  <text class="tl-dur" x="${(x + w + 6).toFixed(1)}" y="${cy + 4}">${fmtDur(dur)}</text>
</a>`;
  });

  return `<svg class="timeline" viewBox="0 0 ${W} ${H}" width="${W}" preserveAspectRatio="xMinYMin meet" role="img">${axis}${rows}</svg>`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** One row of the textual span tree, with a proportional latency bar. */
function treeRow(runId: string, { span, depth }: Ordered, t0: bigint, total: bigint): string {
  const dur = spanDuration(span);
  const kind = kindOf(span.name);
  const fill = span.statusCode === "error" ? "var(--err)" : KIND_FILL[kind];
  const totalNum = Number(total);
  const left = (Number(span.startTimeUnixNano - t0) * 100) / totalNum;
  const width = Math.max(1.5, (Number(dur) * 100) / totalNum);
  const err = span.statusCode === "error" ? `<span class="badge err">error</span>` : "";
  return `<a class="trow" href="/runs/${enc(runId)}/spans/${enc(span.spanId)}">
  <span class="nm" style="padding-left:${depth * 16}px"><span class="dot ${kind}"></span>${esc(shortName(span.name))}${spanExtras(span.attributes)}</span>
  <span class="tbar"><i style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;background:${fill}"></i></span>
  <span class="tdur">${fmtDur(dur)}</span>${err}
</a>`;
}

/** Inline key/value chips (label, node, provider, model, tokens) shown beside a span. */
function spanExtras(a: Record<string, unknown>): string {
  const bits: string[] = [];
  const push = (k: string, v: string | undefined): void => {
    if (v) bits.push(`<span class="ex"><span class="exk">${k}</span>${esc(v)}</span>`);
  };
  push("label", attrStr(a, A.label));
  push("node", attrStr(a, A.node));
  push("provider", attrStr(a, A.provider) ?? attrStr(a, A.system));
  push("model", attrStr(a, A.reqModel));
  push("tool", attrStr(a, A.toolName));
  const inT = attrNum(a, A.inTokens);
  const outT = attrNum(a, A.outTokens);
  if (inT && inT > 0) push("in", String(inT));
  if (outT && outT > 0) push("out", String(outT));
  return bits.join("");
}

/** Sum input/output token usage across a run's provider spans. */
function tokenTotals(spans: Span[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const s of spans) {
    input += attrNum(s.attributes, A.inTokens) ?? 0;
    output += attrNum(s.attributes, A.outTokens) ?? 0;
  }
  return { input, output };
}

// ── graph panel + SVG ────────────────────────────────────────────────────────────

interface NodeStat {
  dur: bigint;
  status: "ok" | "error";
}

/** Aggregate recorded duration/status for the spans belonging to a graph node. */
function nodeStat(spans: Span[], nodeName: string): NodeStat | undefined {
  let dur = 0n;
  let status: "ok" | "error" = "ok";
  let found = false;
  for (const s of spans) {
    if (s.name === SPAN.node && s.attributes[A.node] === nodeName) {
      found = true;
      dur += spanDuration(s);
      if (s.statusCode === "error") status = "error";
    }
  }
  return found ? { dur, status } : undefined;
}

function graphPanel(runId: string, spec: GraphSpec, spans: Span[]): string {
  const api = `<span class="count" style="margin-left:auto;font-size:12px">
    <a href="/api/runs/${enc(runId)}/graph/model">JSON</a> ·
    <a href="/api/runs/${enc(runId)}/graph/svg">SVG</a> ·
    <a href="/api/runs/${enc(runId)}/graph">spec</a></span>`;
  return `<div class="panel">
  <h2>graph topology${api}</h2>
  <div class="panel-body panel-scroll">${graphSVG(runId, spec, spans)}</div>
  <div class="panel-body" style="border-top:1px solid var(--border)">${topologyLists(spec)}</div>
</div>`;
}

interface Edge {
  from: string;
  to: string;
  cond: boolean;
  label: string;
}

/** Collect the full node set and flattened edge list (static + conditional) of a spec. */
function collectGraph(spec: GraphSpec): { nodes: string[]; edges: Edge[] } {
  const nodeSet = new Set<string>(spec.nodes);
  const edges: Edge[] = [];
  for (const e of spec.edges) {
    nodeSet.add(e.from);
    nodeSet.add(e.to);
    edges.push({ from: e.from, to: e.to, cond: false, label: "" });
  }
  for (const c of spec.conditional) {
    nodeSet.add(c.from);
    if (c.labels) {
      for (const [label, to] of Object.entries(c.labels)) {
        nodeSet.add(to);
        edges.push({ from: c.from, to, cond: true, label });
      }
    }
  }
  return { nodes: [...nodeSet], edges };
}

/**
 * The graph as the dashboard models it: the recorded topology enriched with each
 * node's measured duration and status. This is the same data the SVG is drawn
 * from, exposed as plain JSON so it can be rendered or analysed elsewhere.
 */
function graphModel(spec: GraphSpec, spans: Span[]) {
  const { nodes, edges } = collectGraph(spec);
  return {
    entry: spec.entry,
    nodes: nodes.map((n) => {
      const stat = nodeStat(spans, n);
      return {
        name: n,
        role: n === START ? "start" : n === END ? "end" : "node",
        entry: n === spec.entry,
        durationMs: stat ? Number(stat.dur) / 1e6 : null,
        status: stat ? stat.status : null,
      };
    }),
    edges: edges.map((e) => ({ from: e.from, to: e.to, conditional: e.cond, label: e.cond ? e.label : null })),
  };
}

/** Options controlling how {@link graphSVG} emits its SVG. */
interface GraphSVGOptions {
  /** Emit a self-contained SVG (embedded styles, no page links) for use outside the dashboard. */
  standalone?: boolean;
  /** Colour scheme for a standalone SVG. Ignored in-page, where the active page theme applies. */
  theme?: "dark" | "light";
}

/** Render the recorded graph as a layered SVG with per-node run metrics. */
function graphSVG(runId: string, spec: GraphSpec, spans: Span[], opts: GraphSVGOptions = {}): string {
  const { nodes, edges } = collectGraph(spec);

  // Longest-path layering (start sinks at layer 0). Iteration count bounds cycles.
  const layer = new Map<string, number>(nodes.map((n) => [n, 0]));
  for (let iter = 0; iter < nodes.length; iter++) {
    let changed = false;
    for (const e of edges) {
      const lu = layer.get(e.from) ?? 0;
      if ((layer.get(e.to) ?? 0) < lu + 1) {
        layer.set(e.to, lu + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const NODE_H = 42;
  const V_GAP = 100;
  const PAD = 24;
  const widthOf = (n: string): number => Math.max(96, nodeLabel(n).length * 8 + 30);

  const layers: string[][] = [];
  for (const n of nodes) {
    const L = layer.get(n) ?? 0;
    (layers[L] ??= []).push(n);
  }
  const maxPer = Math.max(1, ...layers.map((a) => a?.length ?? 0));
  const maxNodeW = Math.max(96, ...nodes.map(widthOf));
  const CW = Math.max(720, maxPer * (maxNodeW + 56));
  const CH = PAD * 2 + Math.max(0, layers.length - 1) * V_GAP + NODE_H;

  const pos = new Map<string, { cx: number; cy: number; w: number }>();
  layers.forEach((arr, L) => {
    if (!arr) return;
    const m = arr.length;
    arr.forEach((n, i) => {
      pos.set(n, { cx: (CW * (i + 0.5)) / m, cy: PAD + NODE_H / 2 + L * V_GAP, w: widthOf(n) });
    });
  });

  let edgeSvg = "";
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.cx;
    const y1 = a.cy + NODE_H / 2;
    const x2 = b.cx;
    const y2 = b.cy - NODE_H / 2;
    const my = (y1 + y2) / 2;
    const d = `M${x1.toFixed(1)},${y1.toFixed(1)} C${x1.toFixed(1)},${my.toFixed(1)} ${x2.toFixed(1)},${my.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
    edgeSvg += `<path class="edge${e.cond ? " cond" : ""}" d="${d}" marker-end="url(#gv-arrow)"/>`;
    if (e.cond && e.label) {
      edgeSvg += `<text class="edge-label" x="${((x1 + x2) / 2).toFixed(1)}" y="${my.toFixed(1)}">${esc(e.label)}</text>`;
    }
  }

  let nodeSvg = "";
  for (const n of nodes) {
    const p = pos.get(n);
    if (!p) continue;
    const term = n === START || n === END;
    const entry = n === spec.entry;
    const stat = nodeStat(spans, n);
    const cls = ["gnode"];
    if (term) cls.push("term");
    if (entry) cls.push("entry");
    if (stat?.status === "error") cls.push("err");
    const x = p.cx - p.w / 2;
    const y = p.cy - NODE_H / 2;
    const sub = stat ? fmtDur(stat.dur) : "";
    const tip = stat ? `${n} — ${fmtDur(stat.dur)} (${stat.status})` : n;
    // Link nodes to their step in-page; standalone SVGs carry no page links.
    const linkable = !opts.standalone && !!stat;
    const open = linkable
      ? `<a href="/runs/${enc(runId)}/steps#step-${enc(n)}" class="${cls.join(" ")}">`
      : `<g class="${cls.join(" ")}">`;
    const close = linkable ? "</a>" : "</g>";
    const labelY = sub ? p.cy - 2 : p.cy + 4;
    nodeSvg += `${open}
  <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${p.w}" height="${NODE_H}" rx="10"/>
  <text class="gnode-label" x="${p.cx.toFixed(1)}" y="${labelY.toFixed(1)}">${esc(nodeLabel(n))}</text>
  ${sub ? `<text class="gnode-sub" x="${p.cx.toFixed(1)}" y="${(p.cy + 14).toFixed(1)}">${esc(sub)}</text>` : ""}
  <title>${esc(tip)}</title>
${close}`;
  }

  const defs = `<defs><marker id="gv-arrow" markerWidth="9" markerHeight="9" refX="7.5" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path class="arrow" d="M0,0 L7,3 L0,6 z"/></marker></defs>`;
  const style = opts.standalone ? graphStyleBlock(opts.theme ?? "light") : "";
  const ns = opts.standalone ? ` xmlns="http://www.w3.org/2000/svg"` : "";
  return `<svg class="graph"${ns} viewBox="0 0 ${CW.toFixed(0)} ${CH.toFixed(0)}" width="${CW.toFixed(0)}" preserveAspectRatio="xMinYMin meet" role="img">${style}${defs}${edgeSvg}${nodeSvg}</svg>`;
}

/** Embedded stylesheet for a standalone graph SVG (concrete colours, no CSS variables). */
function graphStyleBlock(theme: "dark" | "light"): string {
  const c = theme === "light"
    ? { edge: "#80868b", cond: "#5f6368", nodeFill: "#ffffff", nodeStroke: "#9aa0a6", termFill: "#f1f3f4", entryStroke: "#0b57d0", entryFill: "#e8f0fe", err: "#c5221f", label: "#1f1f1f", sub: "#5f6368", elabel: "#6f7378" }
    : { edge: "#5b636f", cond: "#9aa0a6", nodeFill: "#2d2f31", nodeStroke: "#454a52", termFill: "#28292b", entryStroke: "#8ab4f8", entryFill: "rgba(138,180,248,.14)", err: "#f28b82", label: "#e3e3e3", sub: "#9aa0a6", elabel: "#9aa0a6" };
  return `<style>
.graph{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;}
.graph .edge{fill:none;stroke:${c.edge};stroke-width:1.7;}
.graph .edge.cond{stroke-dasharray:5 4;stroke:${c.cond};}
.graph .arrow{fill:${c.edge};}
.graph .edge-label{fill:${c.elabel};font-size:10px;text-anchor:middle;}
.graph .gnode rect{fill:${c.nodeFill};stroke:${c.nodeStroke};stroke-width:1.5;}
.graph .gnode.term rect{fill:${c.termFill};stroke:${c.cond};}
.graph .gnode.entry rect{stroke:${c.entryStroke};fill:${c.entryFill};}
.graph .gnode.err rect{stroke:${c.err};}
.graph .gnode-label{fill:${c.label};font-size:12px;font-weight:600;text-anchor:middle;}
.graph .gnode-sub{fill:${c.sub};font-size:10px;text-anchor:middle;font-family:ui-monospace,Menlo,monospace;}
</style>`;
}

/** Textual node/edge listing beneath the graph SVG. */
function topologyLists(spec: GraphSpec): string {
  const nodes = spec.nodes.length === 0
    ? `<li class="muted">(none)</li>`
    : spec.nodes.map((n) => `<li>${esc(n)}${n === spec.entry ? ` <span class="subtle">(entry)</span>` : ""}</li>`).join("");
  const staticEdges = spec.edges.map((e) => `<li>${esc(nodeLabel(e.from))} → ${esc(nodeLabel(e.to))}</li>`).join("");
  const condEdges = spec.conditional
    .map((c) => {
      if (!c.labels) return `<li>${esc(nodeLabel(c.from))} → <span class="subtle">(router)</span></li>`;
      const labels = Object.entries(c.labels).map(([l, to]) => `${esc(l)}:${esc(nodeLabel(to))}`).join(", ");
      return `<li>${esc(nodeLabel(c.from))} → <span class="subtle">{${labels}}</span></li>`;
    })
    .join("");
  const edges = staticEdges + condEdges || `<li class="muted">(none)</li>`;
  return `<div class="topo">
  <div><h3>nodes</h3><ul>${nodes}</ul></div>
  <div><h3>edges</h3><ul>${edges}</ul></div>
</div>`;
}

// ── span detail page ─────────────────────────────────────────────────────────────

function spanDetailPage(store: Store, runId: string, spanId: string): string {
  const span = findSpan(store, runId, spanId);
  if (!span) {
    return shell(
      "span",
      `${crumbs([["/", "runs"], [`/runs/${enc(runId)}`, shortId(runId)], [null, "span"]])}<div class="panel"><div class="empty">Span not found.</div></div>`,
    );
  }
  const dur = spanDuration(span);
  const kind = kindOf(span.name);
  const status = span.statusCode === "error" ? "error" : span.statusCode === "ok" ? "ok" : "unset";

  const head = `<div class="page-head">
  <div><h1><span class="dot ${kind}"></span> ${esc(shortName(span.name))}</h1><div class="id">${esc(span.spanId)}</div></div>
</div>`;

  const cell = (k: string, v: string) => `<div class="cell"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const parentLink = span.parentSpanId
    ? `<a href="/runs/${enc(runId)}/spans/${enc(span.parentSpanId)}">${esc(shortId(span.parentSpanId))}</a>`
    : `<span class="subtle">(root)</span>`;
  const meta = `<div class="meta">
  ${cell("status", status === "unset" ? `<span class="subtle">unset</span>` : `<span class="badge ${status}">${status}</span>`)}
  ${cell("duration", fmtDur(dur))}
  ${cell("started", esc(new Date(nanosToMs(span.startTimeUnixNano)).toLocaleString()))}
  ${cell("parent", parentLink)}
  ${cell("trace", esc(shortId(span.traceId)))}
  ${span.statusMessage ? cell("message", esc(span.statusMessage)) : ""}
</div>`;

  const modelPanel = modelCallPanel(span);
  const messages = messagesPanel(span);
  const toolPanel = toolIOPanel(span);
  const attrs = attributesPanel(span);
  const events = eventsPanel(span);

  return shell(
    span.name,
    `${crumbs([["/", "runs"], [`/runs/${enc(runId)}`, shortId(runId)], [null, "span"]])}${head}
<div class="panel"><div class="panel-body">${meta}</div></div>${modelPanel}${messages}${toolPanel}${attrs}${events}`,
  );
}

/** Provider/model/token summary for a provider span (empty for other spans). */
function modelCallPanel(span: Span): string {
  const a = span.attributes;
  const provider = attrStr(a, A.provider) ?? attrStr(a, A.system);
  const reqModel = attrStr(a, A.reqModel);
  const respModel = attrStr(a, A.respModel);
  if (!provider && !reqModel && !respModel) return "";
  const inT = attrNum(a, A.inTokens);
  const outT = attrNum(a, A.outTokens);
  const finish = attrStr(a, A.finish);
  const streaming = a[A.streaming];
  const cell = (k: string, v: string | undefined): string =>
    v !== undefined && v !== "" ? `<div class="cell"><div class="k">${k}</div><div class="v">${v}</div></div>` : "";
  const total = inT !== undefined || outT !== undefined ? String((inT ?? 0) + (outT ?? 0)) : undefined;
  return `<div class="panel"><h2>model call</h2><div class="panel-body"><div class="meta">
  ${cell("provider", provider ? esc(provider) : undefined)}
  ${cell("request model", reqModel ? esc(reqModel) : undefined)}
  ${cell("response model", respModel ? esc(respModel) : undefined)}
  ${cell("input tokens", inT !== undefined ? String(inT) : undefined)}
  ${cell("output tokens", outT !== undefined ? String(outT) : undefined)}
  ${cell("total tokens", total)}
  ${cell("finish reason", finish ? esc(finish) : undefined)}
  ${cell("streaming", typeof streaming === "boolean" ? String(streaming) : undefined)}
</div></div></div>`;
}

/** Parse `gen_ai.prompt` / `gen_ai.completion` into message arrays. */
function parseMessages(raw: string | undefined): Message[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as Message[]) : [v as Message];
  } catch {
    return [];
  }
}

/** Render a single captured message (text, reasoning, tool calls). */
function renderMessage(m: Message): string {
  const role = String((m as { role?: string }).role ?? "?");
  let body = "";
  for (const p of m.content ?? []) {
    if (p.type === "text" && p.text) body += `<pre class="text">${esc(p.text)}</pre>`;
    else if ((p.type === "thinking" || p.type === "redacted_thinking") && p.text)
      body += `<details class="reason"><summary>reasoning</summary><pre>${esc(p.text)}</pre></details>`;
    else if (p.type === "image") body += `<div class="muted">[image]</div>`;
  }
  // Tool calls may arrive as `toolCalls` or the snake_case `tool_calls`.
  const toolCalls = m.toolCalls ?? (m as { tool_calls?: Message["toolCalls"] }).tool_calls ?? [];
  for (const tc of toolCalls) {
    let args = "";
    try {
      args = JSON.stringify(tc.arguments);
    } catch {
      args = String(tc.arguments);
    }
    body += `<div class="toolcall">→ <span class="tname">${esc(tc.name)}</span>(<code>${esc(truncate(args, 400))}</code>)</div>`;
  }
  if (!body) body = `<div class="muted">(empty)</div>`;
  return `<div class="msg ${esc(role)}"><div class="msg-role">${esc(role)}</div><div class="msg-body">${body}</div></div>`;
}

/** Side-by-side prompt/completion panel when content was captured. */
function messagesPanel(span: Span): string {
  const prompt = parseMessages(attrStr(span.attributes, A.prompt));
  const completion = parseMessages(attrStr(span.attributes, A.completion));
  const reasoning = parseReasoning(attrStr(span.attributes, A.reasoning));
  if (prompt.length === 0 && completion.length === 0 && reasoning.length === 0) return "";

  const left = prompt.length
    ? prompt.map(renderMessage).join("")
    : `<div class="muted">(no prompt captured)</div>`;
  let right = completion.length ? completion.map(renderMessage).join("") : "";
  if (reasoning.length) {
    right += `<details class="reason" open><summary>reasoning (${reasoning.length})</summary>${reasoning.map((r) => `<pre>${esc(r)}</pre>`).join("")}</details>`;
  }
  if (!right) right = `<div class="muted">(no completion captured)</div>`;

  return `<div class="panel">
  <h2>messages</h2>
  <div class="panel-body"><div class="msgs">
    <div class="msgcol"><h3>prompt → API</h3>${left}</div>
    <div class="msgcol"><h3>completion ← API</h3>${right}</div>
  </div></div>
</div>`;
}

function parseReasoning(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [String(v)];
  } catch {
    return [raw];
  }
}

/** Tool-call summary (name + input/output sizes) for tool spans. */
function toolIOPanel(span: Span): string {
  const name = attrStr(span.attributes, A.toolName);
  if (!name) return "";
  const inB = attrNum(span.attributes, A.toolIn);
  const outB = attrNum(span.attributes, A.toolOut);
  return `<div class="panel">
  <h2>tool call</h2>
  <div class="panel-body"><div class="meta">
    <div class="cell"><div class="k">tool</div><div class="v">${esc(name)}</div></div>
    <div class="cell"><div class="k">input size</div><div class="v">${inB ?? "—"} bytes</div></div>
    <div class="cell"><div class="k">output size</div><div class="v">${outB ?? "—"} bytes</div></div>
  </div></div>
</div>`;
}

/** Full attribute table (content attributes are shown in their own panels). */
function attributesPanel(span: Span): string {
  const hidden = new Set<string>([A.prompt, A.completion, A.reasoning]);
  const entries = Object.entries(span.attributes).filter(([k]) => !hidden.has(k)).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  const rows = entries
    .map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="mono">${esc(truncate(fmtVal(v), 600))}</td></tr>`)
    .join("");
  return `<div class="panel panel-scroll">
  <h2>attributes <span class="count">${entries.length}</span></h2>
  <table><tbody>${rows}</tbody></table>
</div>`;
}

function eventsPanel(span: Span): string {
  if (span.events.length === 0) return "";
  const rows = span.events
    .map((e) => `<tr><td class="mono">${esc(e.name)}</td><td class="muted">${esc(new Date(nanosToMs(e.timeUnixNano)).toISOString())}</td></tr>`)
    .join("");
  return `<div class="panel panel-scroll"><h2>events <span class="count">${span.events.length}</span></h2><table><tbody>${rows}</tbody></table></div>`;
}

// ── steps page ───────────────────────────────────────────────────────────────────

function stepsPage(store: Store, runId: string): string {
  const spans = store.spansForRun(runId);
  if (spans.length === 0) {
    return shell(
      runId,
      `${crumbs([["/", "runs"], [`/runs/${enc(runId)}`, shortId(runId)], [null, "steps"]])}<div class="panel"><div class="empty">No spans for this run.</div></div>`,
    );
  }
  const byParent = new Map<string, Span[]>();
  for (const s of spans) {
    const arr = byParent.get(s.parentSpanId) ?? [];
    arr.push(s);
    byParent.set(s.parentSpanId, arr);
  }
  const cmp = (a: Span, b: Span): number =>
    a.startTimeUnixNano < b.startTimeUnixNano ? -1 : a.startTimeUnixNano > b.startTimeUnixNano ? 1 : 0;

  const nodeSpans = spans.filter((s) => s.name === SPAN.node).sort(cmp);
  const anyCaptured = spans.some((s) => s.name === SPAN.generate || s.name === SPAN.stream
    ? attrStr(s.attributes, A.prompt) !== undefined
    : false);

  const replayHint = anyCaptured
    ? ""
    : `<div class="banner">No prompts/completions were captured for this run. Re-run with content capture enabled — <code>instrumentProvider(provider, tracer, { captureContent: true })</code> — to see what is sent to and received from the API here.</div>`;

  const head = `<div class="page-head">
  <div><h1>Steps</h1><div class="id">${esc(runId)}</div></div>
  <div class="actions"><a class="btn" href="/runs/${enc(runId)}">← run detail</a></div>
</div>`;

  let cards = "";
  if (nodeSpans.length === 0) {
    // No graph-node spans: fall back to listing model/tool calls flatly.
    const calls = spans.filter((s) => s.name !== SPAN.run).sort(cmp);
    cards = `<div class="step"><div class="step-body">${calls.map((s) => callCard(runId, s)).join("") || `<div class="empty">No calls recorded.</div>`}</div></div>`;
  } else {
    cards = nodeSpans
      .map((node, i) => {
        const nodeName = attrStr(node.attributes, A.node) ?? attrStr(node.attributes, A.label) ?? `step ${i + 1}`;
        const children = (byParent.get(node.spanId) ?? []).sort(cmp);
        const status = node.statusCode === "error" ? "error" : "ok";
        const inner = children.length
          ? children.map((c) => callCard(runId, c)).join("")
          : `<div class="hint">No provider or tool calls in this step.</div>`;
        return `<div class="step" id="step-${esc(nodeName)}">
  <div class="step-head"><span class="n">${i + 1}</span><span class="nm">${esc(nodeName)}</span>
    <span class="badge ${status}">${status}</span>
    <span class="meta-inline">${fmtDur(spanDuration(node))}</span></div>
  <div class="step-body">${inner}</div>
</div>`;
      })
      .join("");
  }

  return shell(
    runId,
    `${crumbs([["/", "runs"], [`/runs/${enc(runId)}`, shortId(runId)], [null, "steps"]])}${replayHint}${head}${cards}`,
  );
}

/** Render a provider or tool call inside a step card. */
function callCard(runId: string, span: Span): string {
  const link = `/runs/${enc(runId)}/spans/${enc(span.spanId)}`;
  if (span.name === SPAN.generate || span.name === SPAN.stream) {
    const model = attrStr(span.attributes, A.respModel) ?? attrStr(span.attributes, A.reqModel) ?? "model";
    const provider = attrStr(span.attributes, A.provider) ?? attrStr(span.attributes, A.system);
    const finish = attrStr(span.attributes, A.finish);
    const inTok = attrNum(span.attributes, A.inTokens);
    const outTok = attrNum(span.attributes, A.outTokens);
    const tokens = inTok !== undefined || outTok !== undefined ? ` · in ${inTok ?? "?"} / out ${outTok ?? "?"} tok` : "";
    const tail = `${tokens}${finish ? ` · ${esc(finish)}` : ""}`;
    const provLabel = provider ? `<span class="subtle">${esc(provider)}</span> ` : "";
    const prompt = parseMessages(attrStr(span.attributes, A.prompt));
    const completion = parseMessages(attrStr(span.attributes, A.completion));
    const reasoning = parseReasoning(attrStr(span.attributes, A.reasoning));
    let content = "";
    if (prompt.length || completion.length || reasoning.length) {
      const left = prompt.length ? prompt.map(renderMessage).join("") : `<div class="muted">(no prompt)</div>`;
      let right = completion.map(renderMessage).join("");
      if (reasoning.length) right += `<details class="reason"><summary>reasoning</summary>${reasoning.map((r) => `<pre>${esc(r)}</pre>`).join("")}</details>`;
      if (!right) right = `<div class="muted">(no completion)</div>`;
      content = `<div class="msgs"><div class="msgcol"><h3>prompt → API</h3>${left}</div><div class="msgcol"><h3>completion ← API</h3>${right}</div></div>`;
    } else {
      content = `<div class="hint">No captured content. <a href="${link}">span details →</a></div>`;
    }
    return `<div class="call">
  <div class="call-head"><span class="kind model">model call</span>${provLabel}<a href="${link}">${esc(model)}</a><span class="meta-inline">${fmtDur(spanDuration(span))}${tail}</span></div>
  ${content}
</div>`;
  }
  if (span.name === SPAN.tool) {
    const name = attrStr(span.attributes, A.toolName) ?? shortName(span.name);
    const inB = attrNum(span.attributes, A.toolIn);
    const outB = attrNum(span.attributes, A.toolOut);
    const sizes = `in ${inB ?? "?"}B / out ${outB ?? "?"}B`;
    const err = span.statusCode === "error" ? ` <span class="badge err">error</span>` : "";
    return `<div class="call">
  <div class="call-head"><span class="kind tool">tool</span><a href="${link}">${esc(name)}</a>${err}<span class="meta-inline">${fmtDur(spanDuration(span))} · ${sizes}</span></div>
</div>`;
  }
  // Any other nested span: a compact line.
  return `<div class="call"><div class="call-head"><span class="kind tool">${esc(shortName(span.name))}</span><a href="${link}">details</a><span class="meta-inline">${fmtDur(spanDuration(span))}</span></div></div>`;
}

// ── shared bits ──────────────────────────────────────────────────────────────────

/** Render a breadcrumb trail; a `null` href makes the segment plain text. */
function crumbs(items: Array<[string | null, string]>): string {
  const parts = items.map(([href, label]) =>
    href ? `<a href="${href}">${esc(label)}</a>` : `<span>${esc(label)}</span>`,
  );
  return `<div class="crumbs">${parts.join(`<span class="sep">/</span>`)}</div>`;
}
