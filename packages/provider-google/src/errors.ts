/**
 * Error normalization for the Google provider: turns both HTTP failures and
 * in-stream error frames into galdor's typed {@link APIError}, classified by
 * kind ("auth", "rate_limited", "invalid_request", "server").
 */

import { APIError, classify, type ErrorKind, parseRetryAfter } from "@galdor/core/provider";
import type { WireErrorBody } from "./convert.ts";

const PROVIDER_NAME = "google";

interface ErrorResponse {
  error?: WireErrorBody;
}

/** Seed an {@link ErrorKind} from a bare HTTP status code, before any finer promotion. */
function kindForStatus(code: number): ErrorKind {
  if (code === 401 || code === 403) return "auth";
  if (code === 429) return "rate_limited";
  if (code >= 500) return "server";
  if (code >= 400) return "invalid_request";
  return "server";
}

/**
 * Classify by the canonical google.rpc.ErrorInfo.reason strings carried in
 * error.details[]. The reason is the most specific signal available: an invalid
 * API key arrives as HTTP 400 with status INVALID_ARGUMENT, and only the reason
 * (e.g. API_KEY_INVALID) reveals that it is really an auth failure.
 *
 * @param details - The details array from the wire error body, possibly absent.
 * @returns The promoted {@link ErrorKind}, or undefined when no reason matched.
 */
function kindForReason(details: WireErrorBody["details"]): ErrorKind | undefined {
  for (const d of details ?? []) {
    switch (d.reason) {
      case "API_KEY_INVALID":
      case "API_KEY_EXPIRED":
      case "API_KEY_MISSING":
      case "CREDENTIALS_MISSING":
      case "ACCESS_TOKEN_EXPIRED":
      case "CONSUMER_INVALID":
      case "CONSUMER_SUSPENDED":
      case "API_DISABLED":
      case "BILLING_DISABLED":
      case "SERVICE_DISABLED":
        return "auth";
      case "RATE_LIMIT_EXCEEDED":
      case "QUOTA_EXCEEDED":
      case "USER_PROJECT_DENIED":
        return "rate_limited";
    }
  }
  return undefined;
}

/**
 * Classify by Google's canonical error.status string (the gRPC status name such
 * as UNAUTHENTICATED or RESOURCE_EXHAUSTED).
 *
 * @returns The mapped {@link ErrorKind}, or undefined when the status is unknown.
 */
function kindForStatusName(s: string | undefined): ErrorKind | undefined {
  switch ((s ?? "").toUpperCase()) {
    case "UNAUTHENTICATED":
    case "PERMISSION_DENIED":
      return "auth";
    case "RESOURCE_EXHAUSTED":
      return "rate_limited";
    case "INVALID_ARGUMENT":
    case "FAILED_PRECONDITION":
    case "NOT_FOUND":
    case "OUT_OF_RANGE":
      return "invalid_request";
    case "INTERNAL":
    case "UNAVAILABLE":
    case "DEADLINE_EXCEEDED":
    case "UNKNOWN":
      return "server";
    default:
      return undefined;
  }
}

/** Minimal view of an HTTP response that {@link normalizeHTTPError} needs to read. */
export interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/**
 * Convert a Gemini non-2xx response into a typed galdor {@link APIError}. The
 * Generative Language API returns errors as either a JSON object
 * {@code {"error":{...}}} or, when the failure happens early enough, a JSON array
 * wrapping the same shape; both are handled. The kind is seeded from the HTTP
 * status and then promoted by details[].reason and status name when present, and
 * a Retry-After header (if any) is surfaced as {@code retryAfter}.
 *
 * @param res - The failed response; its body is read once via {@code text()}.
 * @returns A classified {@link APIError} ready to throw.
 * @example
 * if (res.status >= 400) throw await normalizeHTTPError(res);
 */
export async function normalizeHTTPError(res: ResponseLike): Promise<APIError> {
  const text = await res.text().catch(() => "");
  let kind = kindForStatus(res.status);
  let message = `google: HTTP ${res.status}`;

  let err: WireErrorBody | undefined;
  if (text) {
    try {
      const parsed = JSON.parse(text) as ErrorResponse | ErrorResponse[];
      if (Array.isArray(parsed)) {
        const first = parsed[0];
        if (first?.error?.message) err = first.error;
      } else if (parsed.error?.message) {
        err = parsed.error;
      }
    } catch {
      /* non-JSON body: keep status-based kind */
    }
  }

  if (err) {
    if (err.message) message = err.message;
    // Order matters: details[].reason > status > the bare HTTP code.
    const byReason = kindForReason(err.details);
    const byStatus = kindForStatusName(err.status);
    if (byReason) kind = byReason;
    else if (byStatus) kind = byStatus;
  }

  const retryAfter = parseRetryAfter(res.headers.get("retry-after") ?? "", new Date());
  return classify(
    new APIError({
      kind,
      provider: PROVIDER_NAME,
      statusCode: res.status,
      message,
      ...(retryAfter !== null ? { retryAfter } : {}),
    }),
  );
}

/**
 * Build a typed galdor {@link APIError} from an in-stream {@code {"error":{...}}}
 * frame, reusing the same reason/status classification as the HTTP path. The
 * embedded numeric code (an HTTP status) seeds the kind before the reason and
 * status-name promotions are applied.
 *
 * @param e - The error body decoded from a streamed error frame.
 * @returns A classified {@link APIError}.
 */
export function classifyStreamError(e: WireErrorBody): APIError {
  let kind = kindForStatus(e.code ?? 0);
  const byReason = kindForReason(e.details);
  const byStatus = kindForStatusName(e.status);
  if (byReason) kind = byReason;
  else if (byStatus) kind = byStatus;
  return classify(
    new APIError({
      kind,
      provider: PROVIDER_NAME,
      statusCode: e.code ?? 0,
      message: e.message ?? "",
    }),
  );
}
