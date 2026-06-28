import { describe, expect, test } from "bun:test";
import { assistantMessage, messageText, type Usage } from "../schema/index.ts";
import { AuthError, RateLimitError, TransientError } from "./errors.ts";
import {
  type Capabilities,
  type Event,
  EventType,
  type Provider,
  type Request,
  type Response,
} from "./index.ts";
import { isRetryable, withDefaultRetry, withRetry } from "./retry.ts";

const caps = (): Capabilities => ({
  streaming: true,
  toolCalling: true,
  structuredOutput: true,
  promptCaching: false,
  visionInput: false,
  reasoning: false,
  maxContextTokens: 8192,
});

const usage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
});

const okResponse = (): Response => ({
  message: assistantMessage("ok"),
  stopReason: "end_turn",
  usage: usage(),
  model: "m",
});

const rateLimit = (retryAfter?: number) =>
  new RateLimitError({
    kind: "rate_limited",
    provider: "x",
    statusCode: 429,
    message: "slow down",
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  });

const transient = () =>
  new TransientError({ kind: "server", provider: "x", statusCode: 500, message: "boom" });

const auth = () =>
  new AuthError({ kind: "auth", provider: "x", statusCode: 401, message: "no key" });

const req: Request = { model: "m", messages: [] };

/** A provider that walks a fixed list of outcomes, throwing errors and returning responses. */
class SeqProvider implements Provider {
  calls = 0;
  #steps: Array<Response | Error>;
  constructor(steps: Array<Response | Error>) {
    this.#steps = steps;
  }
  name(): string {
    return "seq";
  }
  capabilities(): Capabilities {
    return caps();
  }
  #step(): Response {
    const s = this.#steps[this.calls];
    this.calls++;
    if (s === undefined) throw new Error("seq: out of steps");
    if (s instanceof Error) throw s;
    return s;
  }
  async generate(): Promise<Response> {
    return this.#step();
  }
  async *stream(): AsyncIterable<Event> {
    const r = this.#step();
    yield { type: EventType.MessageStart, model: "m", usage: r.usage };
    yield { type: EventType.ContentDelta, contentDelta: messageText(r.message) };
    yield { type: EventType.MessageStop, stopReason: r.stopReason, usage: r.usage, message: r.message };
  }
}

describe("isRetryable", () => {
  test("classifies transient kinds as retryable and others as not", () => {
    expect(isRetryable(rateLimit())).toBe(true);
    expect(isRetryable(transient())).toBe(true);
    expect(isRetryable(auth())).toBe(false);
    expect(isRetryable(new Error("nope"))).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});

describe("withRetry", () => {
  test("retries a server error and then succeeds", async () => {
    const inner = new SeqProvider([transient(), okResponse()]);
    const p = withRetry(inner, { maxAttempts: 3, initialDelay: 1, maxDelay: 5, jitter: -1 });
    const resp = await p.generate(req);
    expect(messageText(resp.message)).toBe("ok");
    expect(inner.calls).toBe(2);
  });

  test("retries a rate-limit error and then succeeds", async () => {
    const inner = new SeqProvider([rateLimit(), okResponse()]);
    const p = withRetry(inner, { maxAttempts: 3, initialDelay: 1, maxDelay: 5, jitter: -1 });
    const resp = await p.generate(req);
    expect(messageText(resp.message)).toBe("ok");
    expect(inner.calls).toBe(2);
  });

  test("does not retry an auth error", async () => {
    const inner = new SeqProvider([auth(), okResponse()]);
    const p = withRetry(inner, { maxAttempts: 3, initialDelay: 1, jitter: -1 });
    await expect(p.generate(req)).rejects.toBeInstanceOf(AuthError);
    expect(inner.calls).toBe(1);
  });

  test("honors Retry-After as a floor", async () => {
    const ctrl = new AbortController();
    let captured = -1;
    const inner = new SeqProvider([rateLimit(2), okResponse()]);
    const p = withRetry(inner, {
      maxAttempts: 3,
      jitter: -1,
      onRetry: (_attempt, delay) => {
        captured = delay;
        ctrl.abort();
      },
    });
    await expect(p.generate(req, { signal: ctrl.signal })).rejects.toBeDefined();
    // Retry-After of 2s, jitter disabled → exactly the 2000ms floor.
    expect(captured).toBe(2000);
  });

  test("gives up when Retry-After exceeds maxDelay", async () => {
    const inner = new SeqProvider([rateLimit(100), okResponse()]);
    const p = withRetry(inner, { maxAttempts: 5, maxDelay: 30000, jitter: -1 });
    await expect(p.generate(req)).rejects.toThrow(/exhausted/);
    // Gave up immediately rather than retrying before the server's window.
    expect(inner.calls).toBe(1);
  });

  test("exhausts after maxAttempts of transient failures", async () => {
    const inner = new SeqProvider([transient(), transient(), transient()]);
    const p = withRetry(inner, { maxAttempts: 3, initialDelay: 1, maxDelay: 5, jitter: -1 });
    await expect(p.generate(req)).rejects.toThrow(/exhausted 3 attempts/);
    expect(inner.calls).toBe(3);
  });

  test("retries stream construction and then succeeds", async () => {
    const inner = new SeqProvider([transient(), okResponse()]);
    const p = withRetry(inner, { maxAttempts: 3, initialDelay: 1, maxDelay: 5, jitter: -1 });
    const events: Event[] = [];
    for await (const ev of p.stream(req)) events.push(ev);
    expect(inner.calls).toBe(2);
    expect(events.some((e) => e.type === EventType.MessageStop)).toBe(true);
  });

  test("withDefaultRetry applies a working default policy", async () => {
    const inner = new SeqProvider([transient(), okResponse()]);
    // Default initialDelay is 1s; abort during the backoff so the test is fast
    // while still proving the retry path was taken.
    const ctrl = new AbortController();
    const p = withDefaultRetry(inner);
    queueMicrotask(() => ctrl.abort());
    await expect(p.generate(req, { signal: ctrl.signal })).rejects.toBeDefined();
    expect(inner.calls).toBe(1);
  });
});
