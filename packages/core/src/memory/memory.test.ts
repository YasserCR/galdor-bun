import { describe, expect, test } from "bun:test";
import {
  assistantMessage,
  type Message,
  messageText,
  Role,
  systemMessage,
  userMessage,
} from "../schema/index.ts";
import {
  type Chunk,
  type Embedder,
  HashingEmbedder,
  InMemoryStore,
  newHashingEmbedder,
  Retriever,
  type Summarizer,
  Window,
} from "./index.ts";

// ── Window ───────────────────────────────────────────────────────────────────

describe("Window", () => {
  test("no caps ⇒ no trimming", async () => {
    const w = new Window();
    w.appendAll([
      systemMessage("you are helpful"),
      userMessage("a"),
      assistantMessage("b"),
      userMessage("c"),
    ]);
    const out = await w.snapshot();
    expect(out).toHaveLength(4);
  });

  test("trims to maxMessages, keeping the system prompt and newest turns", async () => {
    const w = new Window({ maxMessages: 3 });
    w.appendAll([
      systemMessage("you are helpful"),
      userMessage("a"),
      assistantMessage("b"),
      userMessage("c"),
      assistantMessage("d"),
    ]);
    const out = await w.snapshot();
    expect(out).toHaveLength(3);
    expect(out[0]?.role).toBe(Role.System);
    expect(messageText(out[1]!)).toBe("c");
    expect(messageText(out[2]!)).toBe("d");
  });

  test("trims to the token budget, preserving system", async () => {
    const w = new Window({ maxTokens: 30 });
    const big = "x".repeat(60); // 15 tokens each at 4 chars/token
    w.appendAll([
      systemMessage("sys"),
      userMessage(big),
      assistantMessage(big),
      userMessage(big),
    ]);
    const out = await w.snapshot();
    expect(out.length).toBeLessThan(4);
    expect(out[0]?.role).toBe(Role.System);
  });

  test("summarizer preserves evicted context as a summary message", async () => {
    const w = new Window({
      maxMessages: 3,
      summarizer: {
        async summarize(ms: Message[]): Promise<string> {
          return `summary of ${ms.length} messages`;
        },
      },
    });
    w.appendAll([
      systemMessage("sys"),
      userMessage("a"),
      assistantMessage("b"),
      userMessage("c"),
      assistantMessage("d"),
    ]);
    const out = await w.snapshot();
    expect(out).toHaveLength(3); // sys + summary + 1 kept
    expect(out[1]?.name).toBe("summary");
    expect(messageText(out[1]!)).toContain("summary of");
  });

  test("snapshot returns an independent slice", async () => {
    const w = new Window();
    w.append(userMessage("a"));
    const out = await w.snapshot();
    out[0] = userMessage("MUTATED");
    expect(w.len()).toBe(1);
    const again = await w.snapshot();
    expect(messageText(again[0]!)).toBe("a");
  });

  test("respects the token cap even after a large summary is folded in", async () => {
    const maxTokens = 40;
    const w = new Window({
      maxTokens,
      summarizer: {
        async summarize(): Promise<string> {
          return "s".repeat(200); // ~50 tokens, larger than the whole cap
        },
      },
    });
    const big = "x".repeat(60);
    w.appendAll([
      systemMessage("sys"),
      userMessage(big),
      assistantMessage(big),
      userMessage(big),
      assistantMessage(big),
    ]);
    const out = await w.snapshot();
    const conversational = out.filter(
      (m) => m.name !== "summary" && m.role !== Role.System,
    ).length;
    expect(conversational).toBe(0);
  });

  test("len and size agree", () => {
    const w = new Window();
    w.appendAll([userMessage("a"), userMessage("b")]);
    expect(w.len()).toBe(2);
    expect(w.size()).toBe(2);
  });

  test("a failing summarizer falls back to dropping evicted turns", async () => {
    const w = new Window({
      maxMessages: 2,
      summarizer: {
        async summarize(): Promise<string> {
          throw new Error("llm down");
        },
      },
    });
    w.appendAll([userMessage("a"), userMessage("b"), userMessage("c")]);
    const out = await w.snapshot();
    // No system message; summary slot reserved but never produced ⇒ at most
    // maxMessages messages, and no throw.
    expect(out.length).toBeLessThanOrEqual(2);
  });
});

// ── InMemoryStore ────────────────────────────────────────────────────────────

function chunk(c: Partial<Chunk> & { id: string; documentId: string; text: string }): Chunk {
  return { index: 0, ...c };
}

describe("InMemoryStore", () => {
  test("lexical text retrieval ranks the best match first", async () => {
    const s = new InMemoryStore();
    await s.add([
      chunk({ id: "c1", documentId: "d1", text: "Quito is the capital of Ecuador." }),
      chunk({ id: "c2", documentId: "d1", text: "Bogotá is the capital of Colombia." }),
      chunk({ id: "c3", documentId: "d1", text: "Lima is the capital of Peru." }),
    ]);
    const res = await s.retrieve({ text: "capital Ecuador", k: 2 });
    expect(res.length).toBeGreaterThan(0);
    expect(res[0]?.chunk.id).toBe("c1");
  });

  test("embedding retrieval ranks by cosine similarity", async () => {
    const s = new InMemoryStore();
    await s.add([
      chunk({ id: "near", documentId: "d", text: "x", embedding: [0.9, 0.1] }),
      chunk({ id: "mid", documentId: "d", text: "y", embedding: [0, 1] }),
      chunk({ id: "far", documentId: "d", text: "z", embedding: [-1, 0] }),
    ]);
    const res = await s.retrieve({ embedding: [1, 0], k: 2 });
    expect(res).toHaveLength(2);
    expect(res[0]?.chunk.id).toBe("near");
    expect(res[1]?.chunk.id).toBe("mid");
  });

  test("vector query skips embedding-less chunks", async () => {
    const s = new InMemoryStore();
    await s.add([
      chunk({ id: "vec", documentId: "d", text: "alpha", embedding: [1, 0] }),
      chunk({ id: "noembed", documentId: "d", text: "alpha beta gamma" }),
    ]);
    const res = await s.retrieve({ embedding: [1, 0], text: "alpha", k: 5 });
    expect(res).toHaveLength(1);
    expect(res[0]?.chunk.id).toBe("vec");
  });

  test("metadata filter restricts results", async () => {
    const s = new InMemoryStore();
    await s.add([
      chunk({ id: "a", documentId: "d", text: "capital Ecuador Quito", metadata: { lang: "en" } }),
      chunk({ id: "b", documentId: "d", text: "capital Ecuador Quito", metadata: { lang: "es" } }),
    ]);
    const res = await s.retrieve({ text: "capital", filter: { lang: "es" }, k: 5 });
    expect(res).toHaveLength(1);
    expect(res[0]?.chunk.id).toBe("b");
  });

  test("delete removes a document's chunks", async () => {
    const s = new InMemoryStore();
    await s.add([
      chunk({ id: "a", documentId: "d1", text: "alpha" }),
      chunk({ id: "b", documentId: "d1", text: "beta" }),
      chunk({ id: "c", documentId: "d2", text: "gamma" }),
    ]);
    await s.delete("d1");
    expect(s.len()).toBe(1);
    const res = await s.retrieve({ text: "gamma" });
    expect(res).toHaveLength(1);
    expect(res[0]?.chunk.id).toBe("c");
  });

  test("add is idempotent on id (overwrite, not duplicate)", async () => {
    const s = new InMemoryStore();
    await s.add([chunk({ id: "x", documentId: "d", text: "v1" })]);
    await s.add([chunk({ id: "x", documentId: "d", text: "v2" })]);
    expect(s.len()).toBe(1);
    const res = await s.retrieve({ text: "v2" });
    expect(res[0]?.chunk.text).toBe("v2");
  });

  test("an id-less chunk gets a generated UUID", async () => {
    const s = new InMemoryStore();
    await s.add([chunk({ id: "", documentId: "d", text: "hello" })]);
    const res = await s.retrieve({ text: "hello" });
    expect(res[0]?.chunk.id).toMatch(/[0-9a-f-]{36}/);
  });

  test("empty query is rejected", async () => {
    const s = new InMemoryStore();
    await expect(s.retrieve({})).rejects.toThrow();
  });

  test("embedding dimension mismatch errors", async () => {
    const s = new InMemoryStore();
    await s.add([chunk({ id: "c1", documentId: "d", text: "x", embedding: [1, 0, 0, 0] })]);
    await expect(s.retrieve({ embedding: [1, 0, 0], k: 5 })).rejects.toThrow(/mismatch/);
  });

  test("does not alias the caller's embedding/metadata", async () => {
    const s = new InMemoryStore();
    const emb = [1, 0, 0];
    const meta = { k: "v" };
    await s.add([chunk({ id: "x", documentId: "d", text: "hello", embedding: emb, metadata: meta })]);
    emb[0] = 999;
    meta.k = "TAMPERED";

    const res = await s.retrieve({ embedding: [1, 0, 0], k: 1 });
    expect(res[0]?.chunk.embedding?.[0]).toBe(1);
    expect(res[0]?.chunk.metadata?.k).toBe("v");

    // Mutating the returned result must not corrupt the store.
    res[0]!.chunk.metadata!.k = "MUTATED_RESULT";
    const res2 = await s.retrieve({ embedding: [1, 0, 0], k: 1 });
    expect(res2[0]?.chunk.metadata?.k).toBe("v");
  });
});

// ── HashingEmbedder ──────────────────────────────────────────────────────────

describe("HashingEmbedder", () => {
  test("reports dimensions and produces vectors of that size", async () => {
    const e = new HashingEmbedder(128);
    expect(e.dimensions()).toBe(128);
    const vecs = await e.embed(["hello world"]);
    expect(vecs).toHaveLength(1);
    expect(vecs[0]).toHaveLength(128);
  });

  test("non-positive dim falls back to 256", () => {
    expect(newHashingEmbedder(0).dimensions()).toBe(256);
    expect(new HashingEmbedder().dimensions()).toBe(256);
  });

  test("is deterministic", async () => {
    const e = new HashingEmbedder(64);
    const a = await e.embed(["the quick brown fox"]);
    const b = await e.embed(["the quick brown fox"]);
    expect(a[0]).toEqual(b[0]!);
  });

  test("output is L2-normalized", async () => {
    const e = new HashingEmbedder(64);
    const vecs = await e.embed(["alpha beta gamma delta epsilon"]);
    const v = vecs[0]!;
    const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-5);
  });

  test("lexical overlap drives cosine similarity", async () => {
    const e = new HashingEmbedder(512);
    const vecs = await e.embed([
      "quito ecuador capital",
      "quito ecuador city",
      "unrelated gardening tips",
    ]);
    const dot = (a: number[], b: number[]) => a.reduce((acc, x, i) => acc + x * (b[i] ?? 0), 0);
    const near = dot(vecs[0]!, vecs[1]!);
    const far = dot(vecs[0]!, vecs[2]!);
    expect(near).toBeGreaterThan(far);
  });

  test("empty text yields a zero vector", async () => {
    const e = new HashingEmbedder(8);
    const vecs = await e.embed([""]);
    expect(vecs[0]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

// ── Retriever ────────────────────────────────────────────────────────────────

describe("Retriever", () => {
  test("auto-embeds query.text when an embedder is present", async () => {
    const store = new InMemoryStore();
    const embedder = new HashingEmbedder(256);
    const [vec] = await embedder.embed(["quito ecuador capital"]);
    await store.add([
      chunk({ id: "c1", documentId: "d", text: "quito ecuador capital", embedding: vec! }),
      chunk({ id: "c2", documentId: "d", text: "unrelated gardening", embedding: (await embedder.embed(["unrelated gardening"]))[0]! }),
    ]);
    const r = new Retriever({ store, embedder, defaultK: 5 });
    const res = await r.retrieve({ text: "quito ecuador capital" });
    expect(res.length).toBeGreaterThan(0);
    expect(res[0]?.chunk.id).toBe("c1");
  });

  test("errors when the embedder returns the wrong vector count", async () => {
    const cases: Record<string, number[][]> = {
      "zero vectors": [],
      "too many vectors": [[1, 2, 3], [4, 5, 6]],
      "empty vector": [[]],
    };
    for (const [name, vecs] of Object.entries(cases)) {
      const embedder: Embedder = {
        async embed() {
          return vecs;
        },
        dimensions() {
          return 3;
        },
      };
      const r = new Retriever({ store: new InMemoryStore(), embedder });
      await expect(r.retrieve({ text: "hello", k: 3 })).rejects.toThrow(/embedder/);
    }
  });

  test("single non-empty vector succeeds", async () => {
    const embedder: Embedder = {
      async embed() {
        return [[1, 2, 3]];
      },
      dimensions() {
        return 3;
      },
    };
    const r = new Retriever({ store: new InMemoryStore(), embedder });
    await expect(r.retrieve({ text: "hello", k: 3 })).resolves.toBeDefined();
  });

  test("forwards unchanged when no embedder is configured", async () => {
    const store = new InMemoryStore();
    await store.add([chunk({ id: "c1", documentId: "d", text: "capital ecuador" })]);
    const r = new Retriever({ store });
    const res = await r.retrieve({ text: "capital" });
    expect(res[0]?.chunk.id).toBe("c1");
  });
});

// Touch the Summarizer type import so it is exercised.
const _summarizerType: Summarizer = { async summarize() { return ""; } };
void _summarizerType;
