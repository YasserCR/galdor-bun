/**
 * Normalization of Bedrock Runtime failures into galdor's typed error surface.
 *
 * Bedrock signals failure through the HTTP status code, an `x-amzn-errortype`
 * header naming the exception, and/or a JSON body carrying `__type` and
 * `message`. This module folds those signals into a single {@link ErrorKind},
 * preferring the named exception over the status code, then wraps the result in
 * an {@link APIError} run through {@link classify} so callers can branch on the
 * concrete error subclasses. {@link streamException} applies the same mapping to
 * an exception delivered mid-stream as an event-stream frame.
 */

import { APIError, classify, type ErrorKind, parseRetryAfter } from "@galdor/core/provider";

const PROVIDER_NAME = "bedrock";

/** Shape of the JSON error envelope returned by the Bedrock Runtime API. */
interface BedrockErrorBody {
  __type?: string;
  message?: string;
  Message?: string;
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
 * Map a Bedrock exception name to a galdor {@link ErrorKind}.
 *
 * @returns The matching kind, or `undefined` when the exception is unknown so
 * the caller can fall back to {@link kindForStatus}.
 */
function kindForExceptionType(t: string | undefined): ErrorKind | undefined {
  switch (t) {
    case "ThrottlingException":
    case "TooManyRequestsException":
    case "ServiceQuotaExceededException":
    case "LimitExceededException":
      return "rate_limited";
    case "AccessDeniedException":
    case "UnauthorizedException":
    case "ExpiredTokenException":
      return "auth";
    case "ValidationException":
    case "BadRequestException":
    case "ResourceNotFoundException":
      return "invalid_request";
    case "InternalServerException":
    case "ServiceUnavailableException":
    case "ModelErrorException":
    case "ModelTimeoutException":
    case "ModelStreamErrorException":
      return "server";
    default:
      return undefined;
  }
}

/**
 * Extract the bare exception name from an `x-amzn-errortype` value or a `__type`
 * field, which may be decorated with a `namespace#` prefix or a `:url` suffix.
 */
function bareExceptionType(raw: string): string {
  let t = raw.trim();
  const colon = t.indexOf(":");
  if (colon !== -1) t = t.slice(0, colon);
  const hash = t.lastIndexOf("#");
  if (hash !== -1) t = t.slice(hash + 1);
  return t;
}

/**
 * Upper-case the first character of an exception name so it can be matched
 * against the PascalCase shape names in {@link kindForExceptionType}.
 *
 * Mid-stream exception frames name the exception in camelCase (e.g.
 * `throttlingException`), whereas the HTTP error path already yields PascalCase
 * (e.g. `ThrottlingException`); capitalizing the leading character normalizes
 * the former and is a no-op for the latter.
 */
function pascalExceptionType(t: string): string {
  return t.length === 0 ? t : t.charAt(0).toUpperCase() + t.slice(1);
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
  /** Header accessor; used to read `x-amzn-errortype` and `retry-after`. */
  headers: { get(name: string): string | null };
  /** Reads the full response body as text. */
  text(): Promise<string>;
}

/**
 * Convert a non-2xx Bedrock response into a typed galdor {@link APIError}.
 *
 * The body is read once and parsed as JSON; the exception name from the
 * `x-amzn-errortype` header (or the body's `__type`) classifies the failure when
 * recognized, otherwise the status code does, and the body's `message` becomes
 * the error text. A `retry-after` header, if present, is parsed and attached.
 *
 * @param res - The failed response (or a structural stand-in).
 * @returns A classified {@link APIError} describing the failure.
 */
export async function normalizeHTTPError(res: ResponseLike): Promise<APIError> {
  const text = await res.text().catch(() => "");
  let kind = kindForStatus(res.status);
  let message = `bedrock: HTTP ${res.status}`;

  const headerType = res.headers.get("x-amzn-errortype");
  let exceptionType = headerType ? bareExceptionType(headerType) : undefined;
  if (text) {
    try {
      const body = JSON.parse(text) as BedrockErrorBody;
      const msg = body.message ?? body.Message;
      if (msg) message = msg;
      if (!exceptionType && body.__type) exceptionType = bareExceptionType(body.__type);
    } catch {
      /* non-JSON body: keep the status-derived kind and default message */
    }
  }

  const k = kindForExceptionType(exceptionType);
  if (k) kind = k;
  const retryAfter = parseRetryAfter(res.headers.get("retry-after") ?? "", new Date());
  return classify(
    new APIError({ kind, provider: PROVIDER_NAME, statusCode: res.status, message, ...(retryAfter !== null ? { retryAfter } : {}) }),
  );
}

/**
 * Build a typed galdor {@link APIError} from an exception delivered inside the
 * event stream, classifying it by exception name and defaulting to a server
 * error when the name is unknown.
 *
 * @param exceptionType - The `:exception-type` header value, if any.
 * @param message - Human-readable detail extracted from the exception payload.
 * @returns A classified {@link APIError}.
 */
export function streamException(exceptionType: string | undefined, message: string): APIError {
  const normalized = exceptionType ? pascalExceptionType(bareExceptionType(exceptionType)) : undefined;
  const kind = kindForExceptionType(normalized) ?? "server";
  return classify(
    new APIError({ kind, provider: PROVIDER_NAME, statusCode: 0, message: message || `bedrock: stream ${exceptionType ?? "error"}` }),
  );
}
