/**
 * A scripted, in-process {@link Provider} implementation for unit tests.
 *
 * {@link TestProvider} lets you exercise code that depends on a model call
 * without a network round-trip or API quota. Both
 * {@link TestProvider.generate | generate} and
 * {@link TestProvider.stream | stream} draw from the same scripted sequence of
 * responses and errors. Once the script is consumed, the next call throws
 * {@link ScriptExhaustedError} so an unexpected extra call fails the test
 * loudly instead of silently repeating.
 *
 * @example
 * ```ts
 * const p = new TestProvider({ responses: ['{"intent":"buy"}'], errors: [rl] });
 * const resp = await p.generate({ model: "x", messages: [userMessage("hi")] });
 * ```
 */

import {
  assistantMessage,
  ContentType,
  type Message,
  messageText,
  type Usage,
} from "../schema/index.ts";
import {
  type Capabilities,
  type Event,
  EventType,
  type Provider,
  type Request,
  type Response,
  type RunContext,
} from "../provider/index.ts";

/**
 * Thrown when a {@link TestProvider} receives a call after its script has been
 * fully consumed, signalling an unexpected extra model interaction.
 */
export class ScriptExhaustedError extends Error {
  override name = "ScriptExhaustedError";
  /** 1-based index of the call that ran past the end of the script. */
  readonly call: number;
  /**
   * @param call - 1-based ordinal of the offending call.
   */
  constructor(call: number) {
    super(`testprovider: script exhausted at call ${call}`);
    this.call = call;
  }
}

/** One scripted step: exactly one of `response` / `error` is set. */
type Step = { response: Response } | { error: unknown };

/**
 * Construction options for a {@link TestProvider}.
 *
 * The script is assembled in a fixed order: text {@link TestProviderOptions.responses | responses}
 * first, then {@link TestProviderOptions.jsonResponses | jsonResponses}, then
 * {@link TestProviderOptions.errors | errors}.
 */
export interface TestProviderOptions {
  /** Name reported by {@link TestProvider.name}; defaults to `"test"`. */
  name?: string;
  /** Capabilities reported by {@link TestProvider.capabilities}. */
  capabilities?: Capabilities;
  /** Scripted text responses, in declaration order. */
  responses?: string[];
  /** Scripted JSON responses — each value is JSON-encoded into the text. */
  jsonResponses?: unknown[];
  /** Scripted errors, appended after the responses in the order given. */
  errors?: unknown[];
}

const defaultCaps = (): Capabilities => ({
  streaming: true,
  toolCalling: true,
  structuredOutput: true,
  promptCaching: false,
  visionInput: false,
  reasoning: false,
  maxContextTokens: 8192,
});

function textResponse(text: string): Response {
  const usage: Usage = {
    inputTokens: 0,
    outputTokens: text.length, // rough character-count proxy for token usage
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  return {
    message: assistantMessage(text),
    model: "test",
    usage,
    stopReason: "end_turn",
  };
}

/** Deep-clone a response so a caller mutating it can't poison later replays. */
function cloneResponse(r: Response): Response {
  return structuredClone(r);
}

/**
 * Scripted {@link Provider} that returns pre-arranged responses and errors in
 * order, recording every {@link Request} it sees.
 *
 * @example
 * ```ts
 * const p = new TestProvider({ responses: ["hello"] });
 * const resp = await p.generate({ model: "x", messages: [userMessage("hi")] });
 * // resp.message contains "hello"; p.requests() now has one entry.
 * ```
 */
export class TestProvider implements Provider {
  #name: string;
  #caps: Capabilities;
  #script: Step[] = [];
  #cursor = 0;
  #seen: Request[] = [];

  /**
   * @param opts - Scripted responses, errors, and reported metadata. See
   * {@link TestProviderOptions}.
   */
  constructor(opts: TestProviderOptions = {}) {
    this.#name = opts.name ?? "test";
    this.#caps = opts.capabilities ?? defaultCaps();

    // Build the script in a fixed order: text responses, then JSON responses,
    // then errors, each appended in declaration order.
    for (const t of opts.responses ?? []) {
      this.#script.push({ response: textResponse(t) });
    }
    for (const v of opts.jsonResponses ?? []) {
      this.#script.push({ response: textResponse(JSON.stringify(v)) });
    }
    for (const e of opts.errors ?? []) {
      this.#script.push({ error: e });
    }
  }

  /** @returns The configured provider name (default `"test"`). */
  name(): string {
    return this.#name;
  }

  /** @returns The capabilities this provider reports to callers. */
  capabilities(): Capabilities {
    return this.#caps;
  }

  #next(req: Request, ctx?: RunContext): Step {
    ctx?.signal?.throwIfAborted();
    this.#seen.push(req);
    if (this.#cursor >= this.#script.length) {
      throw new ScriptExhaustedError(this.#cursor + 1);
    }
    const step = this.#script[this.#cursor]!;
    this.#cursor++;
    return step;
  }

  /**
   * Consume the next scripted step and return its response.
   *
   * @param req - The request to record; its content is otherwise ignored.
   * @param ctx - Optional run context; an aborted signal rejects immediately.
   * @returns A deep copy of the next scripted {@link Response}.
   * @throws {ScriptExhaustedError} If the script has no remaining steps.
   * @throws The scripted error value when the next step is an error.
   */
  async generate(req: Request, ctx?: RunContext): Promise<Response> {
    const step = this.#next(req, ctx);
    if ("error" in step) throw step.error;
    return cloneResponse(step.response);
  }

  /**
   * Consume the next scripted step and emit it as a sequence of stream events.
   *
   * The response text is delivered as a single content delta framed by start
   * and stop events.
   *
   * @param req - The request to record; `req.model` labels the start event.
   * @param ctx - Optional run context; an aborted signal rejects immediately.
   * @returns An async iterable of {@link Event}s for the scripted response.
   * @throws {ScriptExhaustedError} If the script has no remaining steps.
   * @throws The scripted error value when the next step is an error.
   */
  async *stream(req: Request, ctx?: RunContext): AsyncIterable<Event> {
    const step = this.#next(req, ctx);
    if ("error" in step) throw step.error;
    const resp = step.response;
    const model = req.model || "test";
    const text = messageText(resp.message);

    yield { type: EventType.MessageStart, model, usage: resp.usage };
    yield { type: EventType.ContentDelta, contentDelta: text };
    yield {
      type: EventType.MessageStop,
      stopReason: resp.stopReason,
      usage: resp.usage,
      message: { role: resp.message.role, content: [{ type: ContentType.Text, text }] },
    };
  }

  /** Snapshot of requests received so far, in order (a copy). */
  requests(): Request[] {
    return [...this.#seen];
  }

  /** Rewind the cursor and clear the recorded request log. */
  reset(): void {
    this.#cursor = 0;
    this.#seen = [];
  }

  /** How many scripted steps remain unconsumed. */
  remaining(): number {
    return this.#script.length - this.#cursor;
  }
}
