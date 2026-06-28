/**
 * core/store — the Bun-backed SQLite driver.
 *
 * Adapts the Bun runtime's built-in `bun:sqlite` to the {@link SqliteDriver}
 * contract. This module statically imports `bun:sqlite`, so it must only ever be
 * loaded under Bun; the store reaches it through a runtime-guarded `require` and
 * never imports it on other runtimes.
 *
 * `INTEGER` columns are returned as `bigint` by opening the database with the
 * `safeIntegers: true` constructor option, which makes every statement on the
 * connection both read and bind integers as `bigint` — keeping the nanosecond
 * span timestamps exact.
 */

import { Database } from "bun:sqlite";
import type { SqlParam, SqliteDriver, SqliteStatement } from "./driver.ts";

/** Loosely-typed view of a `bun:sqlite` prepared statement. */
interface BunStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

function wrapStatement(stmt: BunStatement): SqliteStatement {
  return {
    run(...params: SqlParam[]): void {
      stmt.run(...params);
    },
    all<T>(...params: SqlParam[]): T[] {
      return stmt.all(...params) as T[];
    },
    get<T>(...params: SqlParam[]): T | undefined {
      return (stmt.get(...params) as T | null) ?? undefined;
    },
  };
}

/**
 * Open a `bun:sqlite` database and adapt it to the {@link SqliteDriver} contract.
 *
 * @param path - Filesystem path, or `":memory:"`, for the database to open or
 *   create.
 * @returns A driver backed by Bun's native SQLite, reading `INTEGER` as `bigint`.
 */
export function openBunDriver(path: string): SqliteDriver {
  // safeIntegers: read INTEGER columns as bigint and bind bigint, so the
  // nanosecond timestamps survive without float64 precision loss.
  const db = new Database(path, { create: true, safeIntegers: true });
  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): SqliteStatement {
      return wrapStatement(db.query(sql) as unknown as BunStatement);
    },
    transaction<T>(fn: (arg: T) => void): (arg: T) => void {
      return db.transaction(fn) as unknown as (arg: T) => void;
    },
    close(): void {
      db.close();
    },
    get native(): unknown {
      return db;
    },
  };
}
