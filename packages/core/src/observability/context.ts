/**
 * Propagation of the run identifier and span label through a {@link RunContext}.
 *
 * Both values travel inside `RunContext.values`, the per-invocation key/value
 * bag that is passed down the call tree. The dashboard, the `scry` CLI and the
 * SQLite exporter all key on the `galdor.run.id` attribute to group spans into
 * a single run.
 *
 * @module
 */

import type { RunContext } from "../runtime/context.ts";

const RUN_ID_KEY = "galdor.observability.runId";
const SPAN_LABEL_KEY = "galdor.observability.spanLabel";
/**
 * Key under which the active OpenTelemetry {@link Context} is stored in
 * `RunContext.values`, so that spans started by instrumented providers, tools
 * and graph hooks nest beneath their parent.
 */
export const OTEL_CONTEXT_KEY = "galdor.observability.otelContext";

function withValue(ctx: RunContext, key: string, value: unknown): RunContext {
  const values = new Map(ctx.values ?? []);
  values.set(key, value);
  return { ...ctx, values };
}

/**
 * Returns a context carrying the given run id so that instrumented spans stamp
 * the `galdor.run.id` attribute.
 *
 * @param ctx - The context to derive from.
 * @param runId - Run identifier; an empty string is ignored and `ctx` is returned unchanged.
 * @returns A child context with the run id attached, or `ctx` if `runId` is empty.
 */
export function withRunId(ctx: RunContext, runId: string): RunContext {
  if (runId === "") return ctx;
  return withValue(ctx, RUN_ID_KEY, runId);
}

/**
 * Reads the run id previously attached with {@link withRunId}.
 *
 * @returns The run id, or an empty string if none is set.
 */
export function runIdFromContext(ctx: RunContext): string {
  const v = ctx.values?.get(RUN_ID_KEY);
  return typeof v === "string" ? v : "";
}

/**
 * Returns a context carrying a human-readable label that is shown next to the
 * span type in the dashboard.
 *
 * @param ctx - The context to derive from.
 * @param label - Label text; an empty string is ignored and `ctx` is returned unchanged.
 * @returns A child context with the label attached, or `ctx` if `label` is empty.
 */
export function withSpanLabel(ctx: RunContext, label: string): RunContext {
  if (label === "") return ctx;
  return withValue(ctx, SPAN_LABEL_KEY, label);
}

/**
 * Reads the span label previously attached with {@link withSpanLabel}.
 *
 * @returns The label, or an empty string if none is set.
 */
export function spanLabelFromContext(ctx: RunContext): string {
  const v = ctx.values?.get(SPAN_LABEL_KEY);
  return typeof v === "string" ? v : "";
}
