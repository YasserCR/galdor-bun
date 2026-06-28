/**
 * core/store — the synchronous SQLite driver contract.
 *
 * A tiny, backend-neutral surface that the {@link Store} talks to instead of any
 * concrete SQLite library. Two implementations satisfy it — one over the Bun
 * runtime's `bun:sqlite`, one over Node's built-in `node:sqlite` (with an
 * optional `better-sqlite3` fallback) — and the store selects between them by
 * runtime. Every call is synchronous: results are returned directly.
 *
 * The single hard invariant is that **`INTEGER` columns are returned as
 * `bigint`**. Span timestamps are nanosecond Unix times (up to ~1.7e18) that
 * overflow the safe-integer range of a JS `number` (2^53), so each driver
 * configures its backend to read and bind integers as `bigint`.
 */

/**
 * A value bindable to a positional SQL parameter.
 *
 * Integers are passed as `bigint` to preserve nanosecond precision; `number` is
 * accepted for small counts such as `LIMIT`.
 */
export type SqlParam = string | number | bigint | boolean | null | Uint8Array;

/**
 * A prepared statement with positional parameter binding.
 *
 * The generic on {@link SqliteStatement.all} and {@link SqliteStatement.get} is
 * the row shape the caller expects; the driver performs no validation beyond
 * what the backend returns. Rows expose columns as own properties, and any
 * `INTEGER` column is a `bigint`.
 */
export interface SqliteStatement {
  /**
   * Execute the statement for its side effects, discarding any result rows.
   *
   * @param params - Positional bind values, in `?`-placeholder order.
   */
  run(...params: SqlParam[]): void;
  /**
   * Execute the statement and collect every result row.
   *
   * @param params - Positional bind values, in `?`-placeholder order.
   * @returns All matching rows, each shaped as `T`.
   */
  all<T>(...params: SqlParam[]): T[];
  /**
   * Execute the statement and return the first result row, if any.
   *
   * @param params - Positional bind values, in `?`-placeholder order.
   * @returns The first row shaped as `T`, or `undefined` when none match.
   */
  get<T>(...params: SqlParam[]): T | undefined;
}

/**
 * A minimal synchronous SQLite connection.
 *
 * Implementations wrap a concrete backend handle and adapt it to this contract.
 * The {@link SqliteDriver.native} handle is exposed for advanced, backend-aware
 * callers and tests; treat it as opaque.
 */
export interface SqliteDriver {
  /**
   * Run one or more SQL statements for their side effects.
   *
   * @param sql - SQL text, e.g. a `PRAGMA` or a multi-statement schema.
   */
  exec(sql: string): void;
  /**
   * Compile `sql` into a reusable {@link SqliteStatement}.
   *
   * @param sql - A single SQL statement with `?` positional placeholders.
   * @returns The prepared statement, ready to bind and execute.
   */
  prepare(sql: string): SqliteStatement;
  /**
   * Wrap `fn` so that each invocation runs inside a single transaction.
   *
   * The returned function commits when `fn` returns and rolls back if it throws,
   * re-raising the original error.
   *
   * @param fn - The body to run transactionally; receives the caller's argument.
   * @returns A function that runs `fn` atomically.
   */
  transaction<T>(fn: (arg: T) => void): (arg: T) => void;
  /** Close the connection and release its resources. */
  close(): void;
  /** The underlying backend handle, opaque to the store. */
  readonly native: unknown;
}
