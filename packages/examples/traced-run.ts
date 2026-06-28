/**
 * Tracing a graph run end to end, then reading the spans back.
 *
 * Run it:
 *
 *   bun packages/examples/traced-run.ts
 *
 * `setupTracing(":memory:")` wires an OpenTelemetry tracer to an in-memory
 * SQLite span store. We wrap a provider with `instrumentProvider` so every
 * model call emits a span, run a two-node graph with `traceHooks` so the run
 * and each node emit spans too, and then query the same store to reconstruct
 * and print the span tree:
 *
 *   galdor.graph.run
 *   ├── galdor.graph.node (research)
 *   │   └── galdor.provider.generate
 *   └── galdor.graph.node (summarize)
 *       └── galdor.provider.generate
 *
 * No collector and no network are involved — the spans live entirely in process.
 */

import {
  setupTracing,
  instrumentProvider,
  traceHooks,
} from "@galdor/core/observability";
import { Graph, START, END } from "@galdor/core/graph";
import { TestProvider } from "@galdor/core/testprovider";
import { userMessage, messageText } from "@galdor/core/schema";
import { spanDuration, runStatus, type Span } from "@galdor/core/store";

interface TraceState {
  topic: string;
  draft: string;
  summary: string;
}

const tracing = setupTracing(":memory:");
const runId = "trace-demo";

try {
  // A scripted provider, wrapped so each generate() call is traced.
  const base = new TestProvider({
    responses: [
      "Quito is the high-altitude capital of Ecuador, in the Andes.",
      "Quito: Ecuador's Andean capital.",
    ],
  });
  const provider = instrumentProvider(base, tracing.tracer, { captureContent: true });

  // Each node makes one model call, passing ctx through so the provider span
  // nests under the node span (which nests under the run span).
  const graph = new Graph<TraceState>()
    .addNode("research", async (s, ctx) => {
      const resp = await provider.generate(
        { model: "demo", messages: [userMessage(`Tell me about ${s.topic}.`)] },
        ctx,
      );
      return { ...s, draft: messageText(resp.message) };
    })
    .addNode("summarize", async (s, ctx) => {
      const resp = await provider.generate(
        { model: "demo", messages: [userMessage(`Summarize in one line: ${s.draft}`)] },
        ctx,
      );
      return { ...s, summary: messageText(resp.message) };
    })
    .addEdge(START, "research")
    .addEdge("research", "summarize")
    .addEdge("summarize", END)
    .compile();

  const final = await graph.invoke(
    { topic: "Quito", draft: "", summary: "" },
    { runId, hooks: traceHooks(tracing.tracer) },
  );

  console.log("=== run output ===");
  console.log("summary:", final.summary);
  console.log();

  // Read the persisted spans straight back out of the store.
  const [run] = tracing.store.listRuns();
  console.log("=== run summary ===");
  if (run) {
    console.log("runId  :", run.runId);
    console.log("spans  :", run.spanCount);
    console.log("status :", runStatus(run));
  }
  console.log();

  console.log("=== span tree ===");
  printTree(tracing.store.spansForRun(runId));
} finally {
  await tracing.shutdown();
}

/** Print spans as an indented tree, parents before their children. */
function printTree(spans: Span[]): void {
  const childrenOf = new Map<string, Span[]>();
  const ids = new Set(spans.map((s) => s.spanId));
  for (const s of spans) {
    // A span whose parent is absent from this run is treated as a root.
    const key = s.parentSpanId && ids.has(s.parentSpanId) ? s.parentSpanId : "";
    const list = childrenOf.get(key) ?? [];
    list.push(s);
    childrenOf.set(key, list);
  }

  const walk = (parentId: string, depth: number): void => {
    for (const s of childrenOf.get(parentId) ?? []) {
      const ms = Number(spanDuration(s)) / 1e6;
      console.log(`${"  ".repeat(depth)}- ${s.name} (${ms.toFixed(2)}ms, ${s.statusCode})`);
      walk(s.spanId, depth + 1);
    }
  };
  walk("", 0);
}
