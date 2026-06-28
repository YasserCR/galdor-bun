/**
 * core/embedder — a generic HTTP client for self-hosted embedding services.
 *
 * {@link HTTPEmbedder} implements the {@link Embedder} contract from
 * `../memory` and talks to a self-hosted server in one of two wire shapes: the
 * OpenAI `/v1/embeddings` JSON envelope, or the HuggingFace Text Embeddings
 * Inference (TEI) flat-array shape.
 *
 * Requests use the global `fetch`. Each call accepts an optional
 * `signal?: AbortSignal` for caller-driven cancellation and applies its own
 * per-request timeout through an internal `AbortController`. Vectors are
 * represented as `number[]`, and the embedding dimension can be configured up
 * front or learned from the first successful response.
 *
 * @example
 * ```ts
 * const embedder = new HTTPEmbedder({ url: "http://localhost:8080", shape: "tei" });
 * const vectors = await embedder.embed(["hello", "world"]);
 * // vectors.length === 2; embedder.dimensions() now reports the vector width.
 * ```
 */

import type { Embedder } from "../memory/index.ts";

/**
 * Wire format spoken by the embedding endpoint: the OpenAI `/v1/embeddings`
 * JSON envelope (`"openai"`) or the HuggingFace TEI flat-array shape (`"tei"`).
 */
export type Shape = "openai" | "tei";

/**
 * Configuration for an {@link HTTPEmbedder}.
 *
 * @property url Endpoint base URL. Required. The per-shape suffix (`/embed` for
 *   TEI or `/embeddings` for OpenAI) is appended when missing.
 * @property shape Wire format to use. Defaults to `"openai"`.
 * @property model Model name forwarded in the request body. OpenAI shape only.
 * @property apiKey Bearer token sent as `Authorization: Bearer <apiKey>` when set.
 * @property batchSize Maximum inputs per HTTP request. Defaults to 32.
 * @property timeoutMs Per-request timeout in milliseconds. Defaults to 60000.
 * @property dim When greater than 0, reported by {@link HTTPEmbedder.dimensions}
 *   and forwarded as the requested `dimensions` for the OpenAI shape.
 */
export interface HTTPConfig {
  url: string;
  shape?: Shape;
  model?: string;
  apiKey?: string;
  batchSize?: number;
  timeoutMs?: number;
  dim?: number;
}

/**
 * Error thrown for any non-2xx HTTP response from the embedding endpoint.
 *
 * @property status The HTTP status code returned by the server.
 * @property url The endpoint URL the request was sent to.
 * @property body The response body, trimmed and truncated to 512 bytes.
 */
export class EmbedError extends Error {
  override name = "EmbedError";
  readonly status: number;
  readonly url: string;
  readonly body: string;

  /**
   * Build an error describing a failed embedding request.
   *
   * @param status HTTP status code from the response.
   * @param url Endpoint URL the request targeted.
   * @param body Response body snippet (already trimmed/truncated by the caller).
   */
  constructor(status: number, url: string, body: string) {
    super(
      body === ""
        ? `embedder: HTTP ${status} from ${url}`
        : `embedder: HTTP ${status} from ${url}: ${body}`,
    );
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const BODY_SNIPPET_LIMIT = 512;

interface OpenAIRequest {
  input: string[];
  model?: string;
  dimensions?: number;
}

/**
 * An {@link Embedder} that produces vectors by calling a self-hosted HTTP
 * embedding service. A single instance is safe to share across concurrent
 * {@link HTTPEmbedder.embed} calls.
 *
 * @example
 * ```ts
 * const embedder = new HTTPEmbedder({
 *   url: "https://api.example.com/v1/embeddings",
 *   apiKey: process.env.EMBED_KEY,
 *   model: "text-embedding-3-small",
 * });
 * const [vector] = await embedder.embed(["the quick brown fox"]);
 * ```
 */
export class HTTPEmbedder implements Embedder {
  readonly #url: string;
  readonly #shape: Shape;
  readonly #model: string;
  readonly #apiKey: string;
  readonly #batchSize: number;
  readonly #timeoutMs: number;
  // May be configured up front or learned from the first response.
  #dim: number;

  /**
   * Validate the configuration and construct a ready-to-use embedder.
   *
   * @param cfg Endpoint and behavior settings. See {@link HTTPConfig}.
   * @throws {Error} If `url` is empty, or if `shape` is neither `"openai"` nor `"tei"`.
   */
  constructor(cfg: HTTPConfig) {
    if (cfg.url.trim() === "") {
      throw new Error("embedder: URL is required");
    }
    const shape: Shape = cfg.shape ?? "openai";
    if (shape !== "openai" && shape !== "tei") {
      throw new Error(`embedder: unknown shape "${String(shape)}"`);
    }
    const batch = cfg.batchSize !== undefined && cfg.batchSize > 0 ? cfg.batchSize : DEFAULT_BATCH_SIZE;
    const timeout =
      cfg.timeoutMs !== undefined && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;

    let u = cfg.url.replace(/\/+$/, "");
    if (shape === "tei") {
      if (!u.endsWith("/embed")) u += "/embed";
    } else if (!u.endsWith("/embeddings")) {
      u += "/embeddings";
    }

    this.#url = u;
    this.#shape = shape;
    this.#model = cfg.model ?? "";
    this.#apiKey = cfg.apiKey ?? "";
    this.#batchSize = batch;
    this.#timeoutMs = timeout;
    this.#dim = cfg.dim ?? 0;
  }

  /**
   * Embed a list of texts into vectors, preserving input order.
   *
   * Inputs beyond `batchSize` are split across multiple HTTP requests and the
   * results are re-assembled in order. Each request retries on transient
   * failures (5xx and 429) with exponential backoff. After the first batch, an
   * unconfigured dimension is learned from the returned vector width.
   *
   * @param texts Texts to embed. An empty array returns `[]` without any request.
   * @param signal Optional signal to cancel the in-flight requests.
   * @returns One vector per input, in the same order as `texts`.
   * @throws {EmbedError} On a non-2xx response (after exhausting retries for transient ones).
   * @throws {Error} On a malformed response, a vector-count mismatch, or cancellation.
   */
  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let start = 0; start < texts.length; start += this.#batchSize) {
      const end = Math.min(start + this.#batchSize, texts.length);
      const batch = texts.slice(start, end);
      const body = this.#encode(batch);
      const raw = await this.#doWithRetry(body, signal);
      const vecs = this.#decode(raw, batch.length);
      if (vecs.length !== batch.length) {
        throw new Error(`embedder: server returned ${vecs.length} vectors for ${batch.length} inputs`);
      }
      out.push(...vecs);
    }
    const first = out[0];
    if (this.#dim === 0 && first !== undefined && first.length > 0) {
      this.#dim = first.length;
    }
    return out;
  }

  /**
   * Report the embedding dimension: the value configured via `dim`, or the
   * width learned from the first successful {@link HTTPEmbedder.embed} call.
   *
   * @returns The vector dimension, or 0 if not yet configured or detected.
   */
  dimensions(): number {
    return this.#dim;
  }

  /**
   * Check connectivity by embedding a single throwaway input and discarding the result.
   *
   * @param signal Optional signal to cancel the request.
   * @throws {EmbedError} If the server returns a non-2xx response.
   */
  async ping(signal?: AbortSignal): Promise<void> {
    await this.embed(["ping"], signal);
  }

  #encode(texts: string[]): string {
    if (this.#shape === "tei") {
      return JSON.stringify({ inputs: texts });
    }
    const req: OpenAIRequest = { input: texts };
    if (this.#model !== "") req.model = this.#model;
    if (this.#dim > 0) req.dimensions = this.#dim;
    return JSON.stringify(req);
  }

  #decode(raw: string, n: number): number[][] {
    if (this.#shape === "tei") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw new Error(`embedder: decode tei response: ${errText(e)}`);
      }
      if (!Array.isArray(parsed)) {
        throw new Error("embedder: decode tei response: expected an array");
      }
      return parsed as number[][];
    }

    let env: unknown;
    try {
      env = JSON.parse(raw);
    } catch (e) {
      throw new Error(`embedder: decode openai response: ${errText(e)}`);
    }
    const data = isRecord(env) && Array.isArray(env.data) ? env.data : [];
    const vecs = new Array<number[] | undefined>(n);
    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      let idx = isRecord(d) && typeof d.index === "number" ? d.index : 0;
      if (idx < 0 || idx >= n) idx = i;
      if (idx >= n) {
        throw new Error(`embedder: openai response index ${idx} out of range`);
      }
      vecs[idx] = isRecord(d) ? (d.embedding as number[] | undefined) : undefined;
    }
    // Every input must have produced a vector. A short or duplicate-index
    // response leaves a hole — error instead of returning missing embeddings.
    for (let i = 0; i < n; i++) {
      if (vecs[i] == null) {
        throw new Error(
          `embedder: openai response missing embedding for input ${i} (${data.length} of ${n} returned)`,
        );
      }
    }
    return vecs as number[][];
  }

  async #doWithRetry(body: string, signal?: AbortSignal): Promise<string> {
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < DEFAULT_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(attempt, signal); // throws on cancellation
      }
      if (signal?.aborted) throw new Error("embedder: context canceled");

      let status: number;
      let text: string;
      try {
        ({ status, text } = await this.#fetchOnce(body, signal));
      } catch (e) {
        if (signal?.aborted) throw new Error("embedder: context canceled");
        // Timeout / network error: transient, retry.
        lastErr = e instanceof Error ? e : new Error(String(e));
        continue;
      }

      if (status >= 200 && status < 300) return text;
      // Transient: 5xx + 429. Other 4xx is terminal.
      if (status >= 500 || status === 429) {
        lastErr = new EmbedError(status, this.#url, snippet(text));
        continue;
      }
      throw new EmbedError(status, this.#url, snippet(text));
    }
    throw lastErr ?? new Error("embedder: exhausted retries");
  }

  async #fetchOnce(body: string, signal?: AbortSignal): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const onAbort = () => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.#apiKey !== "") headers.Authorization = `Bearer ${this.#apiKey}`;
    try {
      const resp = await fetch(this.#url, { method: "POST", headers, body, signal: controller.signal });
      const text = await resp.text();
      return { status: resp.status, text };
    } finally {
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Back off 100ms · 2^(attempt-1) + deterministic jitter, honoring cancellation. */
function sleep(attempt: number, signal?: AbortSignal): Promise<void> {
  let base = 100;
  for (let i = 1; i < attempt; i++) base *= 2;
  const ms = base + attempt * 37;
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("embedder: context canceled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal !== undefined) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error("embedder: context canceled"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function snippet(b: string): string {
  const s = b.trim();
  return s.length > BODY_SNIPPET_LIMIT ? s.slice(0, BODY_SNIPPET_LIMIT) : s;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
