/**
 * `@galdor/provider-anthropic` — Anthropic (Claude Messages API) adapter.
 *
 * Implements the galdor {@link Provider} interface over the `/v1/messages`
 * endpoint, supporting tool use, vision input, extended thinking, prompt
 * caching, and structured output (expressed as a forced single tool call). Both
 * a buffered {@link AnthropicProvider.generate} and an incremental
 * {@link AnthropicProvider.stream} path are provided; construct an instance with
 * {@link newAnthropic}.
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
import { buildRequest, extractStructuredOutput, type MessageResponse, responseFromWire } from "./convert.ts";
import { normalizeHTTPError } from "./errors.ts";
import { streamMessages } from "./stream.ts";

const PROVIDER_NAME = "anthropic";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_API_VERSION = "2023-06-01";

/** Construction options for an {@link AnthropicProvider}. */
export interface Config {
  /** Anthropic API key; required and must be non-empty. */
  apiKey: string;
  /** Overrides the API endpoint. Defaults to `https://api.anthropic.com`; trailing slashes are trimmed. */
  baseURL?: string;
  /** Value sent as the `anthropic-version` header. Defaults to `2023-06-01`. */
  apiVersion?: string;
  /** Suffix appended to the default user-agent when non-empty. */
  userAgent?: string;
}

/**
 * galdor {@link Provider} backed by the Anthropic Messages API.
 *
 * Holds connection settings and builds the per-request headers; the actual wire
 * translation and SSE handling live in the conversion and streaming helpers.
 * Prefer {@link newAnthropic} to construct one.
 */
export class AnthropicProvider implements Provider {
  readonly #apiKey: string;
  readonly #baseURL: string;
  readonly #apiVersion: string;
  readonly #userAgent: string;

  /**
   * Create a provider from the given {@link Config}.
   *
   * @throws {Error} When `apiKey` is missing or blank.
   */
  constructor(cfg: Config) {
    if (!cfg.apiKey || cfg.apiKey.trim() === "") throw new Error("anthropic: apiKey is required");
    this.#apiKey = cfg.apiKey;
    this.#baseURL = (cfg.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#apiVersion = cfg.apiVersion || DEFAULT_API_VERSION;
    this.#userAgent = cfg.userAgent ?? "";
  }

  /** @returns The provider's stable identifier, `"anthropic"`. */
  name(): string {
    return PROVIDER_NAME;
  }

  /** @returns The feature set this adapter supports, including the model context window. */
  capabilities(): Capabilities {
    return {
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      promptCaching: true,
      visionInput: true,
      reasoning: true,
      maxContextTokens: 200_000,
    };
  }

  /** Build the request headers, folding in any configured user-agent suffix. */
  #headers(): Record<string, string> {
    let ua = "galdor-anthropic/0.1";
    if (this.#userAgent) ua += ` ${this.#userAgent}`;
    return {
      "x-api-key": this.#apiKey,
      "anthropic-version": this.#apiVersion,
      "content-type": "application/json",
      "user-agent": ua,
    };
  }

  /**
   * Run a single buffered completion against `/v1/messages`.
   *
   * Lowers the request to the wire shape, POSTs it, decodes the full response,
   * and applies structured-output extraction when a `json_schema` format was
   * requested.
   *
   * @param req - The galdor request to run.
   * @param ctx - Optional run context; its abort signal cancels the request.
   * @returns The completed galdor {@link Response}.
   * @throws {APIError} On a non-2xx status or when the response body cannot be decoded.
   */
  async generate(req: Request, ctx?: RunContext): Promise<Response> {
    const wire = buildRequest(req, false);
    const res = await fetch(`${this.#baseURL}/v1/messages`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(wire),
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
    });
    if (Math.floor(res.status / 100) !== 2) throw await normalizeHTTPError(res);

    let body: MessageResponse;
    try {
      body = (await res.json()) as MessageResponse;
    } catch (e) {
      throw classify(
        new APIError({ kind: "server", provider: PROVIDER_NAME, statusCode: res.status, message: `decode response: ${(e as Error).message}` }),
      );
    }
    let out = responseFromWire(body);
    if (req.responseFormat?.type === "json_schema") out = extractStructuredOutput(out, req.responseFormat.name);
    return out;
  }

  /**
   * Run a streaming completion, yielding incremental provider events.
   *
   * @param req - The galdor request to run.
   * @param ctx - Optional run context; its abort signal cancels the stream.
   * @returns An async iterable of {@link Event}s ending with a message-stop event.
   */
  stream(req: Request, ctx?: RunContext): AsyncIterable<Event> {
    const wire = buildRequest(req, true);
    return streamMessages(`${this.#baseURL}/v1/messages`, this.#headers(), wire, ctx?.signal);
  }
}

/**
 * Construct an {@link AnthropicProvider} from a {@link Config}.
 *
 * @param cfg - Connection options; `apiKey` is required.
 * @returns A ready-to-use provider instance.
 * @throws {Error} When `apiKey` is missing or blank.
 * @example
 * const provider = newAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
 * const resp = await provider.generate({
 *   model: "claude-haiku-4-5",
 *   messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
 * });
 */
export function newAnthropic(cfg: Config): AnthropicProvider {
  return new AnthropicProvider(cfg);
}

export { normalizeHTTPError } from "./errors.ts";
