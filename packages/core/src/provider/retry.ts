/**
 * core/provider/retry — a transient-failure retry decorator.
 *
 * {@link withRetry} wraps a {@link Provider} so transient failures (rate
 * limits and 5xx-class server errors) are retried with exponential backoff and
 * jitter, while permanent failures (auth, invalid request, unsupported,
 * context-window) and cancellation surface immediately. It is opt-in: provider
 * adapters do not install it automatically.
 *
 * Delays are expressed in milliseconds. A server's `Retry-After` (carried on
 * {@link APIError.retryAfter}, in seconds) is honored as a floor: the next
 * attempt never lands before the server's window, and if the server asks for
 * longer than {@link RetryConfig.maxDelay} the wrapper gives up rather than
 * retry early.
 */

import { APIError, GaldorError } from "./errors.ts";
import {
  type Event,
  EventType,
  type Provider,
  type Request,
  type Response,
  type RunContext,
} from "./index.ts";

/**
 * Configuration for {@link withRetry}. Every field is optional; omitted or
 * non-positive fields fall back to {@link defaultRetryConfig}.
 */
export interface RetryConfig {
  /**
   * Total number of tries, not extra retries. 1 disables retry; 3 means up to
   * two retries after the initial call. Defaults to 3.
   */
  maxAttempts?: number;
  /** Wait before the second attempt, in milliseconds. Defaults to 1000. */
  initialDelay?: number;
  /** Upper bound on any single wait, in milliseconds. Defaults to 30000. */
  maxDelay?: number;
  /**
   * Factor the delay grows by between attempts. Defaults to 2; pass 1 for a
   * fixed interval. Values below 1 are clamped up to 1.
   */
  multiplier?: number;
  /**
   * Fractional randomness applied to each delay. The default 0.25 multiplies
   * each delay by a random factor in [0.75, 1.25]. A negative value disables
   * jitter for deterministic backoff; the zero value cannot mean "off" without
   * also breaking the sensible default, so use a negative value to turn it off.
   */
  jitter?: number;
  /**
   * Invoked before each retry sleep with the upcoming attempt number, the
   * planned delay in milliseconds, and the error that triggered the retry.
   */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  /** Clock function; defaults to {@link Date.now}. Reserved for callers and tests. */
  now?: () => number;
}

/** A fully-resolved {@link RetryConfig} with every field populated. */
interface ResolvedRetryConfig {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  multiplier: number;
  jitter: number;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  now: () => number;
}

/**
 * The package retry defaults: 3 attempts, 1s→30s exponential backoff (×2),
 * ±25% jitter.
 */
export const defaultRetryConfig: Readonly<Required<Omit<RetryConfig, "onRetry">>> = Object.freeze({
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  multiplier: 2,
  jitter: 0.25,
  now: Date.now,
});

/**
 * Cap on a server's `Retry-After` so a hostile or buggy value can't overflow
 * the delay arithmetic: 24 hours, far beyond any legitimate hint.
 */
const maxRetryAfterSeconds = 24 * 60 * 60;

/** Fill a {@link RetryConfig}'s omitted or non-positive fields from the defaults. */
function withDefaults(cfg: RetryConfig): ResolvedRetryConfig {
  let maxAttempts = cfg.maxAttempts ?? 0;
  if (maxAttempts <= 0) maxAttempts = 3;
  let initialDelay = cfg.initialDelay ?? 0;
  if (initialDelay <= 0) initialDelay = 1000;
  let maxDelay = cfg.maxDelay ?? 0;
  if (maxDelay <= 0) maxDelay = 30000;
  let multiplier = cfg.multiplier ?? 0;
  if (multiplier === 0) multiplier = 2;
  // A multiplier below 1 is nonsensical for backoff (it would shrink the delay
  // toward zero and spin). Clamp to the fixed-interval floor; callers wanting a
  // fixed interval pass 1.
  if (multiplier < 1) multiplier = 1;
  let jitter = cfg.jitter ?? 0;
  if (jitter === 0) jitter = 0.25;
  const resolved: ResolvedRetryConfig = {
    maxAttempts,
    initialDelay,
    maxDelay,
    multiplier,
    jitter,
    now: cfg.now ?? Date.now,
  };
  if (cfg.onRetry !== undefined) resolved.onRetry = cfg.onRetry;
  return resolved;
}

/**
 * Wrap `inner` with automatic retries for transient errors.
 *
 * Rate-limit and server errors are retried with exponential backoff; a
 * server's `Retry-After` takes precedence when present. Auth, invalid-request,
 * unsupported, and context-window errors, plus cancellation, are surfaced
 * immediately. Streaming is retried only at construction time — once the first
 * event is produced, later frame errors are surfaced verbatim.
 *
 * @param inner - The provider to wrap.
 * @param config - Optional overrides; omitted fields use {@link defaultRetryConfig}.
 * @returns A provider that retries transient failures of `inner`.
 */
export function withRetry(inner: Provider, config: RetryConfig = {}): Provider {
  return new RetryProvider(inner, withDefaults(config));
}

/**
 * Wrap `inner` with {@link withRetry} using {@link defaultRetryConfig}.
 *
 * @param inner - The provider to wrap.
 * @returns A provider with the default retry policy applied.
 */
export function withDefaultRetry(inner: Provider): Provider {
  return withRetry(inner, {});
}

/**
 * Report whether `err` is a transient failure worth retrying — a rate-limit or
 * server error. Auth, invalid-request, unsupported, context-window, and
 * non-provider errors are not retryable. The error's category is read from the
 * nearest {@link APIError} in its cause chain.
 *
 * @param err - The error to classify.
 * @returns `true` for rate-limit and server errors, `false` otherwise.
 */
export function isRetryable(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const api = findAPIError(err);
  if (api === undefined) return false;
  if (api.kind === "rate_limited") return true;
  if (api.kind === "server") return true;
  return false;
}

/** Walk the cause chain of `err` and return the nearest {@link APIError}, if any. */
function findAPIError(err: unknown): APIError | undefined {
  let cur: unknown = err;
  while (cur !== null && cur !== undefined) {
    if (cur instanceof APIError) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Provider decorator that retries transient failures of an inner provider. */
class RetryProvider implements Provider {
  #inner: Provider;
  #cfg: ResolvedRetryConfig;

  constructor(inner: Provider, cfg: ResolvedRetryConfig) {
    this.#inner = inner;
    this.#cfg = cfg;
  }

  name(): string {
    return this.#inner.name();
  }

  capabilities() {
    return this.#inner.capabilities();
  }

  async generate(req: Request, ctx?: RunContext): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.#cfg.maxAttempts; attempt++) {
      ctx?.signal?.throwIfAborted();
      try {
        return await this.#inner.generate(req, ctx);
      } catch (err) {
        if (!isRetryable(err)) throw err;
        lastErr = err;
        if (attempt >= this.#cfg.maxAttempts) break;
        const [delay, ok] = this.#nextDelay(attempt, err);
        if (!ok) break;
        this.#cfg.onRetry?.(attempt + 1, delay, err);
        await sleepCtx(ctx, delay);
      }
    }
    throw exhausted(this.#cfg.maxAttempts, lastErr);
  }

  async *stream(req: Request, ctx?: RunContext): AsyncIterable<Event> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.#cfg.maxAttempts; attempt++) {
      ctx?.signal?.throwIfAborted();
      const it = this.#inner.stream(req, ctx)[Symbol.asyncIterator]();
      let first: IteratorResult<Event>;
      try {
        first = await it.next();
      } catch (err) {
        if (!isRetryable(err)) throw err;
        lastErr = err;
        if (attempt >= this.#cfg.maxAttempts) break;
        const [delay, ok] = this.#nextDelay(attempt, err);
        if (!ok) break;
        this.#cfg.onRetry?.(attempt + 1, delay, err);
        await sleepCtx(ctx, delay);
        continue;
      }
      // Construction succeeded; frame errors past this point surface verbatim.
      if (!first.done) yield first.value;
      while (true) {
        const next = await it.next();
        if (next.done) return;
        yield next.value;
      }
    }
    throw exhausted(this.#cfg.maxAttempts, lastErr);
  }

  /**
   * Compute the delay before the next attempt and whether to retry at all. A
   * server's `Retry-After` is honored as a floor within {@link maxDelay}
   * (jittered upward only); when it exceeds {@link maxDelay} the wrapper gives
   * up. Otherwise an exponential schedule, jittered both ways and capped at
   * {@link maxDelay}, is used.
   */
  #nextDelay(attempt: number, err: unknown): [number, boolean] {
    const api = findAPIError(err);
    if (api !== undefined && api.retryAfter !== undefined && api.retryAfter > 0) {
      let secs = api.retryAfter;
      if (secs > maxRetryAfterSeconds) secs = maxRetryAfterSeconds;
      const d = secs * 1000;
      // The server wants longer than the caller tolerates: give up rather than
      // retry before the server's window (another guaranteed rejection).
      if (d > this.#cfg.maxDelay) return [0, false];
      let jittered = applyJitterUp(d, this.#cfg.jitter);
      if (jittered > this.#cfg.maxDelay) jittered = this.#cfg.maxDelay;
      return [jittered, true];
    }
    // Exponential schedule. Saturate at maxDelay during the climb so a large
    // attempt count can't overflow; multiplier is clamped >= 1 so f only grows.
    const maxF = this.#cfg.maxDelay;
    let f = this.#cfg.initialDelay;
    for (let i = 1; i < attempt; i++) {
      f *= this.#cfg.multiplier;
      if (f >= maxF) {
        f = maxF;
        break;
      }
    }
    let d = applyJitter(f, this.#cfg.jitter);
    if (d < 0 || d > this.#cfg.maxDelay) d = this.#cfg.maxDelay;
    return [d, true];
  }
}

/** Multiply `d` by a random factor in [1-j, 1+j]; returns `d` unchanged when j or d is non-positive. */
function applyJitter(d: number, j: number): number {
  if (j <= 0 || d <= 0) return d;
  if (j > 1) j = 1;
  const factor = 1 + (Math.random() * 2 - 1) * j;
  return d * factor;
}

/** Add jitter in [0, j] only, so the result is never below `d`; used for server-mandated delays. */
function applyJitterUp(d: number, j: number): number {
  if (j <= 0 || d <= 0) return d;
  if (j > 1) j = 1;
  const factor = 1 + Math.random() * j;
  return d * factor;
}

/** Build the error returned when every attempt has been exhausted, preserving the last error as `cause`. */
function exhausted(maxAttempts: number, lastErr: unknown): GaldorError {
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  return new GaldorError(`provider: exhausted ${maxAttempts} attempts: ${detail}`, {
    cause: lastErr,
  });
}

/**
 * Sleep for `ms` milliseconds, or reject early if `ctx`'s signal aborts.
 *
 * @param ctx - Optional run context carrying an abort signal.
 * @param ms - Milliseconds to wait; non-positive values resolve immediately.
 */
function sleepCtx(ctx: RunContext | undefined, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  const signal = ctx?.signal;
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
