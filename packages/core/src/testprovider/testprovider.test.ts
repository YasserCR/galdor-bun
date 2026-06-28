import { describe, expect, test } from "bun:test";
import { messageText, userMessage } from "../schema/index.ts";
import { collectStream } from "../provider/index.ts";
import { ScriptExhaustedError, TestProvider } from "./index.ts";

const req = (text: string) => ({ model: "test", messages: [userMessage(text)] });

describe("TestProvider.generate", () => {
  test("returns scripted responses in order", async () => {
    const p = new TestProvider({ responses: ["a", "b"] });
    expect(messageText((await p.generate(req("1"))).message)).toBe("a");
    expect(messageText((await p.generate(req("2"))).message)).toBe("b");
    expect(p.remaining()).toBe(0);
  });

  test("interleaves responses and errors in declared order", async () => {
    const boom = new Error("rate limited");
    const p = new TestProvider({ responses: ["a"], errors: [boom] });
    expect(messageText((await p.generate(req("1"))).message)).toBe("a");
    await expect(p.generate(req("2"))).rejects.toBe(boom);
  });

  test("throws ScriptExhaustedError past the end", async () => {
    const p = new TestProvider({ responses: ["only"] });
    await p.generate(req("1"));
    await expect(p.generate(req("2"))).rejects.toBeInstanceOf(ScriptExhaustedError);
  });

  test("jsonResponses are JSON-encoded into the text", async () => {
    const p = new TestProvider({ jsonResponses: [{ intent: "buy", amount: 42 }] });
    expect(messageText((await p.generate(req("x"))).message)).toBe(
      '{"intent":"buy","amount":42}',
    );
  });

  test("records requests and reset rewinds", async () => {
    const p = new TestProvider({ responses: ["a", "b"] });
    await p.generate(req("first"));
    expect(p.requests()).toHaveLength(1);
    p.reset();
    expect(p.requests()).toHaveLength(0);
    expect(p.remaining()).toBe(2);
  });

  test("mutating a returned response does not poison replays", async () => {
    const p = new TestProvider({ responses: ["a"] });
    const r1 = await p.generate(req("1"));
    r1.message.content.push({ type: "text", text: "tampered" });
    p.reset();
    const r2 = await p.generate(req("1"));
    expect(messageText(r2.message)).toBe("a");
  });
});

describe("TestProvider.stream", () => {
  test("stream collected via collectStream reassembles the text", async () => {
    const p = new TestProvider({ responses: ["hello world"] });
    const resp = await collectStream(p.stream(req("hi")));
    expect(messageText(resp.message)).toBe("hello world");
    expect(resp.stopReason).toBe("end_turn");
  });

  test("abort signal aborts before producing events", async () => {
    const p = new TestProvider({ responses: ["a"] });
    const ctrl = new AbortController();
    ctrl.abort();
    const it = p.stream(req("hi"), { signal: ctrl.signal })[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow();
  });
});
