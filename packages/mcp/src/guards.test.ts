import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { defineTool, Registry } from "@galdor/core/tool";
import { Server } from "./server.ts";
import {
  inMemoryTransportPair,
  maxMessageBytes,
  StdioTransport,
  StreamableHTTPClientTransport,
  StreamableHTTPTransport,
} from "./transports.ts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("server dispatch concurrency cap", () => {
  test("blocks the receive loop once maxConcurrentDispatch are in flight", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const block = defineTool({
      name: "block",
      input: z.object({}),
      handler: async () => {
        started++;
        await gate;
        return { ok: true };
      },
    });
    const reg = new Registry(block);
    const server = new Server(reg, { name: "t", version: "1" });

    // Drive raw frames straight at the server transport so we can outpace it.
    const [clientT, serverT] = inMemoryTransportPair();
    const serveDone = server.serve(serverT);

    // 65 calls: the 65th cannot be dispatched until a slot frees (cap = 64).
    for (let i = 0; i < 65; i++) {
      await clientT.send({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: "block", arguments: {} } });
    }
    await delay(60);
    expect(started).toBe(64);

    release();
    await delay(60);
    expect(started).toBe(65);

    clientT.close();
    serverT.close();
    await serveDone;
  });
});

describe("stdio per-frame cap", () => {
  test("rejects an oversized frame and terminates the stream", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const t = new StdioTransport(readable, writable);

    // A normal frame still flows.
    readable.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
    const first = await t.receive();
    expect(first).toContain('"method":"ping"');

    // A single frame past the cap is refused, not emitted; the stream ends.
    readable.write(`${"x".repeat(maxMessageBytes + 1)}\n`);
    const after = await t.receive();
    expect(after).toBeNull();

    t.close();
  });
});

describe("Streamable HTTP server body cap", () => {
  test("rejects a body whose byte length exceeds the cap with 413", async () => {
    const greet = defineTool({
      name: "greet",
      input: z.object({ who: z.string() }),
      handler: ({ who }) => ({ message: `hello, ${who}` }),
    });
    const serverT = new StreamableHTTPTransport(0);
    const server = new Server(new Registry(greet), { name: "t", version: "1" });
    const serveDone = server.serve(serverT);
    await serverT.ready;
    try {
      // Each "é" is one UTF-16 code unit but two UTF-8 bytes: the byte length
      // exceeds the cap while the string length stays under it, so only a
      // byte-accurate guard rejects this.
      const body = "é".repeat(Math.floor(maxMessageBytes / 2) + 1);
      const res = await fetch(serverT.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(413);
    } finally {
      serverT.close();
      await serveDone;
    }
  });
});

describe("Streamable HTTP client bounded reply queue", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("applies backpressure once maxBufferedReplies are queued", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
      })) as unknown as typeof fetch;

    const t = StreamableHTTPClientTransport.create("http://localhost:1/");
    // Fill the 64-slot reply buffer; none of these block.
    for (let i = 0; i < 64; i++) {
      await t.send({ jsonrpc: "2.0", id: i, method: "x" });
    }
    // The 65th send blocks: its reply has nowhere to go until a receive drains.
    let resolved = false;
    const pending = t.send({ jsonrpc: "2.0", id: 64, method: "x" }).then(() => {
      resolved = true;
    });
    await delay(60);
    expect(resolved).toBe(false);

    // Draining one frame frees a slot and unblocks the parked send.
    await t.receive();
    await pending;
    expect(resolved).toBe(true);

    t.close();
  });
});
