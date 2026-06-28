#!/usr/bin/env bun
/**
 * Write a few demo runs to a span store so `galdor scry` / `galdor ui` have
 * something to show. Uses the in-process scripted provider — no API key needed.
 *
 *   bun scripts/seed-traces.ts ./traces.db
 */
import * as core from "@galdor/core";

const db = process.argv[2] ?? "./traces.db";
const tracing = core.observability.setupTracing(db, { checkpointIntervalMs: 0 });

interface S {
  out: string;
}

for (let i = 1; i <= 3; i++) {
  const provider = core.observability.instrumentProvider(
    new core.testprovider.TestProvider({ responses: [`Demo answer #${i}`] }),
    tracing.tracer,
    { captureContent: true },
  );
  const graph = new core.graph.Graph<S>()
    .addNode("model", async (s, ctx) => {
      const resp = await provider.generate({ model: "demo", messages: [core.schema.userMessage(`question ${i}`)] }, ctx);
      return { ...s, out: core.schema.messageText(resp.message) };
    })
    .addEdge(core.graph.START, "model")
    .addEdge("model", core.graph.END)
    .compile();

  const hooks = core.graph.mergeHooks(
    core.observability.traceHooks(tracing.tracer),
    core.observability.recordGraphSpec(tracing.store, graph),
  );
  await graph.invoke({ out: "" }, { runId: `demo-run-${i}`, hooks });
}

await tracing.shutdown();
console.log(`wrote 3 demo runs to ${db}`);
