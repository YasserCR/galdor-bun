/**
 * Behavioral tests for the Bedrock adapter.
 *
 * Each case stands up an ephemeral local HTTP server that impersonates the
 * Bedrock Runtime, points a freshly constructed provider at it, and asserts on
 * both the outgoing request and the parsed result — covering SigV4 signing,
 * Converse request shaping, typed error mapping, and event-stream reassembly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { collectStream, RateLimitError } from "@galdor/core/provider";
import { messageText } from "@galdor/core/schema";
import { newBedrock } from "./index.ts";

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

const CREDS = { region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const MODEL = "anthropic.claude-3-haiku-20240307-v1:0";

// ── Event-stream framing helper ──────────────────────────────────────────────
// Encodes a JSON event into one `application/vnd.amazon.eventstream` frame so
// the streaming test feeds the adapter exactly the binary shape Bedrock emits.

function headerStr(name: string, value: string): Uint8Array {
  const enc = new TextEncoder();
  const n = enc.encode(name);
  const v = enc.encode(value);
  const out = new Uint8Array(1 + n.length + 1 + 2 + v.length);
  let i = 0;
  out[i++] = n.length;
  out.set(n, i);
  i += n.length;
  out[i++] = 7; // string value type
  out[i++] = (v.length >> 8) & 0xff;
  out[i++] = v.length & 0xff;
  out.set(v, i);
  return out;
}

function writeUint32(b: Uint8Array, off: number, value: number): void {
  b[off] = (value >>> 24) & 0xff;
  b[off + 1] = (value >>> 16) & 0xff;
  b[off + 2] = (value >>> 8) & 0xff;
  b[off + 3] = value & 0xff;
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function encodeFrame(eventType: string, payloadObj: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(payloadObj));
  const headers = concatAll([
    headerStr(":event-type", eventType),
    headerStr(":content-type", "application/json"),
    headerStr(":message-type", "event"),
  ]);
  const totalLen = 4 + 4 + 4 + headers.length + payload.length + 4;
  const frame = new Uint8Array(totalLen);
  writeUint32(frame, 0, totalLen);
  writeUint32(frame, 4, headers.length);
  writeUint32(frame, 8, 0); // prelude CRC (decoder reads past it)
  frame.set(headers, 12);
  frame.set(payload, 12 + headers.length);
  writeUint32(frame, totalLen - 4, 0); // message CRC (decoder reads past it)
  return frame;
}

// Encodes an exception frame: `:message-type` is `exception` and the camelCase
// exception name rides in the `:exception-type` header, exactly as Bedrock
// delivers a mid-stream failure.
function encodeExceptionFrame(exceptionType: string, payloadObj: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(payloadObj));
  const headers = concatAll([
    headerStr(":exception-type", exceptionType),
    headerStr(":content-type", "application/json"),
    headerStr(":message-type", "exception"),
  ]);
  const totalLen = 4 + 4 + 4 + headers.length + payload.length + 4;
  const frame = new Uint8Array(totalLen);
  writeUint32(frame, 0, totalLen);
  writeUint32(frame, 4, headers.length);
  writeUint32(frame, 8, 0);
  frame.set(headers, 12);
  frame.set(payload, 12 + headers.length);
  writeUint32(frame, totalLen - 4, 0);
  return frame;
}

describe("BedrockProvider.generate", () => {
  test("sends a SigV4-signed request and parses text + tool use + usage", async () => {
    let received: any;
    let auth = "";
    let amzDate = "";
    const url = serve(async (req) => {
      received = await req.json();
      auth = req.headers.get("authorization") ?? "";
      amzDate = req.headers.get("x-amz-date") ?? "";
      return Response.json({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "the answer" }, { toolUse: { toolUseId: "t1", name: "add", input: { a: 1, b: 2 } } }],
          },
        },
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });
    });

    const p = newBedrock({ ...CREDS, baseURL: url });
    const resp = await p.generate({
      model: MODEL,
      messages: [
        { role: "system", content: [{ type: "text", text: "be terse" }] },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
      tools: [{ name: "add", description: "adds two numbers", schema: { type: "object" } }],
    });

    // signing: the Authorization header is a SigV4 credential with the headers we sign
    expect(auth).toContain("AWS4-HMAC-SHA256");
    expect(auth).toContain("/us-east-1/bedrock/aws4_request");
    expect(auth).toContain("SignedHeaders=content-type;host;x-amz-date");
    expect(auth).toContain("Signature=");
    expect(amzDate).toMatch(/^\d{8}T\d{6}Z$/);

    // request shaping: system hoisted, tool config built, user turn present
    expect(received.system[0].text).toBe("be terse");
    expect(received.messages[0].role).toBe("user");
    expect(received.toolConfig.tools[0].toolSpec.name).toBe("add");

    // response parsing
    expect(messageText(resp.message)).toBe("the answer");
    expect(resp.message.toolCalls?.[0]).toEqual({ id: "t1", name: "add", arguments: { a: 1, b: 2 } });
    expect(resp.stopReason).toBe("tool_use");
    expect(resp.usage.inputTokens).toBe(10);
    expect(resp.usage.outputTokens).toBe(5);
    expect(resp.model).toBe(MODEL);
  });

  test("maps a throttling status to a typed RateLimitError", async () => {
    const url = serve(
      () =>
        new Response(JSON.stringify({ __type: "ThrottlingException", message: "Rate exceeded" }), {
          status: 429,
          headers: { "x-amzn-errortype": "ThrottlingException", "retry-after": "3" },
        }),
    );
    const p = newBedrock({ ...CREDS, baseURL: url });
    try {
      await p.generate({ model: MODEL, messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError);
      expect((e as RateLimitError).retryAfter).toBe(3);
    }
  });
});

describe("BedrockProvider.stream", () => {
  test("decodes an event-stream sequence that collectStream reassembles", async () => {
    const frames = concatAll([
      encodeFrame("messageStart", { role: "assistant" }),
      encodeFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "hello " } }),
      encodeFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "world" } }),
      encodeFrame("contentBlockStop", { contentBlockIndex: 0 }),
      encodeFrame("messageStop", { stopReason: "end_turn" }),
      encodeFrame("metadata", { usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }),
    ]);

    const url = serve(() => new Response(frames, { headers: { "content-type": "application/vnd.amazon.eventstream" } }));
    const p = newBedrock({ ...CREDS, baseURL: url });
    const resp = await collectStream(p.stream({ model: MODEL, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }));

    expect(messageText(resp.message)).toBe("hello world");
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.usage.outputTokens).toBe(2);
    expect(resp.model).toBe(MODEL);
  });

  test("classifies a camelCase mid-stream exception type to its typed error", async () => {
    const frames = concatAll([
      encodeFrame("messageStart", { role: "assistant" }),
      encodeFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "partial" } }),
      // Mid-stream exceptions name the type in camelCase on the wire.
      encodeExceptionFrame("throttlingException", { message: "Rate exceeded" }),
    ]);

    const url = serve(() => new Response(frames, { headers: { "content-type": "application/vnd.amazon.eventstream" } }));
    const p = newBedrock({ ...CREDS, baseURL: url });
    try {
      await collectStream(p.stream({ model: MODEL, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError);
    }
  });
});
