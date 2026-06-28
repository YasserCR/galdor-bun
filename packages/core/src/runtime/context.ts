/**
 * Per-run execution context shared across the library's blocking calls.
 *
 * Rather than relying on ambient state, galdor passes a small, explicit
 * {@link RunContext} object down through every operation. It carries the
 * cancellation/deadline {@link RunContext.signal | signal}, a
 * {@link RunContext.runId | runId} for trace attribution, and an optional bag
 * of request-scoped {@link RunContext.values | values}.
 */

/**
 * Request-scoped state threaded through a single run.
 *
 * @example
 * ```ts
 * const ctrl = new AbortController();
 * const ctx: RunContext = { signal: ctrl.signal, runId: "run-123" };
 * await provider.generate(req, ctx);
 * ```
 */
export interface RunContext {
  /** Cancellation and deadline source; aborting it stops in-flight work. */
  signal?: AbortSignal;
  /** Identifier used to attribute traces and logs to this run. */
  runId?: string;
  /** Free-form values scoped to the lifetime of the run. */
  values?: Map<string, unknown>;
}

/**
 * Minimal structured logger the runtime uses to surface recovered exceptions,
 * hook failures, and deadline fires.
 *
 * Supply any implementation (a thin wrapper over `console`, `pino`, etc.). When
 * no logger is provided those events are silently dropped.
 */
export interface Logger {
  /**
   * Record a warning-level event.
   *
   * @param message - Human-readable description of the event.
   * @param fields - Optional structured key/value context.
   */
  warn(message: string, fields?: Record<string, unknown>): void;
}
