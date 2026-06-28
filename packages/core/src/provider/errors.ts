/**
 * core/provider/errors — typed provider errors.
 *
 * Defines the error hierarchy raised when a provider call fails. All errors
 * derive from {@link GaldorError}; transport and protocol failures derive from
 * {@link APIError}, which carries a stable {@link ErrorKind} discriminator.
 * Callers can branch with `instanceof` against the specific subclasses, or read
 * the {@link APIError.kind} string when the error has crossed a serialization
 * boundary and class identity is no longer available.
 */

/**
 * Stable, serialization-safe discriminator describing the category of an
 * {@link APIError}. Used by {@link classify} to select the concrete subclass and
 * by callers that cannot rely on `instanceof`.
 */
export type ErrorKind =
  | "unsupported"
  | "invalid_request"
  | "auth"
  | "rate_limited"
  | "server"
  | "context_window";

/** Root of the library's error hierarchy; every error raised by galdor extends this. */
export class GaldorError extends Error {
  override name = "GaldorError";
}

/**
 * Base class for all provider transport and protocol errors.
 *
 * Bundles the provider identity, HTTP status, and a {@link ErrorKind}
 * discriminator alongside the human-readable message, so callers have enough
 * context to decide whether to retry, re-auth, or surface the failure.
 */
export class APIError extends GaldorError {
  override name = "APIError";
  /** Category of the failure, used for branching and by {@link classify}. */
  readonly kind: ErrorKind;
  /** Name of the provider that produced the error. */
  readonly provider: string;
  /** HTTP status code returned by the provider, or 0 when not applicable. */
  readonly statusCode: number;
  /** Seconds to wait before retrying, if the provider advertised it. */
  readonly retryAfter?: number;

  /**
   * @param args - Error fields; `cause` is attached to the underlying `Error`
   *   when provided, and `retryAfter` is only set when supplied.
   */
  constructor(args: {
    kind: ErrorKind;
    provider: string;
    statusCode: number;
    message: string;
    retryAfter?: number;
    cause?: unknown;
  }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause });
    this.kind = args.kind;
    this.provider = args.provider;
    this.statusCode = args.statusCode;
    if (args.retryAfter !== undefined) this.retryAfter = args.retryAfter;
  }
}

/** Provider rejected the request because a rate limit was exceeded (`kind: "rate_limited"`). */
export class RateLimitError extends APIError {
  override name = "RateLimitError";
}
/** Authentication or authorization failed, e.g. a missing or invalid key (`kind: "auth"`). */
export class AuthError extends APIError {
  override name = "AuthError";
}
/** The request was malformed or otherwise rejected as invalid (`kind: "invalid_request"`). */
export class InvalidRequestError extends APIError {
  override name = "InvalidRequestError";
}
/** A transient server-side failure that is typically safe to retry (`kind: "server"`). */
export class TransientError extends APIError {
  override name = "TransientError";
}
/** The prompt exceeded the model's context window (`kind: "context_window"`). */
export class ContextLengthError extends APIError {
  override name = "ContextLengthError";
}
/** The requested capability is not supported by this provider (`kind: "unsupported"`). */
export class UnsupportedError extends APIError {
  override name = "UnsupportedError";
}

/**
 * Promote a generic {@link APIError} into the concrete subclass that matches its
 * {@link APIError.kind}, copying all fields across.
 *
 * @param err - A base {@link APIError} (or subclass) to refine.
 * @returns The matching subclass instance, or the original error unchanged when
 *   `kind` does not map to a known subclass.
 * @example
 * ```ts
 * const refined = classify(new APIError({
 *   kind: "rate_limited", provider: "acme", statusCode: 429, message: "slow down",
 * }));
 * refined instanceof RateLimitError; // true
 * ```
 */
export function classify(err: APIError): APIError {
  const args = {
    kind: err.kind,
    provider: err.provider,
    statusCode: err.statusCode,
    message: err.message,
    ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}),
  };
  switch (err.kind) {
    case "rate_limited":
      return new RateLimitError(args);
    case "auth":
      return new AuthError(args);
    case "invalid_request":
      return new InvalidRequestError(args);
    case "server":
      return new TransientError(args);
    case "context_window":
      return new ContextLengthError(args);
    case "unsupported":
      return new UnsupportedError(args);
    default:
      return err;
  }
}

/**
 * Parse an HTTP `Retry-After` header value into a number of seconds to wait.
 *
 * Accepts both supported forms: a delta-seconds integer, or an HTTP-date that is
 * measured relative to `now`. Past dates are clamped to 0.
 *
 * @param value - The raw header value (leading/trailing whitespace tolerated).
 * @param now - The reference time used to convert an HTTP-date into a delay.
 * @returns The delay in seconds, or `null` when the value cannot be parsed.
 * @example
 * ```ts
 * parseRetryAfter("30", new Date());                       // 30
 * parseRetryAfter("Thu, 25 Jun 2026 12:00:10 GMT", now);   // seconds until that date
 * ```
 */
export function parseRetryAfter(value: string, now: Date): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  // A bare integer is the delta-seconds form: use it directly.
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  // Otherwise treat it as an HTTP-date and measure the gap from `now`. Round
  // up so a sub-second remainder never lets a retry land before the server's
  // window.
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  const secs = Math.ceil((when - now.getTime()) / 1000);
  return secs >= 0 ? secs : 0;
}
