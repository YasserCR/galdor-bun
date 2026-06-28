/**
 * OpenTelemetry-native tracing for galdor.
 *
 * Instrument providers, tools and the graph runtime so they emit `gen_ai.*` and
 * `galdor.*` spans, then persist those spans to a bun:sqlite store that the CLI
 * and dashboard read. Supply any OTel TracerProvider, or call
 * {@link setupTracing} to wire up the SQLite-backed pipeline in one call.
 *
 * @module
 */

export * from "./attrs.ts";
export {
  OTEL_CONTEXT_KEY,
  runIdFromContext,
  spanLabelFromContext,
  withRunId,
  withSpanLabel,
} from "./context.ts";
export { type InstrumentOptions, instrumentProvider, instrumentRegistry, instrumentTool } from "./instrument.ts";
export { traceHooks } from "./hooks.ts";
export { recordGraphSpec } from "./spec.ts";
export {
  type ExporterOptions,
  SQLiteSpanExporter,
  setupTracing,
  type Tracing,
} from "./exporter.ts";
