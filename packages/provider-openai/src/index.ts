/**
 * @galdor/provider-openai — OpenAI (Chat Completions API) adapter.
 *
 * Implements the galdor {@link Provider} interface over /chat/completions, with
 * tool calling, vision input, structured output (`response_format` json_schema)
 * and SSE streaming.
 *
 * Because the OpenAI Chat Completions surface is the de facto wire standard, the
 * same adapter targets any OpenAI-compatible provider (Groq, Together, MiniMax,
 * Mistral, DeepSeek, vLLM, Ollama, ...) by pointing the `baseURL` config field at
 * their endpoint. The primary entry point is {@link newOpenAI}.
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
import { buildRequest, type ChatResponse, responseFromWire } from "./convert.ts";
import { normalizeHTTPError } from "./errors.ts";
import { streamChat } from "./stream.ts";

const PROVIDER_NAME = "openai";

/**
 * Default production API endpoint. It already includes the `/v1` path segment,
 * so the adapter only appends `/chat/completions` — the convention used by the
 * official OpenAI client libraries and by every OpenAI-compatible provider's
 * documentation.
 */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Configuration for an {@link OpenAIProvider}. */
export interface Config {
  /** Authenticates against the OpenAI API. Required. */
  apiKey: string;
  /**
   * Overrides the API endpoint. Default https://api.openai.com/v1. Set this to
   * point at an OpenAI-compatible provider (Groq, Together, MiniMax, Mistral,
   * DeepSeek, vLLM, Ollama, ...). The /v1 segment is part of the baseURL.
   */
  baseURL?: string;
  /** Sent as openai-organization when non-empty. */
  organization?: string;
  /** Sent as openai-project when non-empty. */
  project?: string;
  /** Appended to the default user-agent when non-empty. */
  userAgent?: string;
}

/**
 * galdor {@link Provider} backed by the OpenAI Chat Completions API (or any
 * OpenAI-compatible endpoint selected via {@link Config.baseURL}).
 *
 * Use {@link newOpenAI} to construct one, or instantiate directly.
 *
 * @example
 * ```ts
 * const provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });
 * const res = await provider.generate({ model: "gpt-4o-mini", messages });
 * ```
 */
export class OpenAIProvider implements Provider {
  readonly #apiKey: string;
  readonly #baseURL: string;
  readonly #organization: string;
  readonly #project: string;
  readonly #userAgent: string;

  /**
   * @param cfg - Provider configuration; `apiKey` is required.
   * @throws {Error} When `apiKey` is missing or blank.
   */
  constructor(cfg: Config) {
    if (!cfg.apiKey || cfg.apiKey.trim() === "") throw new Error("openai: apiKey is required");
    this.#apiKey = cfg.apiKey;
    this.#baseURL = (cfg.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#organization = cfg.organization ?? "";
    this.#project = cfg.project ?? "";
    this.#userAgent = cfg.userAgent ?? "";
  }

  /** @returns The provider's stable identifier, `"openai"`. */
  name(): string {
    return PROVIDER_NAME;
  }

  /** @returns The feature set this adapter supports. */
  capabilities(): Capabilities {
    // promptCaching is false: OpenAI's caching is automatic and ignores
    // CacheControl hints. maxContextTokens reflects the gpt-4o long-context tier.
    return {
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      promptCaching: false,
      visionInput: true,
      reasoning: true,
      maxContextTokens: 128_000,
    };
  }

  #headers(): Record<string, string> {
    let ua = "galdor-openai/0.1";
    if (this.#userAgent) ua += ` ${this.#userAgent}`;
    return {
      authorization: `Bearer ${this.#apiKey}`,
      "content-type": "application/json",
      "user-agent": ua,
      ...(this.#organization ? { "openai-organization": this.#organization } : {}),
      ...(this.#project ? { "openai-project": this.#project } : {}),
    };
  }

  /**
   * Run a single non-streaming completion.
   *
   * @param req - The galdor request to send.
   * @param ctx - Optional run context; its `signal` cancels the request.
   * @returns The decoded galdor {@link Response}.
   * @throws {APIError} When the API returns a non-2xx status, or when the body
   * cannot be decoded as JSON.
   */
  async generate(req: Request, ctx?: RunContext): Promise<Response> {
    const wire = buildRequest(req, false);
    const res = await fetch(`${this.#baseURL}/chat/completions`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(wire),
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
    });
    if (Math.floor(res.status / 100) !== 2) throw await normalizeHTTPError(res);

    const raw = new Uint8Array(await res.arrayBuffer());
    let body: ChatResponse;
    try {
      body = JSON.parse(new TextDecoder().decode(raw)) as ChatResponse;
    } catch (e) {
      throw classify(
        new APIError({ kind: "server", provider: PROVIDER_NAME, statusCode: res.status, message: `decode response: ${(e as Error).message}` }),
      );
    }
    return responseFromWire(body, raw);
  }

  /**
   * Run a streaming completion, yielding provider {@link Event}s as they arrive.
   *
   * @param req - The galdor request to send.
   * @param ctx - Optional run context; its `signal` cancels the stream.
   * @returns An async iterable of provider events ending in MessageStop.
   * @throws {APIError} When the initial response is non-2xx or an in-stream
   * error frame is received (surfaced while iterating).
   */
  stream(req: Request, ctx?: RunContext): AsyncIterable<Event> {
    const wire = buildRequest(req, true);
    return streamChat(`${this.#baseURL}/chat/completions`, this.#headers(), wire, ctx?.signal);
  }
}

/**
 * Construct an {@link OpenAIProvider}.
 *
 * @param cfg - Provider configuration; `apiKey` is required.
 * @returns A ready-to-use provider instance.
 * @throws {Error} When `apiKey` is missing or blank.
 * @example
 * ```ts
 * const provider = newOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
 * const res = await provider.generate({ model: "gpt-4o-mini", messages });
 * ```
 */
export function newOpenAI(cfg: Config): OpenAIProvider {
  return new OpenAIProvider(cfg);
}

export { normalizeHTTPError } from "./errors.ts";
