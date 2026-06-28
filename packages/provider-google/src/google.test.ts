import { afterEach, describe, expect, test } from "bun:test";
import { messageText } from "@galdor/core/schema";
import { collectStream, RateLimitError } from "@galdor/core/provider";
import { newGoogle } from "./index.ts";

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

describe("GoogleProvider.generate", () => {
  test("sends the wire request and parses text + functionCall + usage", async () => {
    let received: any;
    let path = "";
    const url = serve(async (req) => {
      path = new URL(req.url).pathname;
      received = await req.json();
      return Response.json({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "the answer" }, { functionCall: { name: "add", args: { a: 1, b: 2 } } }],
            },
            finishReason: "STOP",
            index: 0,
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        modelVersion: "gemini-2.5-flash",
      });
    });

    const p = newGoogle({ apiKey: "AIza-test", baseURL: url });
    const resp = await p.generate({
      model: "gemini-2.5-flash",
      messages: [
        { role: "system", content: [{ type: "text", text: "be terse" }] },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    });

    // request shaping: model in URL, system hoisted to systemInstruction, contents[]
    expect(path).toBe("/models/gemini-2.5-flash:generateContent");
    expect(received.systemInstruction.parts[0].text).toBe("be terse");
    expect(received.contents[0].role).toBe("user");
    expect(received.contents[0].parts[0].text).toBe("hi");

    // response parsing
    expect(messageText(resp.message)).toBe("the answer");
    expect(resp.message.toolCalls?.[0]).toEqual({ id: "gfc_1_add", name: "add", arguments: { a: 1, b: 2 } });
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.usage.inputTokens).toBe(10);
    expect(resp.usage.outputTokens).toBe(5);

    // providerRaw carries the verbatim response bytes for round-tripping.
    expect(resp.providerRaw).toBeInstanceOf(Uint8Array);
    const echoed = JSON.parse(new TextDecoder().decode(resp.providerRaw));
    expect(echoed.modelVersion).toBe("gemini-2.5-flash");
  });

  test("maps a 429 to a typed RateLimitError", async () => {
    const url = serve(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 429, message: "slow down", status: "RESOURCE_EXHAUSTED", details: [] },
          }),
          { status: 429, headers: { "retry-after": "7" } },
        ),
    );
    const p = newGoogle({ apiKey: "AIza-test", baseURL: url });
    try {
      await p.generate({ model: "gemini-2.5-flash", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError);
      expect((e as RateLimitError).retryAfter).toBe(7);
    }
  });
});

describe("GoogleProvider.stream", () => {
  test("parses an SSE sequence into events that collectStream reassembles", async () => {
    const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    const sse = [
      frame({ candidates: [{ content: { role: "model", parts: [{ text: "hello " }] }, index: 0 }], modelVersion: "gemini-2.5-flash" }),
      frame({ candidates: [{ content: { role: "model", parts: [{ text: "world" }] }, index: 0 }] }),
      frame({
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      }),
    ].join("");

    const url = serve(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const p = newGoogle({ apiKey: "AIza-test", baseURL: url });
    const resp = await collectStream(
      p.stream({ model: "gemini-2.5-flash", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );
    expect(messageText(resp.message)).toBe("hello world");
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.usage.inputTokens).toBe(3);
  });

  test("reassembles a CRLF-framed SSE stream", async () => {
    // Some upstreams frame SSE with CRLF; the adapter must split on \r\n\r\n
    // and strip trailing \r, not silently swallow the whole stream.
    const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\r\n\r\n`;
    const sse = [
      frame({ candidates: [{ content: { role: "model", parts: [{ text: "cr " }] }, index: 0 }], modelVersion: "gemini-2.5-flash" }),
      frame({ candidates: [{ content: { role: "model", parts: [{ text: "lf" }] }, index: 0 }] }),
      frame({
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
      }),
    ].join("");

    const url = serve(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const p = newGoogle({ apiKey: "AIza-test", baseURL: url });
    const resp = await collectStream(
      p.stream({ model: "gemini-2.5-flash", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );
    expect(messageText(resp.message)).toBe("cr lf");
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.usage.inputTokens).toBe(4);
  });

  test("flushes a final frame that has no trailing blank line", async () => {
    // The terminal candidate frame arrives without a closing blank line before
    // the connection closes; it must still be parsed, not dropped.
    const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    const lastFrame = (obj: unknown) => `data: ${JSON.stringify(obj)}`;
    const sse =
      frame({ candidates: [{ content: { role: "model", parts: [{ text: "tail " }] }, index: 0 }], modelVersion: "gemini-2.5-flash" }) +
      lastFrame({
        candidates: [{ content: { role: "model", parts: [{ text: "end" }] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
      });

    const url = serve(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const p = newGoogle({ apiKey: "AIza-test", baseURL: url });
    const resp = await collectStream(
      p.stream({ model: "gemini-2.5-flash", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );
    expect(messageText(resp.message)).toBe("tail end");
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.usage.inputTokens).toBe(7);
  });
});
