/**
 * Normalizes failed OpenAI HTTP responses into galdor's typed {@link APIError}
 * hierarchy. Maps the raw status code to an {@link ErrorKind}, then refines that
 * kind from OpenAI's structured `error.type` / `error.code` body when present,
 * and surfaces any `Retry-After` hint.
 */

import { APIError, classify, type ErrorKind, parseRetryAfter } from "@galdor/core/provider";

const PROVIDER_NAME = "openai";

interface OpenAIErrorBody {
  error?: { type?: string; code?: string; param?: string; message?: string };
}

/** Map a bare HTTP status code to a coarse {@link ErrorKind}. */
function kindForStatus(code: number): ErrorKind {
  if (code === 401 || code === 403) return "auth";
  if (code === 429) return "rate_limited";
  if (code >= 500) return "server";
  if (code >= 400) return "invalid_request";
  return "server";
}

/**
 * Refine an error classification from OpenAI's structured `error.type` and
 * `error.code` fields, used when the bare status code is too ambiguous to
 * classify on its own — for example, some OpenAI-compatible backends report a
 * blown context window as a generic 400.
 *
 * @param t - The OpenAI `error.type` discriminator, if any.
 * @param code - The OpenAI `error.code` discriminator, if any.
 * @returns The refined {@link ErrorKind}, or `undefined` when neither field is
 * recognized and the caller should fall back to the status-based kind.
 */
export function kindForType(t: string | undefined, code: string | undefined): ErrorKind | undefined {
  switch (t) {
    case "invalid_request_error":
      return code === "context_length_exceeded" ? "context_window" : "invalid_request";
    case "authentication_error":
    case "permission_error":
      return "auth";
    case "rate_limit_error":
    case "tokens_exceeded":
      return "rate_limited";
    case "server_error":
    case "internal_server_error":
      return "server";
  }
  switch (code) {
    case "context_length_exceeded":
      return "context_window";
    case "rate_limit_exceeded":
      return "rate_limited";
    case "invalid_api_key":
      return "auth";
  }
  return undefined;
}

/**
 * Minimal structural view of an HTTP response that {@link normalizeHTTPError}
 * needs: the status code, a header accessor, and a text body reader. Any Fetch
 * `Response` satisfies this shape.
 */
export interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/**
 * Convert a non-2xx OpenAI response into a typed, classified galdor
 * {@link APIError}.
 *
 * @param res - The failed HTTP response (status, headers, body).
 * @returns A classified {@link APIError} carrying the provider name, status
 * code, best-effort message, and any parsed `Retry-After` delay.
 * @example
 * ```ts
 * const res = await fetch(url, opts);
 * if (Math.floor(res.status / 100) !== 2) throw await normalizeHTTPError(res);
 * ```
 */
export async function normalizeHTTPError(res: ResponseLike): Promise<APIError> {
  const text = await res.text().catch(() => "");
  let kind = kindForStatus(res.status);
  let message = `openai: HTTP ${res.status}`;
  if (text) {
    try {
      const body = JSON.parse(text) as OpenAIErrorBody;
      if (body.error?.message) message = body.error.message;
      const k = kindForType(body.error?.type, body.error?.code);
      if (k) kind = k;
    } catch {
      /* non-JSON body: keep the status-based kind */
    }
  }
  const retryAfter = parseRetryAfter(res.headers.get("retry-after") ?? "", new Date());
  return classify(
    new APIError({ kind, provider: PROVIDER_NAME, statusCode: res.status, message, ...(retryAfter !== null ? { retryAfter } : {}) }),
  );
}
