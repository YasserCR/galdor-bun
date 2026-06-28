/**
 * core/store — the Node-backed SQLite driver.
 *
 * Adapts Node's built-in `node:sqlite` to the {@link SqliteDriver} contract.
 * `node:sqlite` ships with every supported runtime (Node >= 22.5), so it is the
 * default path. As an escape hatch for older runtimes, the driver also tries a
 * `better-sqlite3` package if one is present — that package is NOT a declared
 * dependency, so install it yourself only if you need that fallback. The store
 * reaches this module through a runtime-guarded `require`, so Bun never loads it.
 *
 * `INTEGER` columns are returned as `bigint`:
 *  - under `node:sqlite`, by calling `statement.setReadBigInts(true)` on every
 *    prepared statement;
 *  - under `better-sqlite3`, by calling `statement.safeIntegers(true)`.
 *
 * Either way, `bigint` bind values are passed through unchanged, so the
 * nanosecond span timestamps round-trip exactly. Neither backend exposes a
 * transaction helper we rely on, so {@link openNodeDriver} brackets the work
 * with explicit `BEGIN`/`COMMIT`/`ROLLBACK`.
 */

import { createRequire } from "node:module";
import type { SqlParam, SqliteDriver, SqliteStatement } from "./driver.ts";

const require = createRequire(import.meta.url);

/** Loosely-typed view of a prepared statement from either Node backend. */
interface NodeStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  /** Present on `node:sqlite` statements. */
  setReadBigInts?(readBigInts: boolean): unknown;
  /** Present on `better-sqlite3` statements. */
  safeIntegers?(toggle: boolean): unknown;
}

/** Loosely-typed view of a database handle from either Node backend. */
interface NodeDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): NodeStatement;
  close(): unknown;
}

function wrapStatement(stmt: NodeStatement): SqliteStatement {
  // Read INTEGER columns as bigint so nanosecond timestamps stay exact. Both
  // toggles are idempotent and harmless on write-only statements.
  if (typeof stmt.setReadBigInts === "function") stmt.setReadBigInts(true);
  if (typeof stmt.safeIntegers === "function") stmt.safeIntegers(true);
  return {
    run(...params: SqlParam[]): void {
      stmt.run(...params);
    },
    all<T>(...params: SqlParam[]): T[] {
      return stmt.all(...params) as T[];
    },
    get<T>(...params: SqlParam[]): T | undefined {
      return (stmt.get(...params) as T | undefined) ?? undefined;
    },
  };
}

/** Open a `node:sqlite` database, or `undefined` if the backend is unavailable. */
function openNodeSqlite(path: string): NodeDatabase | undefined {
  let DatabaseSync: new (p: string) => NodeDatabase;
  try {
    ({ DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (p: string) => NodeDatabase;
    });
  } catch {
    return undefined;
  }
  return new DatabaseSync(path);
}

/** Open a `better-sqlite3` database as the fallback backend. */
function openBetterSqlite(path: string): NodeDatabase {
  const BetterSqlite = require("better-sqlite3") as new (p: string) => NodeDatabase;
  return new BetterSqlite(path);
}

/**
 * Open a Node SQLite database and adapt it to the {@link SqliteDriver} contract.
 *
 * Prefers Node's built-in `node:sqlite`; if that backend is unavailable, loads
 * the optional `better-sqlite3` dependency instead.
 *
 * @param path - Filesystem path, or `":memory:"`, for the database to open or
 *   create.
 * @returns A driver backed by Node SQLite, reading `INTEGER` as `bigint`.
 * @throws {Error} If neither `node:sqlite` nor `better-sqlite3` can be loaded.
 */
export function openNodeDriver(path: string): SqliteDriver {
  const db = openNodeSqlite(path) ?? openBetterSqlite(path);
  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): SqliteStatement {
      return wrapStatement(db.prepare(sql));
    },
    transaction<T>(fn: (arg: T) => void): (arg: T) => void {
      return (arg: T): void => {
        db.exec("BEGIN");
        try {
          fn(arg);
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      };
    },
    close(): void {
      db.close();
    },
    get native(): unknown {
      return db;
    },
  };
}
