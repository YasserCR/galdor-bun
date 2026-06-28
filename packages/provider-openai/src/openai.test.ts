import { afterEach, describe, expect, test } from "bun:test";
import { collectStream, RateLimitError } from "@galdor/core/provider";
import { messageText } from "@galdor/core/schema";
import { newOpenAI } from "./index.ts";

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

describe("OpenAIProvider.generate", () => {
  test("shapes the wire request and parses text + tool calls + usage", async () => {
    let received: any;
    let path = "";
    const url = serve(async (req) => {
      path = new URL(req.url).pathname;
      received = await req.json();
      return Response.json({
        id: "chatcmpl-1",
        object: "chat.completion",
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "the answer",
              tool_calls: [{ id: "t1", type: "function", function: { name: "add", arguments: '{"a":1,"b":2}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    });

    const p = newOpenAI({ apiKey: "sk-test", baseURL: url });
    const resp = await p.generate({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: [{ type: "text", text: "be terse" }] },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    });

    // request shaping: system stays a message, model carried, content stringified
    expect(path).toBe("/chat/completions");
    expect(received.model).toBe("gpt-4o-mini");
    expect(received.messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(received.messages[1]).toEqual({ role: "user", content: "hi" });

    // response parsing
    expect(messageText(resp.message)).toBe("the answer");
    expect(resp.message.toolCalls?.[0]).toEqual({ id: "t1", name: "add", arguments: { a: 1, b: 2 } });
    expect(resp.stopReason).toBe("tool_use");
    expect(resp.usage.inputTokens).toBe(10);
    expect(resp.usage.outputTokens).toBe(5);
    expect(resp.model).toBe("gpt-4o-mini");
  });

  test("omits `stop` when stopSequences is empty, includes it when non-empty", async () => {
    let received: any;
    const url = serve(async (req) => {
      received = await req.json();
      return Response.json({ model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] });
    });
    const p = newOpenAI({ apiKey: "sk-test", baseURL: url });

    await p.generate({
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      stopSequences: [],
    });
    expect("stop" in received).toBe(false);

    await p.generate({
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      stopSequences: ["END"],
    });
    expect(received.stop).toEqual(["END"]);
  });

  test("maps a 429 to a typed RateLimitError with retryAfter", async () => {
    const url = serve(
      () =>
        new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }), {
          status: 429,
          headers: { "retry-after": "7" },
        }),
    );
    const p = newOpenAI({ apiKey: "sk-test", baseURL: url });
    try {
      await p.generate({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError);
      expect((e as RateLimitError).retryAfter).toBe(7);
    }
  });
});

describe("OpenAIProvider.stream", () => {
  test("parses an SSE sequence into events that collectStream reassembles", async () => {
    const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const sse = [
      chunk({ id: "1", model: "gpt-4o-mini", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }),
      chunk({ id: "1", model: "gpt-4o-mini", choices: [{ index: 0, delta: { content: "hello " } }] }),
      chunk({ id: "1", model: "gpt-4o-mini", choices: [{ index: 0, delta: { content: "world" } }] }),
      chunk({ id: "1", model: "gpt-4o-mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      chunk({ id: "1", model: "gpt-4o-mini", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      "data: [DONE]\n\n",
    ].join("");

    const url = serve(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const p = newOpenAI({ apiKey: "sk-test", baseURL: url });
    const resp = await collectStream(
      p.stream({ model: "gpt-4o-mini", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );
    expect(messageText(resp.message)).toBe("hello world");
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.usage.inputTokens).toBe(3);
    expect(resp.usage.outputTokens).toBe(2);
    expect(resp.model).toBe("gpt-4o-mini");
  });

  test("parses a CRLF-framed SSE stream (OpenAI-compatible backends)", async () => {
    const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\r\n\r\n`;
    const sse = [
      chunk({ id: "1", model: "gpt-4o-mini", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }),
      chunk({ id: "1", model: "gpt-4o-mini", choices: [{ index: 0, delta: { content: "hello " } }] }),
      chunk({ id: "1", model: "gpt-4o-mini", choices: [{ index: 0, delta: { content: "world" } }] }),
      chunk({ id: "1", model: "gpt-4o-mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      chunk({ id: "1", model: "gpt-4o-mini", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      "data: [DONE]\r\n\r\n",
    ].join("");

    const url = serve(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const p = newOpenAI({ apiKey: "sk-test", baseURL: url });
    const resp = await collectStream(
      p.stream({ model: "gpt-4o-mini", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );
    expect(messageText(resp.message)).toBe("hello world");
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.usage.inputTokens).toBe(3);
    expect(resp.usage.outputTokens).toBe(2);
    expect(resp.model).toBe("gpt-4o-mini");
  });

  test("captures a final chunk not terminated by a blank line", async () => {
    const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    // The backend closes the connection after the last data line, without a
    // trailing blank line and without [DONE]: the finish/usage chunk must still
    // be honored.
    const sse =
      chunk({ id: "1", model: "gpt-4o-mini", choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] }) +
      chunk({ id: "1", model: "gpt-4o-mini", choices: [{ index: 0, delta: { content: " there" } }] }) +
      `data: ${JSON.stringify({
        id: "1",
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        usage: { prompt_tokens: 7, completion_tokens: 4 },
      })}`;

    const url = serve(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const p = newOpenAI({ apiKey: "sk-test", baseURL: url });
    const resp = await collectStream(
      p.stream({ model: "gpt-4o-mini", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );
    expect(messageText(resp.message)).toBe("hi there");
    expect(resp.stopReason).toBe("max_tokens");
    expect(resp.usage.inputTokens).toBe(7);
    expect(resp.usage.outputTokens).toBe(4);
    expect(resp.model).toBe("gpt-4o-mini");
  });
});
