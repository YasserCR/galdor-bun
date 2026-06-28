/**
 * Normalization of Anthropic HTTP failures into galdor's typed error surface.
 *
 * The Messages API signals failure both through the HTTP status code and through
 * a JSON `error.type` discriminator in the body. This module folds the two into
 * a single {@link ErrorKind}, preferring the body's classification when present
 * and falling back to the status code otherwise, then wraps the result in an
 * {@link APIError} so callers can branch on `instanceof` of the concrete error
 * subclasses produced by {@link classify}.
 */

import { APIError, classify, type ErrorKind, parseRetryAfter } from "@galdor/core/provider";

const PROVIDER_NAME = "anthropic";

/** Shape of the JSON error envelope returned by the Anthropic Messages API. */
interface AnthropicErrorBody {
  type?: string;
  error?: { type?: string; message?: string };
}

/** Map an HTTP status code to a galdor {@link ErrorKind} as a coarse fallback. */
function kindForStatus(code: number): ErrorKind {
  if (code === 401 || code === 403) return "auth";
  if (code === 429) return "rate_limited";
  if (code >= 500) return "server";
  if (code >= 400) return "invalid_request";
  return "server";
}

/**
 * Map Anthropic's `error.type` discriminator to a galdor {@link ErrorKind}.
 *
 * @returns The matching kind, or `undefined` when the type is unknown so the
 * caller can fall back to {@link kindForStatus}.
 */
function kindForType(t: string | undefined): ErrorKind | undefined {
  switch (t) {
    case "authentication_error":
    case "permission_error":
      return "auth";
    case "rate_limit_error":
    case "overloaded_error":
      return "rate_limited";
    case "invalid_request_error":
    case "not_found_error":
      return "invalid_request";
    case "api_error":
      return "server";
    default:
      return undefined;
  }
}

/**
 * Minimal structural view of a fetch `Response` needed to classify a failure.
 *
 * Accepting this narrow interface (rather than the full `Response`) keeps
 * {@link normalizeHTTPError} testable with lightweight stubs.
 */
export interface ResponseLike {
  /** HTTP status code of the failed response. */
  status: number;
  /** Header accessor; used to read `retry-after`. */
  headers: { get(name: string): string | null };
  /** Reads the full response body as text. */
  text(): Promise<string>;
}

/**
 * Convert a non-2xx Anthropic response into a typed galdor {@link APIError}.
 *
 * The body is read once and parsed as JSON; when it carries an `error.type`,
 * that classification wins over the status-derived kind, and the human-readable
 * `error.message` becomes the error message. A `retry-after` header, if present,
 * is parsed and attached. The result is passed through {@link classify} so the
 * caller receives the concrete error subclass for the kind.
 *
 * @param res - The failed response (or a structural stand-in).
 * @returns A classified {@link APIError} describing the failure.
 * @example
 * if (Math.floor(res.status / 100) !== 2) throw await normalizeHTTPError(res);
 */
export async function normalizeHTTPError(res: ResponseLike): Promise<APIError> {
  const text = await res.text().catch(() => "");
  let kind = kindForStatus(res.status);
  let message = `anthropic: HTTP ${res.status}`;
  if (text) {
    try {
      const body = JSON.parse(text) as AnthropicErrorBody;
      if (body.error?.message) message = body.error.message;
      const k = kindForType(body.error?.type);
      if (k) kind = k;
    } catch {
      /* non-JSON body: keep the status-derived kind and default message */
    }
  }
  const retryAfter = parseRetryAfter(res.headers.get("retry-after") ?? "", new Date());
  return classify(
    new APIError({ kind, provider: PROVIDER_NAME, statusCode: res.status, message, ...(retryAfter !== null ? { retryAfter } : {}) }),
  );
}

/**
 * Build a typed galdor {@link APIError} from an Anthropic streaming `error`
 * frame, which carries no HTTP status.
 *
 * The mid-stream `error` SSE event reports its `error.type` discriminator and a
 * human message but, unlike an HTTP failure, has no status code to fall back on.
 * The type is mapped through the same {@link kindForType} table used for HTTP
 * errors and defaults to `server` when unrecognized. The result is passed
 * through {@link classify} so the caller receives the concrete subclass.
 *
 * @param type - The `error.type` discriminator from the frame, if any.
 * @param message - The human-readable error message from the frame.
 * @returns A classified {@link APIError} with `statusCode` 0.
 */
export function classifyStreamError(type: string | undefined, message: string): APIError {
  const kind = kindForType(type) ?? "server";
  return classify(new APIError({ kind, provider: PROVIDER_NAME, statusCode: 0, message }));
}
