import { describe, expect, test } from "bun:test";
import {
  APIError,
  classify,
  ContextLengthError,
  parseRetryAfter,
  RateLimitError,
} from "./errors.ts";

describe("provider error classification", () => {
  test("classify promotes by kind", () => {
    const base = new APIError({
      kind: "rate_limited",
      provider: "anthropic",
      statusCode: 429,
      message: "slow down",
      retryAfter: 5,
    });
    const c = classify(base);
    expect(c).toBeInstanceOf(RateLimitError);
    expect(c.retryAfter).toBe(5);
  });

  test("context_window maps to ContextLengthError", () => {
    const c = classify(
      new APIError({
        kind: "context_window",
        provider: "openai",
        statusCode: 400,
        message: "too long",
      }),
    );
    expect(c).toBeInstanceOf(ContextLengthError);
  });
});

describe("parseRetryAfter", () => {
  const now = new Date("2026-06-25T12:00:00Z");

  test("delta-seconds form", () => {
    expect(parseRetryAfter("30", now)).toBe(30);
  });

  test("HTTP-date form, future", () => {
    expect(parseRetryAfter("Thu, 25 Jun 2026 12:00:10 GMT", now)).toBe(10);
  });

  test("HTTP-date form in the past clamps to 0", () => {
    expect(parseRetryAfter("Thu, 25 Jun 2026 11:59:50 GMT", now)).toBe(0);
  });

  test("HTTP-date form rounds up a fractional gap", () => {
    // now carries a sub-second offset so the gap to the whole-second header is
    // fractional (9.4s); rounding UP yields 10 so the retry never lands early.
    const offset = new Date("2026-06-25T12:00:00.600Z");
    expect(parseRetryAfter("Thu, 25 Jun 2026 12:00:10 GMT", offset)).toBe(10);
  });

  test("garbage returns null", () => {
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter("", now)).toBeNull();
  });
});
