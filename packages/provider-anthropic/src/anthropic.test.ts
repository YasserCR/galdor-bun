/**
 * Behavioral tests for the Anthropic adapter.
 *
 * Each case stands up an ephemeral local HTTP server that impersonates the
 * Messages API, points a freshly constructed provider at it, and asserts on both
 * the outgoing wire request and the parsed result — covering request shaping,
 * typed error mapping, and SSE stream reassembly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ContentType, messageText } from "@galdor/core/schema";
import { APIError, collectStream, RateLimitError } from "@galdor/core/provider";
import { newAnthropic } from "./index.ts";

let server: { stop(): void; url: string } | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
});

function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const s = Bun.serve({ port: 0, fetch: handler });
  server = { stop: () => s.stop(true), url: `http://localhost:${s.port}` };
  return server.url;
}

describe("AnthropicProvider.generate", () => {
  test("sends the wire request and parses text + tool calls + usage", async () => {
    let received: any;
    const url = serve(async (req) => {
      received = await req.json();
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [
          { type: "text", text: "the answer" },
          { type: "tool_use", id: "t1", name: "add", input: { a: 1, b: 2 } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    });

    const p = newAnthropic({ apiKey: "sk-test", baseURL: url });
    const resp = await p.generate({
      model: "claude-haiku-4-5",
      messages: [
        { role: "system", content: [{ type: "text", text: "be terse" }] },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    });

    // request shaping: system hoisted, max_tokens defaulted
    expect(received.system[0].text).toBe("be terse");
    expect(received.max_tokens).toBe(4096);
    expect(received.messages[0].role).toBe("user");

    // response parsing
    expect(messageText(resp.message)).toBe("the answer");
    expect(resp.message.toolCalls?.[0]).toEqual({ id: "t1", name: "add", arguments: { a: 1, b: 2 } });
    expect(resp.stopReason).toBe("tool_use");
    expect(resp.usage.inputTokens).toBe(10);
  });

  test("maps a 429 to a typed RateLimitError", async () => {
    const url = serve(
      () =>
        new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), {
          status: 429,
          headers: { "retry-after": "7" },
        }),
    );
    const p = newAnthropic({ apiKey: "sk-test", baseURL: url });
    try {
      await p.generate({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError);
      expect((e as RateLimitError).retryAfter).toBe(7);
    }
  });
});

describe("AnthropicProvider.stream", () => {
  test("parses an SSE sequence into events that collectStream reassembles", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-haiku-4-5", usage: { input_tokens: 3 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello " } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");

    const url = serve(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const p = newAnthropic({ apiKey: "sk-test", baseURL: url });
    const resp = await collectStream(p.stream({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }));
    expect(messageText(resp.message)).toBe("hello world");
    expect(resp.stopReason).toBe("end_turn");
  });

  test("accumulates thinking_delta + signature_delta into a thinking ContentPart", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-haiku-4-5", usage: { input_tokens: 3 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me " } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "the answer" } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");

    const url = serve(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const p = newAnthropic({ apiKey: "sk-test", baseURL: url });
    const resp = await collectStream(p.stream({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }));

    // The thinking deltas are not forwarded as live text...
    expect(messageText(resp.message)).toBe("the answer");
    // ...but reassembled into a thinking ContentPart carrying the signature.
    const thinking = resp.message.content.find((p) => p.type === ContentType.Thinking);
    expect(thinking).toBeDefined();
    expect(thinking?.text).toBe("let me reason");
    expect(thinking?.signature).toBe("sig-abc");
  });

  test("throws a classified error on a mid-stream error frame", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-haiku-4-5", usage: { input_tokens: 3 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } })}\n\n`,
      `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "overloaded" } })}\n\n`,
    ].join("");

    const url = serve(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const p = newAnthropic({ apiKey: "sk-test", baseURL: url });
    try {
      for await (const _ev of p.stream({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })) {
        // drain until the error frame throws
      }
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(APIError);
      expect(e).toBeInstanceOf(RateLimitError);
      expect((e as APIError).message).toBe("overloaded");
    }
  });

  test("folds cache token counts from message_start into the final usage", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-haiku-4-5", usage: { input_tokens: 3, cache_creation_input_tokens: 11, cache_read_input_tokens: 22 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");

    const url = serve(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const p = newAnthropic({ apiKey: "sk-test", baseURL: url });
    const resp = await collectStream(p.stream({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }));

    expect(resp.usage.inputTokens).toBe(3);
    expect(resp.usage.outputTokens).toBe(2);
    expect(resp.usage.cacheCreationTokens).toBe(11);
    expect(resp.usage.cacheReadTokens).toBe(22);
  });
});
