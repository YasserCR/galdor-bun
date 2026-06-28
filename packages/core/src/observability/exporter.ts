/**
 * An OpenTelemetry {@link SpanExporter} backed by bun:sqlite.
 *
 * Persists finished spans into a galdor-managed SQLite database — the same one
 * the CLI (`galdor scry`) and the dashboard read from. While a long-lived
 * process holds the write connection open, a periodic PASSIVE WAL checkpoint
 * keeps the persisted data visible to those readers.
 *
 * @module
 */

import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import type { HrTime } from "@opentelemetry/api";
import { SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Span as StoreSpan, type SpanEvent, Store } from "../store/index.ts";
import { AttrGaldorRunID } from "./attrs.ts";

const DEFAULT_CHECKPOINT_INTERVAL_MS = 3000;

function hrToNanos(t: HrTime): bigint {
  return BigInt(t[0]) * 1_000_000_000n + BigInt(t[1]);
}

function statusCode(code: SpanStatusCode): "unset" | "ok" | "error" {
  if (code === SpanStatusCode.OK) return "ok";
  if (code === SpanStatusCode.ERROR) return "error";
  return "unset";
}

function parentSpanId(span: ReadableSpan): string {
  // The OTel JS SDK exposes the parent span id as `parentSpanId` in some
  // versions and as `parentSpanContext.spanId` in others; accept either shape.
  const s = span as unknown as { parentSpanId?: string; parentSpanContext?: { spanId?: string } };
  return s.parentSpanId ?? s.parentSpanContext?.spanId ?? "";
}

function convertSpan(span: ReadableSpan): StoreSpan {
  const sc = span.spanContext();
  const attributes = { ...span.attributes } as Record<string, unknown>;
  const events: SpanEvent[] = span.events.map((ev) => ({
    name: ev.name,
    timeUnixNano: hrToNanos(ev.time),
    ...(ev.attributes ? { attributes: { ...ev.attributes } as Record<string, unknown> } : {}),
  }));
  const runId = typeof attributes[AttrGaldorRunID] === "string" ? (attributes[AttrGaldorRunID] as string) : "";
  return {
    spanId: sc.spanId,
    traceId: sc.traceId,
    parentSpanId: parentSpanId(span),
    name: span.name,
    startTimeUnixNano: hrToNanos(span.startTime),
    endTimeUnixNano: hrToNanos(span.endTime),
    statusCode: statusCode(span.status.code),
    statusMessage: span.status.message ?? "",
    attributes,
    events,
    runId,
  };
}

/** Options for {@link SQLiteSpanExporter.open} and {@link setupTracing}. */
export interface ExporterOptions {
  /**
   * Period, in milliseconds, of the background PASSIVE WAL checkpoint. A value
   * of 0 disables the timer. Defaults to 3000.
   */
  checkpointIntervalMs?: number;
}

/**
 * A {@link SpanExporter} that writes finished spans into a SQLite database via
 * a {@link Store}.
 *
 * Construct one with {@link SQLiteSpanExporter.open}. The exporter optionally
 * runs a background PASSIVE checkpoint so concurrent readers see fresh data,
 * and performs a TRUNCATE checkpoint on {@link SQLiteSpanExporter.shutdown}.
 */
export class SQLiteSpanExporter implements SpanExporter {
  readonly #store: Store;
  #shutdown = false;
  #timer: ReturnType<typeof setInterval> | undefined;

  private constructor(store: Store, checkpointIntervalMs: number) {
    this.#store = store;
    if (checkpointIntervalMs > 0) {
      this.#timer = setInterval(() => {
        try {
          this.#store.checkpoint("PASSIVE");
        } catch {
          /* best effort */
        }
      }, checkpointIntervalMs);
      this.#timer.unref?.();
    }
  }

  /**
   * Opens the span database, creating any missing parent directories, and
   * returns a ready-to-use exporter.
   *
   * @param dbPath - Filesystem path to the SQLite database. Special values such as `:memory:` (anything beginning with `:`) are passed through without directory creation.
   * @param opts - Checkpoint options. See {@link ExporterOptions}.
   * @returns A new exporter backed by the opened store.
   */
  static open(dbPath: string, opts: ExporterOptions = {}): SQLiteSpanExporter {
    if (!dbPath.startsWith(":")) {
      const dir = dirname(dbPath);
      // Owner-only (0o700): the database can hold captured prompts, which may
      // contain personally identifiable information.
      if (dir && dir !== ".") mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const store = Store.open(dbPath);
    return new SQLiteSpanExporter(store, opts.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS);
  }

  /**
   * The underlying store, for direct read queries (CLI, dashboard).
   *
   * @returns The exporter's {@link Store}. Do not close it directly; use
   * {@link SQLiteSpanExporter.shutdown} instead.
   */
  get store(): Store {
    return this.#store;
  }

  /**
   * Persists a batch of finished spans.
   *
   * @param spans - The finished spans to write.
   * @param resultCallback - Invoked with a SUCCESS result, or FAILED carrying the underlying error (including when the exporter has already been shut down).
   */
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.#shutdown) {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error("observability: exporter is shut down") });
      return;
    }
    try {
      this.#store.insertSpans(spans.map(convertSpan));
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      resultCallback({ code: ExportResultCode.FAILED, error: error as Error });
    }
  }

  /** Runs a PASSIVE checkpoint so already-exported spans are visible to readers. */
  async forceFlush(): Promise<void> {
    this.#store.checkpoint("PASSIVE");
  }

  /**
   * Stops the background checkpoint timer, runs a final TRUNCATE checkpoint and
   * closes the store. Idempotent: subsequent calls are no-ops.
   */
  async shutdown(): Promise<void> {
    if (this.#shutdown) return;
    this.#shutdown = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#store.checkpoint("TRUNCATE");
    this.#store.close();
  }
}

/** A fully wired tracing pipeline: a {@link Tracer} writing to a SQLite span store. */
export interface Tracing {
  /** Tracer to pass to the instrument helpers and graph hooks. */
  tracer: Tracer;
  /** The exporter persisting spans to SQLite. */
  exporter: SQLiteSpanExporter;
  /** The span store, for direct read queries. */
  store: Store;
  /** Shuts down the TracerProvider, flushing and closing the pipeline. */
  shutdown(): Promise<void>;
}

/**
 * Opens the span database, wires up a TracerProvider with a SQLite exporter and
 * returns the tracer, exporter and store as a single {@link Tracing} bundle.
 *
 * @param dbPath - Filesystem path to the SQLite database (or `:memory:`).
 * @param opts - Checkpoint options. See {@link ExporterOptions}.
 * @returns A ready-to-use tracing pipeline.
 * @example
 * ```ts
 * const tracing = setupTracing("traces.db");
 * const provider = instrumentProvider(base, tracing.tracer);
 * // ... run work ...
 * await tracing.shutdown();
 * ```
 */
export function setupTracing(dbPath: string, opts: ExporterOptions = {}): Tracing {
  const exporter = SQLiteSpanExporter.open(dbPath, opts);
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const tracer = provider.getTracer("galdor");
  return {
    tracer,
    exporter,
    store: exporter.store,
    async shutdown() {
      await provider.shutdown();
    },
  };
}
