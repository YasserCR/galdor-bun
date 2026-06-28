import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Capabilities,
  collectStream,
  type Response,
} from "../provider/index.ts";
import {
  assistantMessage,
  type Message,
  StopReason,
  systemMessage,
  type ToolDef,
  type Usage,
  userMessage,
} from "../schema/index.ts";
import { Store, type Span } from "../store/index.ts";
import {
  CURRENT_FIXTURE_VERSION,
  ExhaustedError,
  fingerprint,
  loadFromFile,
  loadFromStore,
  NoContentError,
  PromptMismatchError,
  type RecordedCall,
  type Recording,
  ReplayProvider,
  saveToFile,
  UnknownPromptError,
} from "./index.ts";

const usage = (): Usage => ({
  inputTokens: 1,
  outputTokens: 2,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
});

function call(prompt: Message[], answer: string, model = "m"): RecordedCall {
  const response: Response = {
    message: assistantMessage(answer),
    stopReason: StopReason.EndTurn,
    usage: usage(),
    model,
  };
  return { model, prompt, response };
}

const tmp = mkdtempSync(join(tmpdir(), "replay-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("fingerprint", () => {
  test("is deterministic for the same surface", () => {
    const a = call([userMessage("hello")], "hi");
    const b = call([userMessage("hello")], "different answer");
    // Response is not part of the surface: same prompt/model/tools → same fp.
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes when the model changes", () => {
    const a = call([userMessage("hello")], "hi", "model-a");
    const b = call([userMessage("hello")], "hi", "model-b");
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  test("changes when the prompt changes", () => {
    const a = call([userMessage("hello")], "hi");
    const b = call([userMessage("goodbye")], "hi");
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  test("changes when the tool set changes", () => {
    const tools: ToolDef[] = [{ name: "search", description: "find", schema: { type: "object" } }];
    const a = call([userMessage("hello")], "hi");
    const b: RecordedCall = { ...call([userMessage("hello")], "hi"), tools };
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  test("is stable across nested-key reordering in tool schemas", () => {
    const a: RecordedCall = {
      ...call([userMessage("x")], "y"),
      tools: [{ name: "t", description: "d", schema: { a: 1, b: 2 } }],
    };
    const b: RecordedCall = {
      ...call([userMessage("x")], "y"),
      tools: [{ name: "t", description: "d", schema: { b: 2, a: 1 } }],
    };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });
});

describe("saveToFile / loadFromFile", () => {
  test("round-trips a recording", async () => {
    const rec: Recording = {
      version: CURRENT_FIXTURE_VERSION,
      runId: "run-1",
      note: "smoke",
      calls: [call([systemMessage("sys"), userMessage("q1")], "a1"), call([userMessage("q2")], "a2")],
    };
    const path = join(tmp, "fixture.json");
    await saveToFile(path, rec);
    const loaded = await loadFromFile(path);
    expect(loaded).toEqual(rec);
  });

  test("stamps the version when zero", async () => {
    const rec = { version: 0, calls: [call([userMessage("q")], "a")] } as Recording;
    const path = join(tmp, "fixture-v0.json");
    await saveToFile(path, rec);
    const loaded = await loadFromFile(path);
    expect(loaded.version).toBe(CURRENT_FIXTURE_VERSION);
  });

  test("rejects an unsupported fixture version", async () => {
    const path = join(tmp, "bad-version.json");
    await saveToFile(path, { version: 1, calls: [] } as Recording);
    await expect(loadFromFile(path)).rejects.toThrow(/version 1 unsupported/);
  });
});

describe("strict mode", () => {
  test("serves recorded responses in order", async () => {
    const c1 = call([userMessage("q1")], "a1");
    const c2 = call([userMessage("q2")], "a2");
    const p = new ReplayProvider([c1, c2], "strict");

    expect(p.remaining()).toBe(2);
    const r1 = await p.generate({ model: "m", messages: [userMessage("q1")] });
    expect(r1.message.content[0]?.text).toBe("a1");
    expect(p.remaining()).toBe(1);
    const r2 = await p.generate({ model: "m", messages: [userMessage("q2")] });
    expect(r2.message.content[0]?.text).toBe("a2");
    expect(p.remaining()).toBe(0);
  });

  test("throws PromptMismatchError on a mismatched call", async () => {
    const p = new ReplayProvider([call([userMessage("q1")], "a1")], "strict");
    await expect(p.generate({ model: "m", messages: [userMessage("WRONG")] })).rejects.toBeInstanceOf(
      PromptMismatchError,
    );
  });

  test("throws ExhaustedError past the last recorded call", async () => {
    const p = new ReplayProvider([call([userMessage("q1")], "a1")], "strict");
    await p.generate({ model: "m", messages: [userMessage("q1")] });
    await expect(p.generate({ model: "m", messages: [userMessage("q1")] })).rejects.toBeInstanceOf(
      ExhaustedError,
    );
  });

  test("reset rewinds the counter", async () => {
    const p = new ReplayProvider([call([userMessage("q1")], "a1")], "strict");
    await p.generate({ model: "m", messages: [userMessage("q1")] });
    expect(p.remaining()).toBe(0);
    p.reset();
    expect(p.remaining()).toBe(1);
    const r = await p.generate({ model: "m", messages: [userMessage("q1")] });
    expect(r.message.content[0]?.text).toBe("a1");
  });

  test("returned response is a defensive copy", async () => {
    const p = new ReplayProvider([call([userMessage("q1")], "a1")], "strict");
    const r = await p.generate({ model: "m", messages: [userMessage("q1")] });
    r.message.content[0]!.text = "mutated";
    p.reset();
    const r2 = await p.generate({ model: "m", messages: [userMessage("q1")] });
    expect(r2.message.content[0]?.text).toBe("a1");
  });
});

describe("lenient mode", () => {
  test("matches by fingerprint regardless of order", async () => {
    const c1 = call([userMessage("q1")], "a1");
    const c2 = call([userMessage("q2")], "a2");
    const p = new ReplayProvider([c1, c2], "lenient");

    // Out of recorded order.
    const r2 = await p.generate({ model: "m", messages: [userMessage("q2")] });
    expect(r2.message.content[0]?.text).toBe("a2");
    const r1 = await p.generate({ model: "m", messages: [userMessage("q1")] });
    expect(r1.message.content[0]?.text).toBe("a1");
    // A repeated prompt keeps replaying its final recorded response.
    const r1again = await p.generate({ model: "m", messages: [userMessage("q1")] });
    expect(r1again.message.content[0]?.text).toBe("a1");
  });

  test("serves same-fingerprint calls in recorded order then clamps", async () => {
    const c1 = call([userMessage("dup")], "first");
    const c2 = call([userMessage("dup")], "second");
    const p = new ReplayProvider([c1, c2], "lenient");
    const a = await p.generate({ model: "m", messages: [userMessage("dup")] });
    const b = await p.generate({ model: "m", messages: [userMessage("dup")] });
    const c = await p.generate({ model: "m", messages: [userMessage("dup")] });
    expect(a.message.content[0]?.text).toBe("first");
    expect(b.message.content[0]?.text).toBe("second");
    expect(c.message.content[0]?.text).toBe("second"); // clamped to last
  });

  test("throws UnknownPromptError for an unrecorded prompt", async () => {
    const p = new ReplayProvider([call([userMessage("q1")], "a1")], "lenient");
    await expect(p.generate({ model: "m", messages: [userMessage("nope")] })).rejects.toBeInstanceOf(
      UnknownPromptError,
    );
  });
});

describe("stream", () => {
  test("replays the matched response as a synthetic stream", async () => {
    const p = new ReplayProvider([call([userMessage("q1")], "streamed answer")], "strict");
    const resp = await collectStream(p.stream({ model: "m", messages: [userMessage("q1")] }));
    expect(resp.message.content[0]?.text).toBe("streamed answer");
    expect(resp.stopReason).toBe(StopReason.EndTurn);
    expect(p.remaining()).toBe(0); // stream consumed a recorded call too
  });

  test("advertises streaming capability", () => {
    const caps: Capabilities = new ReplayProvider([], "strict").capabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.toolCalling).toBe(true);
  });
});

describe("loadFromStore", () => {
  test("reconstructs calls from generate and stream spans in start-time order", () => {
    const store = Store.open(":memory:");
    const span = (id: string, name: string, start: bigint, q: string, a: string): Span => ({
      spanId: id,
      traceId: "t1",
      parentSpanId: "",
      name,
      startTimeUnixNano: start,
      endTimeUnixNano: start + 1n,
      statusCode: "ok",
      statusMessage: "",
      runId: "run1",
      events: [],
      attributes: {
        "gen_ai.request.model": "m",
        "gen_ai.response.model": "m",
        "gen_ai.response.finish_reasons": "end_turn",
        "gen_ai.usage.input_tokens": 3,
        "gen_ai.usage.output_tokens": 4,
        "gen_ai.prompt": JSON.stringify([userMessage(q)]),
        "gen_ai.completion": JSON.stringify(assistantMessage(a)),
      },
    });
    store.insertSpans([
      span("s2", "galdor.provider.stream", 20n, "q2", "a2"),
      span("s1", "galdor.provider.generate", 10n, "q1", "a1"),
    ]);

    const rec = loadFromStore(store, "run1", { note: "from store" });
    store.close();

    expect(rec.version).toBe(CURRENT_FIXTURE_VERSION);
    expect(rec.runId).toBe("run1");
    expect(rec.note).toBe("from store");
    expect(rec.calls.map((c) => c.spanId)).toEqual(["s1", "s2"]); // sorted by start time
    expect(rec.calls[0]?.prompt[0]?.content[0]?.text).toBe("q1");
    expect(rec.calls[0]?.response.message.content[0]?.text).toBe("a1");
    expect(rec.calls[0]?.response.usage.inputTokens).toBe(3);

    // The reconstructed recording is replayable.
    const p = new ReplayProvider(rec.calls, "strict");
    expect(p.remaining()).toBe(2);
  });

  test("throws NoContentError when spans lack captured bodies", () => {
    const store = Store.open(":memory:");
    store.insertSpans([
      {
        spanId: "s1",
        traceId: "t1",
        parentSpanId: "",
        name: "galdor.provider.generate",
        startTimeUnixNano: 1n,
        endTimeUnixNano: 2n,
        statusCode: "ok",
        statusMessage: "",
        runId: "run1",
        events: [],
        attributes: { "gen_ai.request.model": "m" },
      },
    ]);
    expect(() => loadFromStore(store, "run1")).toThrow(NoContentError);
    store.close();
  });
});
