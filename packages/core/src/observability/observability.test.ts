/**
 * Tests for the tracing pipeline: a graph run instrumented end to end should
 * produce nested run -> node -> provider spans, all grouped under one run id.
 */

import { describe, expect, test } from "bun:test";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Tracer } from "@opentelemetry/api";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { END, Graph, type GraphSpec, mergeHooks, START } from "../graph/index.ts";
import {
  type Capabilities,
  type Event,
  EventType,
  type Provider,
  type Request,
  type Response,
} from "../provider/index.ts";
import { messageText, Role, StopReason, textPart, thinkingPart, userMessage } from "../schema/index.ts";
import { TestProvider } from "../testprovider/index.ts";
import {
  AttrGaldorRunID,
  AttrGenAICompletion,
  AttrGenAIPrompt,
  AttrGenAIRequestModel,
  AttrGenAIResponseFinish,
  AttrGenAIUsageInputTokens,
  AttrGenAIUsageOutputTokens,
  instrumentProvider,
  recordGraphSpec,
  setupTracing,
  SpanGraphNode,
  SpanGraphRun,
  SpanProviderGenerate,
  SQLiteSpanExporter,
  traceHooks,
} from "./index.ts";

interface S {
  out: string;
}

const INVALID_TRACE_ID = "00000000000000000000000000000000";

/** A tracer wired to an in-memory exporter so finished spans can be inspected directly. */
function memoryTracer(): { tracer: Tracer; exporter: InMemorySpanExporter } {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { tracer: provider.getTracer("test"), exporter };
}

describe("observability tracing", () => {
  test("emits nested run -> node -> provider spans grouped by run id", async () => {
    const tracing = setupTracing(":memory:", { checkpointIntervalMs: 0 });
    const provider = instrumentProvider(new TestProvider({ responses: ["hi there"] }), tracing.tracer, {
      captureContent: true,
    });

    const g = new Graph<S>()
      .addNode("call", async (_s, ctx) => {
        const r = await provider.generate({ model: "m", messages: [userMessage("q")] }, ctx);
        return { out: messageText(r.message) };
      })
      .addEdge(START, "call")
      .addEdge("call", END)
      .compile();

    const final = await g.invoke({ out: "" }, { runId: "run-x", hooks: traceHooks<S>(tracing.tracer) });
    expect(final.out).toBe("hi there");

    const spans = tracing.store.spansForRun("run-x");
    const byName = new Map(spans.map((s) => [s.name, s]));
    const run = byName.get(SpanGraphRun);
    const node = byName.get(SpanGraphNode);
    const gen = byName.get(SpanProviderGenerate);
    expect(run).toBeDefined();
    expect(node).toBeDefined();
    expect(gen).toBeDefined();

    // nesting: provider under node, node under run
    expect(node!.parentSpanId).toBe(run!.spanId);
    expect(gen!.parentSpanId).toBe(node!.spanId);

    // run grouping + captured attributes
    expect(run!.attributes[AttrGaldorRunID]).toBe("run-x");
    expect(gen!.attributes[AttrGenAIRequestModel]).toBe("m");
    expect(typeof gen!.attributes[AttrGenAIPrompt]).toBe("string");

    await tracing.shutdown();
  });

  test("a root-level generate (no parent span, no run id) self-buckets under its own trace id", async () => {
    const { tracer, exporter } = memoryTracer();
    const traced = instrumentProvider(new TestProvider({ responses: ["hi"] }), tracer);

    // No RunContext at all: this is the standalone-call path that previously
    // fell through with an empty run id because the fallback looked at the
    // (absent) PARENT span instead of the newly-created span.
    await traced.generate({ model: "m", messages: [userMessage("q")] });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    const traceId = span.spanContext().traceId;
    expect(traceId).not.toBe(INVALID_TRACE_ID);
    // The span buckets under its own trace id rather than vanishing into the
    // no-run-id void.
    expect(span.attributes[AttrGaldorRunID]).toBe(traceId);
  });

  test("captured completion excludes thinking parts", async () => {
    const { tracer, exporter } = memoryTracer();
    const thinkingProvider: Provider = {
      name: () => "thinker",
      capabilities: (): Capabilities => new TestProvider().capabilities(),
      async generate(_req: Request): Promise<Response> {
        return {
          message: { role: Role.Assistant, content: [thinkingPart("secret reasoning"), textPart("the answer")] },
          stopReason: StopReason.EndTurn,
          usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
          model: "m",
        };
      },
      async *stream() {
        /* unused */
      },
    };
    const traced = instrumentProvider(thinkingProvider, tracer, { captureContent: true });
    await traced.generate({ model: "m", messages: [userMessage("q")] });

    const span = exporter.getFinishedSpans()[0]!;
    const completion = span.attributes[AttrGenAICompletion] as string;
    expect(completion).toContain("the answer");
    expect(completion).not.toContain("secret reasoning");
    expect(completion).not.toContain("thinking");
  });

  test("completion attribute is skipped when the message is thinking-only", async () => {
    const { tracer, exporter } = memoryTracer();
    const thinkingOnly: Provider = {
      name: () => "thinker",
      capabilities: (): Capabilities => new TestProvider().capabilities(),
      async generate(_req: Request): Promise<Response> {
        return {
          message: { role: Role.Assistant, content: [thinkingPart("only thinking")] },
          stopReason: StopReason.EndTurn,
          usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
          model: "m",
        };
      },
      async *stream() {
        /* unused */
      },
    };
    const traced = instrumentProvider(thinkingOnly, tracer, { captureContent: true });
    await traced.generate({ model: "m", messages: [userMessage("q")] });

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes[AttrGenAICompletion]).toBeUndefined();
  });

  test("an assistant turn with only tool calls still sets the completion", async () => {
    const { tracer, exporter } = memoryTracer();
    const toolCaller: Provider = {
      name: () => "caller",
      capabilities: (): Capabilities => new TestProvider().capabilities(),
      async generate(_req: Request): Promise<Response> {
        return {
          message: {
            role: Role.Assistant,
            content: [],
            toolCalls: [{ id: "c1", name: "search", arguments: { q: "x" } }],
          },
          stopReason: StopReason.ToolUse,
          usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
          model: "m",
        };
      },
      async *stream() {
        /* unused */
      },
    };
    const traced = instrumentProvider(toolCaller, tracer, { captureContent: true });
    await traced.generate({ model: "m", messages: [userMessage("q")] });

    const span = exporter.getFinishedSpans()[0]!;
    const completion = span.attributes[AttrGenAICompletion] as string;
    expect(completion).toBeDefined();
    expect(completion).toContain("search");
  });

  test("a streamed run records finish/usage and (with captureContent) the completion", async () => {
    const { tracer, exporter } = memoryTracer();
    const streamer: Provider = {
      name: () => "streamer",
      capabilities: (): Capabilities => new TestProvider().capabilities(),
      async generate(_req: Request): Promise<Response> {
        throw new Error("unused");
      },
      async *stream(): AsyncIterable<Event> {
        yield { type: EventType.ContentDelta, contentDelta: "hello " };
        yield { type: EventType.ContentDelta, contentDelta: "world" };
        yield {
          type: EventType.MessageStop,
          stopReason: StopReason.EndTurn,
          usage: { inputTokens: 3, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 },
        };
      },
    };
    const traced = instrumentProvider(streamer, tracer, { captureContent: true });

    const events: Event[] = [];
    for await (const ev of traced.stream({ model: "m", messages: [userMessage("q")] })) events.push(ev);
    expect(events).toHaveLength(3);

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes[AttrGenAIResponseFinish]).toBe(StopReason.EndTurn);
    expect(span.attributes[AttrGenAIUsageInputTokens]).toBe(3);
    expect(span.attributes[AttrGenAIUsageOutputTokens]).toBe(5);
    const completion = span.attributes[AttrGenAICompletion] as string;
    expect(completion).toBeDefined();
    expect(completion).toContain("hello world");
  });

  test("a streamed run without captureContent records finish/usage but no completion", async () => {
    const { tracer, exporter } = memoryTracer();
    const streamer: Provider = {
      name: () => "streamer",
      capabilities: (): Capabilities => new TestProvider().capabilities(),
      async generate(_req: Request): Promise<Response> {
        throw new Error("unused");
      },
      async *stream(): AsyncIterable<Event> {
        yield { type: EventType.ContentDelta, contentDelta: "secret" };
        yield {
          type: EventType.MessageStop,
          stopReason: StopReason.EndTurn,
          usage: { inputTokens: 2, outputTokens: 4, cacheCreationTokens: 0, cacheReadTokens: 0 },
        };
      },
    };
    const traced = instrumentProvider(streamer, tracer);

    for await (const _ev of traced.stream({ model: "m", messages: [userMessage("q")] })) {
      /* drain */
    }

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes[AttrGenAIResponseFinish]).toBe(StopReason.EndTurn);
    expect(span.attributes[AttrGenAIUsageInputTokens]).toBe(2);
    expect(span.attributes[AttrGenAIUsageOutputTokens]).toBe(4);
    expect(span.attributes[AttrGenAICompletion]).toBeUndefined();
  });
});

describe("span-store directory", () => {
  test("is created owner-only (mode 0o700) since it may hold captured prompts", async () => {
    const base = mkdtempSync(join(tmpdir(), "galdor-obs-"));
    try {
      const dir = join(base, "nested");
      const dbPath = join(dir, "traces.db");
      const exporter = SQLiteSpanExporter.open(dbPath, { checkpointIntervalMs: 0 });
      try {
        const mode = statSync(dir).mode & 0o777;
        expect(mode).toBe(0o700);
      } finally {
        await exporter.shutdown();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("recordGraphSpec", () => {
  test("persists the runnable's topology under the run id, retrievable via getGraphSpec", async () => {
    const tracing = setupTracing(":memory:", { checkpointIntervalMs: 0 });

    const g = new Graph<S>()
      .addNode("first", (s) => ({ ...s }))
      .addNode("second", (s) => ({ ...s, out: "done" }))
      .addEdge(START, "first")
      .addEdge("first", "second")
      .addEdge("second", END)
      .compile();

    // Compose spec recording with span tracing through a single merged hook set.
    const hooks = mergeHooks(traceHooks<S>(tracing.tracer), recordGraphSpec(tracing.store, g));
    await g.invoke({ out: "" }, { runId: "run-spec", hooks });

    const raw = tracing.store.getGraphSpec("run-spec");
    expect(raw).not.toBe("");
    const spec = JSON.parse(raw) as GraphSpec;
    expect(spec.entry).toBe("first");
    expect(spec.nodes).toEqual(["first", "second"]);
    expect(spec.edges).toContainEqual({ from: "first", to: "second" });
    expect(spec.edges).toContainEqual({ from: "second", to: END });

    await tracing.shutdown();
  });

  test("an anonymous run (no run id) records nothing rather than throwing", async () => {
    const tracing = setupTracing(":memory:", { checkpointIntervalMs: 0 });
    const g = new Graph<S>()
      .addNode("only", (s) => ({ ...s, out: "x" }))
      .addEdge(START, "only")
      .addEdge("only", END)
      .compile();

    // No runId: setGraphSpec rejects an empty key, so the hook must skip it
    // silently instead of failing the run.
    const final = await g.invoke({ out: "" }, { hooks: recordGraphSpec(tracing.store, g) });
    expect(final.out).toBe("x");

    await tracing.shutdown();
  });
});
