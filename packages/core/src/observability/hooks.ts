/**
 * Graph trace hooks.
 *
 * {@link traceHooks} returns a set of graph {@link Hooks} that emit one root
 * span per run and one child span per node hop. Spans created by
 * {@link instrumentProvider} and {@link instrumentTool} nest inside the current
 * node span automatically, because `beforeNode` threads the node span's OTel
 * context down through `RunContext.values`.
 *
 *   galdor.graph.run
 *   ├── galdor.graph.node   (node 1)
 *   └── galdor.graph.node   (node N)
 *
 * @module
 */

import { ROOT_CONTEXT, type Span, SpanStatusCode, trace, type Tracer } from "@opentelemetry/api";
import type { Hooks } from "../graph/index.ts";
import type { RunContext } from "../runtime/context.ts";
import {
  AttrGaldorNode,
  AttrGaldorRunID,
  AttrGaldorStateType,
  AttrGaldorStep,
  SpanGraphNode,
  SpanGraphRun,
} from "./attrs.ts";
import { OTEL_CONTEXT_KEY, withRunId } from "./context.ts";

const RUN_SPAN_KEY = "galdor.observability.runSpan";
const NODE_SPAN_KEY = "galdor.observability.nodeSpan";

function setValues(ctx: RunContext, entries: Array<[string, unknown]>): RunContext {
  const values = new Map(ctx.values ?? []);
  for (const [k, v] of entries) values.set(k, v);
  return { ...ctx, values };
}

function endSpan(ctx: RunContext, key: string, error: unknown): void {
  const span = ctx.values?.get(key) as Span | undefined;
  if (!span) return;
  if (error !== undefined && error !== null) {
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
  }
  span.end();
}

/**
 * Builds graph {@link Hooks} that trace a run as a root span with one child
 * span per node.
 *
 * The hooks stamp the run id, node name and step number onto their spans and
 * record exceptions on the active span when a run or node fails.
 *
 * @typeParam S - The graph state type.
 * @param tracer - Tracer used to start the run and node spans.
 * @returns Hooks to pass to a graph invocation (e.g. `graph.invoke(state, { hooks })`).
 * @example
 * ```ts
 * const tracing = setupTracing(":memory:");
 * await graph.invoke(initial, { runId: "run-1", hooks: traceHooks(tracing.tracer) });
 * ```
 */
export function traceHooks<S>(tracer: Tracer): Hooks<S> {
  return {
    beforeRun(ctx, runId) {
      const withId = withRunId(ctx, runId);
      const parent = (withId.values?.get(OTEL_CONTEXT_KEY) as ReturnType<typeof trace.setSpan> | undefined) ?? ROOT_CONTEXT;
      const span = tracer.startSpan(
        SpanGraphRun,
        { attributes: { [AttrGaldorRunID]: runId, [AttrGaldorStateType]: "object" } },
        parent,
      );
      return setValues(withId, [
        [RUN_SPAN_KEY, span],
        [OTEL_CONTEXT_KEY, trace.setSpan(parent, span)],
      ]);
    },
    afterRun(ctx, _runId, _final, error) {
      endSpan(ctx, RUN_SPAN_KEY, error);
    },
    beforeNode(ctx, runId, node, step) {
      const parent = (ctx.values?.get(OTEL_CONTEXT_KEY) as ReturnType<typeof trace.setSpan> | undefined) ?? ROOT_CONTEXT;
      const span = tracer.startSpan(
        SpanGraphNode,
        { attributes: { [AttrGaldorRunID]: runId, [AttrGaldorNode]: node, [AttrGaldorStep]: step } },
        parent,
      );
      return setValues(ctx, [
        [NODE_SPAN_KEY, span],
        [OTEL_CONTEXT_KEY, trace.setSpan(parent, span)],
      ]);
    },
    afterNode(ctx, _runId, _node, _step, _state, error) {
      endSpan(ctx, NODE_SPAN_KEY, error);
    },
  };
}
