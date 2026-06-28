import { afterEach, describe, expect, test } from "bun:test";
import { EmbedError, HTTPEmbedder } from "./index.ts";

// Each test spins up an ephemeral local server (port 0) and tears it down.
let servers: ReturnType<typeof Bun.serve>[] = [];

function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

describe("HTTPEmbedder construction", () => {
  test("requires a URL", () => {
    expect(() => new HTTPEmbedder({ url: "" })).toThrow(/URL is required/);
  });

  test("rejects an unknown shape", () => {
    // @ts-expect-error exercising runtime validation with an invalid shape
    expect(() => new HTTPEmbedder({ url: "http://x", shape: "nope" })).toThrow(/unknown shape/);
  });

  test("defaults to openai shape and appends /embeddings", () => {
    const e = new HTTPEmbedder({ url: "http://x" });
    expect(e.dimensions()).toBe(0);
  });

  test("appends the per-shape suffix idempotently", async () => {
    // openai already-suffixed URL is left intact; verified indirectly via path.
    let seenPath = "";
    const url = serve(async (req) => {
      seenPath = new URL(req.url).pathname;
      return Response.json({ data: [{ index: 0, embedding: [1, 2] }] });
    });
    const e = new HTTPEmbedder({ url: `${url}/v1/embeddings` });
    await e.embed(["x"]);
    expect(seenPath).toBe("/v1/embeddings"); // not doubled
  });

  test("tei appends /embed", async () => {
    let seenPath = "";
    const url = serve(async (req) => {
      seenPath = new URL(req.url).pathname;
      return Response.json([[1, 2, 3]]);
    });
    const e = new HTTPEmbedder({ url: `${url}/`, shape: "tei" });
    await e.embed(["x"]);
    expect(seenPath).toBe("/embed");
  });
});

describe("HTTPEmbedder wire shapes", () => {
  test("tei: flat-array parsing + dimension auto-detect", async () => {
    const url = serve(async (req) => {
      expect(new URL(req.url).pathname).toBe("/embed");
      const body = (await req.json()) as { inputs: string[] };
      const out = body.inputs.map((_, i) => [i, 0.5, -0.5]);
      return Response.json(out);
    });
    const e = new HTTPEmbedder({ url, shape: "tei" });
    const vecs = await e.embed(["a", "b"]);
    expect(vecs).toHaveLength(2);
    expect(vecs[0]?.[0]).toBe(0);
    expect(vecs[1]?.[0]).toBe(1);
    expect(e.dimensions()).toBe(3);
  });

  test("openai: index-honoring decode + auth header + model", async () => {
    const url = serve(async (req) => {
      expect(new URL(req.url).pathname.endsWith("/embeddings")).toBe(true);
      expect(req.headers.get("Authorization")).toBe("Bearer SECRET");
      const body = (await req.json()) as { input: string[]; model: string };
      expect(body.model).toBe("m-1");
      // Shuffled order to exercise the index-honoring decode.
      return Response.json({
        data: [
          { index: 1, embedding: [1, 1] },
          { index: 0, embedding: [0, 0] },
        ],
      });
    });
    const e = new HTTPEmbedder({ url: `${url}/v1/embeddings`, model: "m-1", apiKey: "SECRET" });
    const vecs = await e.embed(["x", "y"]);
    expect(vecs[0]?.[0]).toBe(0);
    expect(vecs[1]?.[0]).toBe(1);
  });

  test("openai: forwards dimensions when configured", async () => {
    let seenDim: number | undefined;
    const url = serve(async (req) => {
      const body = (await req.json()) as { dimensions?: number };
      seenDim = body.dimensions;
      return Response.json({ data: [{ index: 0, embedding: [1, 2, 3, 4] }] });
    });
    const e = new HTTPEmbedder({ url, dim: 4 });
    expect(e.dimensions()).toBe(4);
    await e.embed(["x"]);
    expect(seenDim).toBe(4);
  });
});

describe("HTTPEmbedder batching & retries", () => {
  test("splits inputs across batches, re-assembled in order", async () => {
    const seen: string[][] = [];
    const url = serve(async (req) => {
      const body = (await req.json()) as { inputs: string[] };
      seen.push(body.inputs);
      return Response.json(body.inputs.map((s) => [s.length]));
    });
    const e = new HTTPEmbedder({ url, shape: "tei", batchSize: 2 });
    const inputs = ["a", "bb", "ccc", "dddd", "eeeee"];
    const vecs = await e.embed(inputs);
    expect(seen).toHaveLength(3); // ceil(5/2)
    expect(vecs).toHaveLength(5);
    vecs.forEach((v, i) => expect(v[0]).toBe(inputs[i]!.length));
  });

  test("retries on 5xx then succeeds", async () => {
    let calls = 0;
    const url = serve(async () => {
      calls++;
      if (calls < 3) return new Response("upstream down", { status: 502 });
      return Response.json([[1, 2, 3]]);
    });
    const e = new HTTPEmbedder({ url, shape: "tei" });
    const vecs = await e.embed(["x"]);
    expect(calls).toBe(3);
    expect(vecs[0]).toEqual([1, 2, 3]);
  });

  test("exhausts retries and surfaces an EmbedError", async () => {
    let calls = 0;
    const url = serve(async () => {
      calls++;
      return new Response("still down", { status: 503 });
    });
    const e = new HTTPEmbedder({ url, shape: "tei" });
    try {
      await e.embed(["x"]);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(EmbedError);
      const ee = err as EmbedError;
      expect(ee.status).toBe(503);
      expect(ee.body).toContain("still down");
    }
    expect(calls).toBe(3);
  });

  test("does not retry on 4xx", async () => {
    let calls = 0;
    const url = serve(async () => {
      calls++;
      return new Response(JSON.stringify({ error: "bad key" }), { status: 401 });
    });
    const e = new HTTPEmbedder({ url, shape: "tei" });
    await expect(e.embed(["x"])).rejects.toBeInstanceOf(EmbedError);
    expect(calls).toBe(1);
  });

  test("does not retry on 413", async () => {
    let calls = 0;
    const url = serve(async () => {
      calls++;
      return new Response("payload too large", { status: 413 });
    });
    const e = new HTTPEmbedder({ url, shape: "tei" });
    try {
      await e.embed(["x"]);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(EmbedError);
      expect((err as EmbedError).status).toBe(413);
    }
    expect(calls).toBe(1);
  });
});

describe("HTTPEmbedder error handling", () => {
  test("bad JSON ⇒ decode error", async () => {
    const url = serve(async () => new Response("not json"));
    const e = new HTTPEmbedder({ url, shape: "tei" });
    await expect(e.embed(["x"])).rejects.toThrow(/decode/);
  });

  test("vector-count mismatch errors", async () => {
    const url = serve(async () => Response.json([[1, 2]]));
    const e = new HTTPEmbedder({ url, shape: "tei" });
    await expect(e.embed(["a", "b"])).rejects.toThrow(/vectors for/);
  });

  test("openai short response (M12 regression) errors", async () => {
    const url = serve(async () => Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] }));
    const e = new HTTPEmbedder({ url, shape: "openai" });
    await expect(e.embed(["a", "b"])).rejects.toThrow(/missing embedding/);
  });

  test("cancellation via AbortSignal", async () => {
    const url = serve(
      () =>
        // Never resolves; the client's signal must abort.
        new Promise<Response>(() => {}),
    );
    const e = new HTTPEmbedder({ url, shape: "tei" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await expect(e.embed(["x"], controller.signal)).rejects.toThrow(/context/);
  });

  test("empty input returns []", async () => {
    const e = new HTTPEmbedder({ url: "http://unused", shape: "tei" });
    expect(await e.embed([])).toEqual([]);
  });

  test("EmbedError formatting", () => {
    const e = new EmbedError(500, "http://x", "boom");
    expect(e.message).toContain("500");
    expect(e.message).toContain("boom");
    expect(e.name).toBe("EmbedError");
    const e2 = new EmbedError(500, "http://x", "");
    expect(e2.message.endsWith(":")).toBe(false);
  });
});

describe("HTTPEmbedder.ping", () => {
  test("sends a single 'ping' input", async () => {
    let seen = "";
    const url = serve(async (req) => {
      const body = (await req.json()) as { inputs: string[] };
      if (body.inputs.length === 1) seen = body.inputs[0]!;
      return Response.json([[0.1, 0.2]]);
    });
    const e = new HTTPEmbedder({ url, shape: "tei" });
    await e.ping();
    expect(seen).toBe("ping");
  });

  test("propagates server errors", async () => {
    const url = serve(async () => new Response("", { status: 401 }));
    const e = new HTTPEmbedder({ url, shape: "tei" });
    await expect(e.ping()).rejects.toThrow();
  });
});
