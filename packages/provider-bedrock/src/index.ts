/**
 * `@galdor/provider-bedrock` — Amazon Bedrock (Anthropic Claude on the Bedrock
 * Runtime) adapter.
 *
 * Implements the galdor {@link Provider} interface over the Bedrock Runtime
 * Converse and ConverseStream endpoints, supporting tool use, vision input and
 * extended thinking. Requests are authenticated with AWS Signature Version 4
 * (see {@link signRequest}) rather than a bearer token. Both a buffered
 * {@link BedrockProvider.generate} and an incremental
 * {@link BedrockProvider.stream} path are provided; construct an instance with
 * {@link newBedrock}.
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
import { buildConverseRequest, type ConverseResponse, responseFromWire } from "./convert.ts";
import { normalizeHTTPError } from "./errors.ts";
import { encodeRfc3986, signRequest } from "./sigv4.ts";
import { streamConverse } from "./stream.ts";

const PROVIDER_NAME = "bedrock";
const SERVICE_NAME = "bedrock";
const CONTENT_TYPE = "application/json";

/** Construction options for a {@link BedrockProvider}. */
export interface Config {
  /** AWS region hosting the Bedrock Runtime, e.g. `"us-east-1"`. Required. */
  region: string;
  /** AWS access key id. Required. */
  accessKeyId: string;
  /** AWS secret access key. Required. */
  secretAccessKey: string;
  /** Temporary-credential session token; attached as `x-amz-security-token` when set. */
  sessionToken?: string;
  /** Overrides the endpoint. Defaults to `https://bedrock-runtime.<region>.amazonaws.com`; trailing slashes are trimmed. */
  baseURL?: string;
}

/**
 * Build the default Bedrock Runtime endpoint for a region; Bedrock has no global
 * endpoint, so the region is always part of the host.
 */
function defaultBaseURL(region: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

/**
 * galdor {@link Provider} backed by the Bedrock Runtime Converse API.
 *
 * Holds the region, credentials and endpoint, and signs each request with
 * SigV4; the wire translation lives in the conversion helper and the streaming
 * decode in the streaming helper. Prefer {@link newBedrock} to construct one.
 */
export class BedrockProvider implements Provider {
  readonly #region: string;
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;
  readonly #sessionToken: string;
  readonly #baseURL: string;

  /**
   * Create a provider from the given {@link Config}.
   *
   * @throws {Error} When `region`, `accessKeyId` or `secretAccessKey` is missing or blank.
   */
  constructor(cfg: Config) {
    if (!cfg.region || cfg.region.trim() === "") throw new Error("bedrock: region is required");
    if (!cfg.accessKeyId || cfg.accessKeyId.trim() === "") throw new Error("bedrock: accessKeyId is required");
    if (!cfg.secretAccessKey || cfg.secretAccessKey.trim() === "") throw new Error("bedrock: secretAccessKey is required");
    this.#region = cfg.region;
    this.#accessKeyId = cfg.accessKeyId;
    this.#secretAccessKey = cfg.secretAccessKey;
    this.#sessionToken = cfg.sessionToken ?? "";
    this.#baseURL = (cfg.baseURL || defaultBaseURL(cfg.region)).replace(/\/+$/, "");
  }

  /** @returns The provider's stable identifier, `"bedrock"`. */
  name(): string {
    return PROVIDER_NAME;
  }

  /**
   * @returns The feature set this adapter supports.
   *
   * Structured output and prompt caching are reported `false`: the Converse API
   * can express both, but this adapter does not yet wire them, so reporting them
   * honestly lets callers fall back rather than silently lose the feature.
   */
  capabilities(): Capabilities {
    return {
      streaming: true,
      toolCalling: true,
      structuredOutput: false,
      promptCaching: false,
      visionInput: true,
      reasoning: true,
      maxContextTokens: 200_000,
    };
  }

  /** Sign a request and return the headers to attach to `fetch`. */
  #sign(method: string, url: string, body: string): Record<string, string> {
    return signRequest({
      method,
      url,
      service: SERVICE_NAME,
      region: this.#region,
      credentials: {
        accessKeyId: this.#accessKeyId,
        secretAccessKey: this.#secretAccessKey,
        ...(this.#sessionToken ? { sessionToken: this.#sessionToken } : {}),
      },
      contentType: CONTENT_TYPE,
      body,
    });
  }

  /** Build the `/model/{id}/{action}` endpoint, percent-encoding the model id. */
  #endpoint(model: string, action: string): string {
    return `${this.#baseURL}/model/${encodeRfc3986(model)}/${action}`;
  }

  /**
   * Run a single buffered completion against the Converse endpoint.
   *
   * Lowers the request to the Converse wire shape, signs and POSTs it, then
   * decodes the full response. When `toolChoice` is `"none"` — which Converse
   * cannot express natively — any tool calls in the result are stripped to honor
   * the cross-provider contract.
   *
   * @param req - The galdor request to run.
   * @param ctx - Optional run context; its abort signal cancels the request.
   * @returns The completed galdor {@link Response}.
   * @throws {APIError} On a non-2xx status or when the response body cannot be decoded.
   */
  async generate(req: Request, ctx?: RunContext): Promise<Response> {
    const wire = buildConverseRequest(req);
    const body = JSON.stringify(wire);
    const url = this.#endpoint(req.model, "converse");
    const res = await fetch(url, {
      method: "POST",
      headers: this.#sign("POST", url, body),
      body,
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
    });
    if (Math.floor(res.status / 100) !== 2) throw await normalizeHTTPError(res);

    let parsed: ConverseResponse;
    try {
      parsed = (await res.json()) as ConverseResponse;
    } catch (e) {
      throw classify(
        new APIError({ kind: "server", provider: PROVIDER_NAME, statusCode: res.status, message: `decode response: ${(e as Error).message}` }),
      );
    }
    const out = responseFromWire(parsed);
    out.model = req.model;
    if (req.toolChoice === "none") delete out.message.toolCalls;
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
    const wire = buildConverseRequest(req);
    const body = JSON.stringify(wire);
    const url = this.#endpoint(req.model, "converse-stream");
    return streamConverse(url, this.#sign("POST", url, body), body, req.model, ctx?.signal);
  }
}

/**
 * Construct a {@link BedrockProvider} from a {@link Config}.
 *
 * @param cfg - Connection options; `region`, `accessKeyId` and `secretAccessKey` are required.
 * @returns A ready-to-use provider instance.
 * @throws {Error} When a required credential field is missing or blank.
 * @example
 * const provider = newBedrock({
 *   region: "us-east-1",
 *   accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
 *   secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
 * });
 * const resp = await provider.generate({
 *   model: "anthropic.claude-3-haiku-20240307-v1:0",
 *   messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
 * });
 */
export function newBedrock(cfg: Config): BedrockProvider {
  return new BedrockProvider(cfg);
}

export { normalizeHTTPError } from "./errors.ts";
export { signRequest } from "./sigv4.ts";
