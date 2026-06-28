import { afterEach, describe, expect, test } from "bun:test";
import { type Span, Store } from "@galdor/core/store";
import { createHandler, startDashboard } from "./index.ts";

const span = (over: Partial<Span> = {}): Span => ({
  spanId: "s",
  traceId: "t",
  parentSpanId: "",
  name: "galdor.graph.run",
  startTimeUnixNano: 1_700_000_000_000_000_000n,
  endTimeUnixNano: 1_700_000_000_400_000_000n,
  statusCode: "ok",
  statusMessage: "",
  attributes: {},
  events: [],
  runId: "",
  ...over,
});

function seededStore(): Store {
  const st = Store.open(":memory:");
  st.insertSpans([
    span({ spanId: "root", traceId: "t1", runId: "run-1", name: "galdor.graph.run" }),
    span({ spanId: "node", traceId: "t1", parentSpanId: "root", name: "galdor.graph.node" }),
    span({ spanId: "gen", traceId: "t1", parentSpanId: "node", name: "galdor.provider.generate", statusCode: "error" }),
  ]);
  return st;
}

let server: ReturnType<typeof startDashboard> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("dashboard handler", () => {
  test("serves the run list HTML", () => {
    const h = createHandler(seededStore());
    const res = h(new Request("http://x/"));
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("/api/runs returns run summaries with ms durations", async () => {
    const h = createHandler(seededStore());
    const runs = (await h(new Request("http://x/api/runs")).json()) as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("run-1");
    expect(runs[0]?.spanCount).toBe(3);
    expect(runs[0]?.status).toBe("error"); // a child span errored
    expect(runs[0]?.durationMs).toBe(400);
  });

  test("/api/runs/:id/spans returns the span tree", async () => {
    const h = createHandler(seededStore());
    const spans = (await h(new Request("http://x/api/runs/run-1/spans")).json()) as Array<Record<string, unknown>>;
    expect(spans.map((s) => s.name)).toContain("galdor.provider.generate");
  });

  test("/api/orphans reports spans with no run id", async () => {
    const st = Store.open(":memory:");
    st.insertSpans([span({ spanId: "x", traceId: "torph", runId: "" })]);
    const h = createHandler(st);
    const body = (await h(new Request("http://x/api/orphans")).json()) as { orphans: number };
    expect(body.orphans).toBe(1);
  });

  test("/api/runs/:id/graph returns the recorded topology", async () => {
    const st = seededStore();
    const spec = {
      entry: "first",
      nodes: ["first", "second"],
      edges: [{ from: "first", to: "second" }],
      conditional: [{ from: "second" }],
    };
    st.setGraphSpec("run-1", JSON.stringify(spec));
    const h = createHandler(st);
    const body = (await h(new Request("http://x/api/runs/run-1/graph")).json()) as typeof spec;
    expect(body.entry).toBe("first");
    expect(body.nodes).toEqual(["first", "second"]);
    expect(body.edges).toEqual([{ from: "first", to: "second" }]);
  });

  test("/api/runs/:id/graph 404s when no topology was recorded", () => {
    const h = createHandler(seededStore());
    const res = h(new Request("http://x/api/runs/run-1/graph"));
    expect(res.status).toBe(404);
  });

  test("/api/runs/:id/graph/model enriches nodes with measured duration and status", async () => {
    const st = seededStore();
    st.insertSpans([
      span({ spanId: "nf", traceId: "t1", runId: "run-1", parentSpanId: "root", name: "galdor.graph.node", attributes: { "galdor.node.name": "first" } }),
    ]);
    st.setGraphSpec("run-1", JSON.stringify({ entry: "first", nodes: ["first", "second"], edges: [{ from: "first", to: "second" }], conditional: [{ from: "second", labels: { ok: "first" } }] }));
    const model = (await createHandler(st)(new Request("http://x/api/runs/run-1/graph/model")).json()) as {
      entry: string;
      nodes: Array<{ name: string; entry: boolean; durationMs: number | null; status: string | null }>;
      edges: Array<{ from: string; to: string; conditional: boolean; label: string | null }>;
    };
    expect(model.entry).toBe("first");
    const first = model.nodes.find((n) => n.name === "first")!;
    expect(first.entry).toBe(true);
    expect(first.durationMs).toBeGreaterThan(0);
    expect(first.status).toBe("ok");
    expect(model.edges).toContainEqual({ from: "first", to: "second", conditional: false, label: null });
    expect(model.edges).toContainEqual({ from: "second", to: "first", conditional: true, label: "ok" });
  });

  test("/api/runs/:id/graph/svg returns a self-contained themed SVG", async () => {
    const st = seededStore();
    st.setGraphSpec("run-1", JSON.stringify({ entry: "a", nodes: ["a"], edges: [], conditional: [] }));
    const res = createHandler(st)(new Request("http://x/api/runs/run-1/graph/svg?theme=light"));
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    const body = await res.text();
    expect(body).toContain("<svg");
    expect(body).toContain("<style>"); // embedded styles → usable outside the dashboard
    expect(body).toContain("xmlns=");
  });

  test("/api/runs/:id/graph/svg 404s without a recorded spec", () => {
    const h = createHandler(seededStore());
    expect(h(new Request("http://x/api/runs/run-1/graph/svg")).status).toBe(404);
  });

  test("run detail page shows the topology when a spec exists", async () => {
    const st = seededStore();
    st.setGraphSpec(
      "run-1",
      JSON.stringify({ entry: "first", nodes: ["first", "second"], edges: [{ from: "first", to: "second" }], conditional: [] }),
    );
    const h = createHandler(st);
    const bodyHtml = await h(new Request("http://x/runs/run-1")).text();
    expect(bodyHtml).toContain("graph topology");
    expect(bodyHtml).toContain("first → second");
  });

  test("end-to-end over a real ephemeral server", async () => {
    server = startDashboard({ store: seededStore(), port: 0 });
    await server.ready;
    const res = await fetch(`http://127.0.0.1:${server.port}/api/runs`);
    const runs = (await res.json()) as unknown[];
    expect(runs).toHaveLength(1);
  });

  test("ready resolves and the ephemeral port is then bound", async () => {
    server = startDashboard({ store: seededStore(), port: 0 });
    await server.ready;
    expect(server.port).toBeGreaterThan(0);
  });

  test("run detail page renders the timeline and span tree", async () => {
    const h = createHandler(seededStore());
    const body = await h(new Request("http://x/runs/run-1")).text();
    expect(body).toContain('class="timeline"');
    expect(body).toContain("span tree");
    expect(body).toContain('href="/runs/run-1/steps"');
  });

  test("/api/runs/:id/spans/:spanId returns one span with attributes", async () => {
    const h = createHandler(seededStore());
    const s = (await h(new Request("http://x/api/runs/run-1/spans/gen")).json()) as Record<string, unknown>;
    expect(s.spanId).toBe("gen");
    expect(s.name).toBe("galdor.provider.generate");
    expect(s.statusCode).toBe("error");
  });

  test("/api/runs/:id/spans/:spanId 404s for an unknown span", () => {
    const h = createHandler(seededStore());
    expect(h(new Request("http://x/api/runs/run-1/spans/nope")).status).toBe(404);
  });

  test("span detail page shows captured prompt and completion", async () => {
    const st = Store.open(":memory:");
    st.insertSpans([
      span({ spanId: "root", traceId: "t1", runId: "run-1", name: "galdor.graph.run" }),
      span({
        spanId: "gen",
        traceId: "t1",
        runId: "run-1",
        parentSpanId: "root",
        name: "galdor.provider.generate",
        attributes: {
          "gen_ai.request.model": "demo-model",
          "gen_ai.prompt": JSON.stringify([{ role: "user", content: [{ type: "text", text: "ping" }] }]),
          "gen_ai.completion": JSON.stringify({ role: "assistant", content: [{ type: "text", text: "pong" }] }),
        },
      }),
    ]);
    const body = await createHandler(st)(new Request("http://x/runs/run-1/spans/gen")).text();
    expect(body).toContain("messages");
    expect(body).toContain("demo-model");
    expect(body).toContain("ping");
    expect(body).toContain("pong");
  });

  test("renders a peer-format trace: alternate graph spec, snake_case tool_calls, tokens", async () => {
    const st = Store.open(":memory:");
    st.insertSpans([
      span({ spanId: "root", traceId: "t1", runId: "run-1", name: "galdor.graph.run" }),
      span({
        spanId: "gen",
        traceId: "t1",
        runId: "run-1",
        parentSpanId: "root",
        name: "galdor.provider.generate",
        attributes: {
          "gen_ai.system": "anthropic",
          "galdor.provider.name": "anthropic",
          "gen_ai.request.model": "claude-3-5-sonnet",
          "gen_ai.response.model": "claude-3-5-sonnet",
          "gen_ai.usage.input_tokens": 250,
          "gen_ai.usage.output_tokens": 180,
          "gen_ai.response.finish_reasons": "end_turn",
          "gen_ai.prompt": JSON.stringify([{ role: "assistant", content: [], tool_calls: [{ id: "c1", name: "search", arguments: { q: "x" } }] }]),
        },
      }),
    ]);
    // A graph spec in the alternate encoding: object nodes, static_edges, conditional_edges/branches.
    st.setGraphSpec(
      "run-1",
      JSON.stringify({
        entry: "model",
        nodes: [{ name: "model", interrupt: false }, { name: "tools" }],
        static_edges: [{ from: "__start__", to: "model" }, { from: "model", to: "tools" }],
        conditional_edges: [{ from: "tools", branches: [{ label: "again", to: "model" }] }],
      }),
    );
    const h = createHandler(st);

    const run = await h(new Request("http://x/runs/run-1")).text();
    expect(run).toContain("graph topology");
    expect(run).toContain("anthropic"); // provider chip in the tree
    expect(run).toContain("claude-3-5-sonnet"); // model chip
    expect(run).toContain("tokens"); // run-level token total
    expect(run).toContain("start → model"); // normalized static_edges

    const model = (await h(new Request("http://x/api/runs/run-1/graph/model")).json()) as {
      nodes: Array<{ name: string }>;
      edges: Array<{ from: string; to: string; conditional: boolean; label: string | null }>;
    };
    expect(model.nodes.map((n) => n.name).sort()).toEqual(["__start__", "model", "tools"]);
    expect(model.edges).toContainEqual({ from: "model", to: "tools", conditional: false, label: null });
    expect(model.edges).toContainEqual({ from: "tools", to: "model", conditional: true, label: "again" });

    const spanPage = await h(new Request("http://x/runs/run-1/spans/gen")).text();
    expect(spanPage).toContain("model call");
    expect(spanPage).toContain("end_turn"); // finish reason
    expect(spanPage).toContain("250"); // input tokens
    expect(spanPage).toContain("search"); // snake_case tool_calls rendered
  });

  test("every page ships the theme toggle and a flash-free theme bootstrap", async () => {
    const h = createHandler(seededStore());
    const body = await h(new Request("http://x/")).text();
    expect(body).toContain('id="theme-toggle"');
    expect(body).toContain("galdor-theme"); // localStorage key
    expect(body).toContain("prefers-color-scheme"); // system-preference fallback
    expect(body).toContain('data-theme="light"'); // the light palette is defined
  });

  test("steps page lists graph nodes and hints when no content was captured", async () => {
    const h = createHandler(seededStore());
    const body = await h(new Request("http://x/runs/run-1/steps")).text();
    expect(body).toContain("Steps");
    expect(body).toContain("captureContent"); // replay hint, since the seed captures nothing
  });
});
