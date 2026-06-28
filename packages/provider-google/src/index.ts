/**
 * @galdor/provider-google — Google (Gemini / Generative Language API) adapter.
 *
 * Implements galdor's {@link Provider} interface over the AI Studio
 * /v1beta/models/{model}:generateContent surface, supporting tool calling,
 * vision input, thinking and structured output. It speaks the raw HTTP wire
 * format directly, with no third-party SDK dependency. Construct one with
 * {@link newGoogle}.
 *
 * @example
 * const provider = newGoogle({ apiKey: process.env.GEMINI_API_KEY! });
 * const res = await provider.generate({
 *   model: "gemini-2.5-flash",
 *   messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
 * });
 */

import {
  APIError,
  type Capabilities,
  classify,
  type Event,
  type Provider,
  type Request,
  type Response,
  type RunContext,
} from "@galdor/core/provider";
import { buildRequest, type GenerateResponse, responseFromWire } from "./convert.ts";
import { normalizeHTTPError } from "./errors.ts";
import { streamGenerateContent } from "./stream.ts";

const PROVIDER_NAME = "google";
/** AI Studio / Generative Language API endpoint, including the version segment. */
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Configuration for a {@link GoogleProvider}. */
export interface Config {
  /** Authenticates against the AI Studio API. Required (AI Studio keys begin with "AIza"). */
  apiKey: string;
  /** Overrides the API endpoint. Default generativelanguage.googleapis.com/v1beta. */
  baseURL?: string;
  /** Appended to the default user-agent when non-empty. */
  userAgent?: string;
}

/**
 * Build the URL path for an operation on a model. The model id is percent-encoded
 * so an unusual value cannot inject extra path segments.
 *
 * @param model - The model identifier (e.g. "gemini-2.5-flash").
 * @param op - The operation, such as "generateContent" or "streamGenerateContent".
 * @returns A path like {@code /models/<model>:<op>}.
 */
function modelPath(model: string, op: string): string {
  return `/models/${encodeURIComponent(model)}:${op}`;
}

/**
 * galdor {@link Provider} backed by Google's Gemini Generative Language API.
 *
 * Offers {@link GoogleProvider.generate} for a single response and
 * {@link GoogleProvider.stream} for incremental events. Prefer {@link newGoogle}
 * to construct one.
 */
export class GoogleProvider implements Provider {
  readonly #apiKey: string;
  readonly #baseURL: string;
  readonly #userAgent: string;

  /**
   * @param cfg - Provider configuration; {@code apiKey} is required.
   * @throws {Error} When {@code cfg.apiKey} is missing or blank.
   */
  constructor(cfg: Config) {
    if (!cfg.apiKey || cfg.apiKey.trim() === "") throw new Error("google: apiKey is required");
    this.#apiKey = cfg.apiKey;
    this.#baseURL = (cfg.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#userAgent = cfg.userAgent ?? "";
  }

  /** @returns The stable provider identifier, {@code "google"}. */
  name(): string {
    return PROVIDER_NAME;
  }

  /**
   * Report the features this adapter supports.
   *
   * @returns The {@link Capabilities} flags; promptCaching is false because cache
   * hints are not yet wired into a CachedContent resource, and maxContextTokens
   * reflects Gemini 2.5-class context windows.
   */
  capabilities(): Capabilities {
    // promptCaching is reported false: this adapter does not yet wire cache
    // hints into a CachedContent resource. maxContextTokens reflects Gemini
    // 2.5-class context windows.
    return {
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      promptCaching: false,
      visionInput: true,
      reasoning: true,
      maxContextTokens: 1_048_576,
    };
  }

  /** Build the per-request headers, including the API key and an optional user-agent suffix. */
  #headers(): Record<string, string> {
    let ua = "galdor-google/0.1";
    if (this.#userAgent) ua += ` ${this.#userAgent}`;
    return {
      "x-goog-api-key": this.#apiKey,
      "content-type": "application/json",
      "user-agent": ua,
    };
  }

  /**
   * Run a single, non-streaming generateContent call and return the assembled
   * response.
   *
   * @param req - The request to send; {@code req.model} selects the model.
   * @param ctx - Optional run context; its {@code signal} cancels the request.
   * @returns The decoded galdor {@link Response}.
   * @throws {APIError} On a non-2xx response, an undecodable body, or a prompt blocked by the safety filter.
   */
  async generate(req: Request, ctx?: RunContext): Promise<Response> {
    const wire = buildRequest(req);
    const res = await fetch(`${this.#baseURL}${modelPath(req.model, "generateContent")}`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(wire),
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
    });
    if (Math.floor(res.status / 100) !== 2) throw await normalizeHTTPError(res);

    let body: GenerateResponse;
    let raw: string;
    try {
      raw = await res.text();
      body = JSON.parse(raw) as GenerateResponse;
    } catch (e) {
      throw classify(
        new APIError({
          kind: "server",
          provider: PROVIDER_NAME,
          statusCode: res.status,
          message: `decode response: ${(e as Error).message}`,
        }),
      );
    }
    // A prompt blocked by Gemini's safety filter comes back HTTP 200 with no
    // candidates and a blockReason. Surface it as an error, not an empty success.
    if ((body.candidates ?? []).length === 0 && body.promptFeedback?.blockReason) {
      throw classify(
        new APIError({
          kind: "invalid_request",
          provider: PROVIDER_NAME,
          statusCode: res.status,
          message: `prompt blocked by safety filter: ${body.promptFeedback.blockReason}`,
        }),
      );
    }
    return responseFromWire(body, new TextEncoder().encode(raw));
  }

  /**
   * Start a streaming generateContent call and return an async iterable of
   * provider {@link Event}s as they arrive.
   *
   * @param req - The request to send; {@code req.model} selects the model.
   * @param ctx - Optional run context; its {@code signal} cancels the stream.
   * @returns An async iterable of events ending with a synthesized MessageStop.
   * @throws {APIError} On a non-2xx response, an in-stream error frame, or a blocked prompt.
   */
  stream(req: Request, ctx?: RunContext): AsyncIterable<Event> {
    const wire = buildRequest(req);
    const url = `${this.#baseURL}${modelPath(req.model, "streamGenerateContent")}?alt=sse`;
    return streamGenerateContent(url, this.#headers(), wire, ctx?.signal);
  }
}

/**
 * Construct a {@link GoogleProvider} from configuration.
 *
 * @param cfg - Provider configuration; {@code apiKey} is required.
 * @returns A ready-to-use provider.
 * @throws {Error} When {@code cfg.apiKey} is missing or blank.
 * @example
 * const provider = newGoogle({ apiKey: "AIza..." });
 */
export function newGoogle(cfg: Config): GoogleProvider {
  return new GoogleProvider(cfg);
}

export { normalizeHTTPError } from "./errors.ts";
