/**
 * core/store — the embedded SQLite span store.
 *
 * Persists OpenTelemetry spans and per-run graph specs in a single SQLite
 * database. The API is fully synchronous: methods return their results directly
 * rather than via promises.
 *
 * The store talks to SQLite through the small {@link SqliteDriver} contract and
 * picks an implementation by runtime — `bun:sqlite` under Bun, `node:sqlite`
 * (with a `better-sqlite3` fallback) elsewhere — so the same code runs on both.
 *
 * Span timestamps are nanosecond Unix times (values up to ~1.7e18) that exceed
 * the safe-integer range of a JS `number` (2^53). Every driver reads and binds
 * INTEGER columns as **bigint**, keeping nanosecond precision intact end to end.
 *
 * @example
 * ```ts
 * const store = Store.open(":memory:");
 * store.insertSpans([span]);
 * const runs = store.listRuns(10);
 * store.close();
 * ```
 */

import { createRequire } from "node:module";
import type { SqliteDriver } from "./driver.ts";

const require = createRequire(import.meta.url);

/** True when running under the Bun runtime; false under Node (and elsewhere). */
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * Open a backend-appropriate {@link SqliteDriver} for `path`.
 *
 * The driver module is loaded with a runtime-guarded synchronous `require`, so
 * Bun never loads the Node backend (or its native imports) and vice-versa,
 * while keeping {@link Store.open} synchronous.
 */
function selectDriver(path: string): SqliteDriver {
  if (isBun) {
    const { openBunDriver } = require("./driver.bun") as typeof import("./driver.bun.ts");
    return openBunDriver(path);
  }
  const { openNodeDriver } = require("./driver.node") as typeof import("./driver.node.ts");
  return openNodeDriver(path);
}

/**
 * Persisted form of an OpenTelemetry span, decoupled from any OTel SDK type.
 *
 * Timestamps and event times are bigint nanosecond Unix values to preserve full
 * precision. See {@link SpanEvent} for the shape of recorded events.
 */
export interface Span {
  spanId: string;
  traceId: string;
  parentSpanId: string;
  name: string;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  statusCode: "unset" | "ok" | "error";
  statusMessage: string;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  /** Denormalized from attributes for fast filtering. */
  runId: string;
}

/** A timestamped event attached to a {@link Span}, e.g. an exception record. */
export interface SpanEvent {
  name: string;
  timeUnixNano: bigint;
  attributes?: Record<string, unknown>;
}

/**
 * Wall-clock duration of a span in nanoseconds.
 *
 * @param s - The span to measure.
 * @returns `end - start`, or `0n` when either timestamp is unset.
 */
export function spanDuration(s: Span): bigint {
  if (s.endTimeUnixNano === 0n || s.startTimeUnixNano === 0n) return 0n;
  return s.endTimeUnixNano - s.startTimeUnixNano;
}

/** Aggregated view of a run — one per distinct trace that carries a run id. */
export interface RunSummary {
  runId: string;
  traceId: string;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  spanCount: number;
  errorCount: number;
}

/**
 * Overall status of a run.
 *
 * @param r - The aggregated run summary.
 * @returns `"error"` if any span in the run failed, otherwise `"ok"`.
 */
export function runStatus(r: RunSummary): "ok" | "error" {
  return r.errorCount > 0 ? "error" : "ok";
}

/**
 * Wall-clock duration of a run in nanoseconds.
 *
 * @param r - The aggregated run summary.
 * @returns `end - start`, or `0n` when either timestamp is unset.
 */
export function runDuration(r: RunSummary): bigint {
  if (r.endTimeUnixNano === 0n || r.startTimeUnixNano === 0n) return 0n;
  return r.endTimeUnixNano - r.startTimeUnixNano;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spans (
  span_id              TEXT PRIMARY KEY,
  trace_id             TEXT NOT NULL,
  parent_span_id       TEXT NOT NULL DEFAULT '',
  name                 TEXT NOT NULL,
  start_time_unix_nano INTEGER NOT NULL,
  end_time_unix_nano   INTEGER NOT NULL,
  status_code          TEXT NOT NULL DEFAULT 'unset',
  status_message       TEXT NOT NULL DEFAULT '',
  attrs_json           TEXT NOT NULL DEFAULT '{}',
  events_json          TEXT NOT NULL DEFAULT '[]',
  run_id               TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_spans_trace_id ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_run_id   ON spans(run_id);
CREATE INDEX IF NOT EXISTS idx_spans_parent   ON spans(parent_span_id);
CREATE INDEX IF NOT EXISTS idx_spans_start    ON spans(start_time_unix_nano);

CREATE TABLE IF NOT EXISTS graph_specs (
  run_id     TEXT PRIMARY KEY,
  spec_json  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

function normalizeStatus(s: string): "unset" | "ok" | "error" {
  const l = s.toLowerCase();
  return l === "ok" || l === "error" ? l : "unset";
}

type SpanRow = {
  span_id: string;
  trace_id: string;
  parent_span_id: string;
  name: string;
  start_time_unix_nano: bigint;
  end_time_unix_nano: bigint;
  status_code: string;
  status_message: string;
  attrs_json: string;
  events_json: string;
  run_id: string;
};

/**
 * SQLite-backed store for spans and per-run graph specs.
 *
 * Inserts and queries are safe to interleave within a single process. On-disk
 * databases run in WAL mode with a busy timeout, so a writer and concurrent
 * readers do not block each other. Construct instances with {@link Store.open}
 * or {@link Store.openExisting}, and release the handle with {@link Store.close}.
 *
 * @example
 * ```ts
 * const store = Store.open("/var/lib/galdor/spans.db");
 * store.insertSpans(batch);
 * for (const run of store.listRuns()) console.log(run.runId, runStatus(run));
 * store.close();
 * ```
 */
export class Store {
  readonly #db: SqliteDriver;
  readonly #inMemory: boolean;

  private constructor(db: SqliteDriver, inMemory: boolean) {
    this.#db = db;
    this.#inMemory = inMemory;
  }

  /**
   * Open the store at `path`, creating the database and schema if needed.
   *
   * @param path - Filesystem path, or `":memory:"` (any path starting with `:`)
   *   for a transient in-memory database.
   * @param driver - An explicit {@link SqliteDriver} to use instead of the
   *   runtime-selected default; intended for testing.
   * @returns A ready-to-use store with the schema applied.
   * @throws {Error} If `path` is empty.
   * @example
   * ```ts
   * const store = Store.open(":memory:");
   * ```
   */
  static open(path: string, driver?: SqliteDriver): Store {
    if (path === "") throw new Error("store: empty path");
    const inMemory = path.startsWith(":");
    // The driver reads/binds INTEGER columns as bigint, so the nanosecond
    // timestamps survive without float64 precision loss.
    const db = driver ?? selectDriver(path);
    db.exec("PRAGMA busy_timeout = 5000");
    if (!inMemory) {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = ON");
    }
    const store = new Store(db, inMemory);
    db.exec(SCHEMA);
    return store;
  }

  /**
   * Open a store whose database file must already exist.
   *
   * Intended for read-side consumers — the CLI, dashboard, and replay tooling —
   * that should fail loudly rather than silently create an empty database.
   *
   * @param path - Filesystem path, or an in-memory specifier starting with `:`.
   * @returns The opened store.
   * @throws {Error} If `path` is empty, or names an on-disk database that does
   *   not exist.
   */
  static openExisting(path: string): Store {
    if (path === "") throw new Error("store: empty path");
    if (!path.startsWith(":") && !require("node:fs").existsSync(path)) {
      throw new Error(`store: database ${path} does not exist (check --db or $GALDOR_DB)`);
    }
    return Store.open(path);
  }

  /** Close the underlying database handle and release its resources. */
  close(): void {
    this.#db.close();
  }

  /**
   * The underlying SQLite handle, for advanced custom queries and tests.
   *
   * @returns The live {@link SqliteDriver}. The driver's `native` property
   *   exposes the raw backend handle. Do not alter the schema through it.
   */
  get db(): SqliteDriver {
    return this.#db;
  }

  /**
   * Persist a batch of spans in a single transaction.
   *
   * Rows whose `span_id` already exists are ignored rather than treated as
   * errors, so re-delivering the same span is idempotent.
   *
   * @param spans - Spans to insert; an empty array is a no-op.
   */
  insertSpans(spans: Span[]): void {
    if (spans.length === 0) return;
    const stmt = this.#db.prepare(
      `INSERT OR IGNORE INTO spans
        (span_id, trace_id, parent_span_id, name,
         start_time_unix_nano, end_time_unix_nano,
         status_code, status_message, attrs_json, events_json, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAll = this.#db.transaction((rows: Span[]) => {
      for (const sp of rows) {
        const attrs = Object.keys(sp.attributes).length === 0 ? "{}" : jsonStringify(sp.attributes);
        const events = sp.events.length === 0 ? "[]" : jsonStringify(sp.events.map(toEventRow));
        stmt.run(
          sp.spanId,
          sp.traceId,
          sp.parentSpanId,
          sp.name,
          sp.startTimeUnixNano,
          sp.endTimeUnixNano,
          normalizeStatus(sp.statusCode),
          sp.statusMessage,
          attrs,
          events,
          sp.runId,
        );
      }
    });
    insertAll(spans);
  }

  /**
   * Summarize the most recent runs, newest first.
   *
   * Spans are aggregated by `trace_id`; only traces that carry a run id are
   * included. Each summary spans the full trace's time range and span/error
   * counts.
   *
   * @param limit - Maximum number of runs to return; non-positive values fall
   *   back to the default of `20`.
   * @returns Run summaries ordered by start time descending.
   */
  listRuns(limit = 20): RunSummary[] {
    if (limit <= 0) limit = 20;
    const rows = this.#db
      .prepare(
        `SELECT
           (SELECT run_id FROM spans r
            WHERE r.trace_id = s.trace_id AND r.run_id <> '' LIMIT 1) AS run_id,
           s.trace_id,
           MIN(s.start_time_unix_nano) AS start_t,
           MAX(s.end_time_unix_nano)   AS end_t,
           COUNT(*) AS span_count,
           SUM(CASE WHEN s.status_code = 'error' THEN 1 ELSE 0 END) AS error_count
         FROM spans s
         WHERE s.trace_id IN (SELECT trace_id FROM spans WHERE run_id <> '')
         GROUP BY s.trace_id
         ORDER BY start_t DESC
         LIMIT ?`,
      )
      .all<{
        run_id: string | null;
        trace_id: string;
        start_t: bigint;
        end_t: bigint;
        span_count: bigint;
        error_count: bigint;
      }>(limit);
    return rows.map((r) => ({
      runId: r.run_id ?? "",
      traceId: r.trace_id,
      startTimeUnixNano: r.start_t,
      endTimeUnixNano: r.end_t,
      spanCount: Number(r.span_count),
      errorCount: Number(r.error_count),
    }));
  }

  /**
   * Store the JSON graph topology for a run, replacing any prior spec.
   *
   * @param runId - The run whose graph spec is being recorded.
   * @param specJSON - The serialized graph topology.
   * @throws {Error} If `runId` is empty or `specJSON` is empty.
   */
  setGraphSpec(runId: string, specJSON: string): void {
    if (runId === "") throw new Error("store: empty runId");
    if (specJSON.length === 0) throw new Error("store: empty spec");
    this.#db
      .prepare(
        `INSERT INTO graph_specs (run_id, spec_json, created_at) VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET spec_json = excluded.spec_json`,
      )
      .run(runId, specJSON, BigInt(Date.now()) * 1_000_000n);
  }

  /**
   * Retrieve the stored graph topology for a run.
   *
   * @param runId - The run to look up.
   * @returns The serialized graph spec, or `""` if none was recorded.
   * @throws {Error} If `runId` is empty.
   */
  getGraphSpec(runId: string): string {
    if (runId === "") throw new Error("store: empty runId");
    const row = this.#db
      .prepare(`SELECT spec_json FROM graph_specs WHERE run_id = ?`)
      .get<{ spec_json: string }>(runId);
    return row?.spec_json ?? "";
  }

  /**
   * Count spans that belong to no run.
   *
   * A span is orphaned when no span in its entire trace carries a run id; the
   * dashboard surfaces this as a warning.
   *
   * @returns The number of orphaned spans.
   */
  orphanSpanCount(): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM spans
         WHERE trace_id NOT IN (SELECT trace_id FROM spans WHERE run_id <> '')`,
      )
      .get<{ n: bigint }>();
    return Number(row?.n ?? 0n);
  }

  /**
   * Fetch every span belonging to a run, ready for reconstruction or display.
   *
   * The run id is resolved to its most recent trace, and all spans in that
   * trace are returned. Ordering is start-time ascending, with root spans (no
   * parent) preferred and longer spans first on ties.
   *
   * @param runId - The run whose spans to return.
   * @returns The run's spans in display order; empty if the run is unknown.
   * @throws {Error} If `runId` is empty.
   */
  spansForRun(runId: string): Span[] {
    if (runId === "") throw new Error("store: empty runId");
    const rows = this.#db
      .prepare(
        `SELECT span_id, trace_id, parent_span_id, name,
                start_time_unix_nano, end_time_unix_nano,
                status_code, status_message, attrs_json, events_json, run_id
         FROM spans
         WHERE trace_id = (
           SELECT trace_id FROM spans WHERE run_id = ?
           ORDER BY start_time_unix_nano DESC LIMIT 1)
         ORDER BY start_time_unix_nano ASC,
                  CASE WHEN parent_span_id = '' THEN 0 ELSE 1 END ASC,
                  end_time_unix_nano DESC`,
      )
      .all<SpanRow>(runId);
    return rows.map(scanSpan);
  }

  /**
   * Total number of spans stored.
   *
   * @returns The row count of the spans table.
   */
  spanCount(): number {
    const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM spans`).get<{ n: bigint }>();
    return Number(row?.n ?? 0n);
  }

  /**
   * Fold the write-ahead log back into the main database file.
   *
   * @param mode - The SQLite WAL checkpoint mode to use; defaults to `"PASSIVE"`.
   *   Has no effect on in-memory databases.
   */
  checkpoint(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"): void {
    if (this.#inMemory) return;
    this.#db.exec(`PRAGMA wal_checkpoint(${mode})`);
  }
}

function scanSpan(r: SpanRow): Span {
  return {
    spanId: r.span_id,
    traceId: r.trace_id,
    parentSpanId: r.parent_span_id,
    name: r.name,
    startTimeUnixNano: r.start_time_unix_nano,
    endTimeUnixNano: r.end_time_unix_nano,
    statusCode: normalizeStatus(r.status_code),
    statusMessage: r.status_message,
    attributes: r.attrs_json && r.attrs_json !== "{}" ? JSON.parse(r.attrs_json) : {},
    events: r.events_json && r.events_json !== "[]" ? reviveEvents(JSON.parse(r.events_json)) : [],
    runId: r.run_id,
  };
}

/**
 * Serialize an event to its on-disk row. The time field is written as
 * `time_unix_nano` so the stored shape is identical to other galdor span stores.
 */
function toEventRow(e: SpanEvent): Record<string, unknown> {
  return { name: e.name, time_unix_nano: e.timeUnixNano, ...(e.attributes ? { attributes: e.attributes } : {}) };
}

function reviveEvents(raw: unknown[]): SpanEvent[] {
  return raw.map((e) => {
    const ev = e as {
      name: string;
      time_unix_nano?: string | number | bigint;
      timeUnixNano?: string | number | bigint;
      attributes?: Record<string, unknown>;
    };
    // Accept both the canonical `time_unix_nano` and a camelCase fallback.
    const t = ev.time_unix_nano ?? ev.timeUnixNano ?? 0;
    return {
      name: ev.name,
      timeUnixNano: BigInt(t),
      ...(ev.attributes ? { attributes: ev.attributes } : {}),
    };
  });
}

/** JSON.stringify that serializes bigint as a decimal string (for event times). */
function jsonStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));
}
