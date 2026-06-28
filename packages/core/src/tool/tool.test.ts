import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { messageText } from "../schema/index.ts";
import {
  asToolResultMessages,
  defineTool,
  executeCalls,
  InvalidInputError,
  Registry,
  UnknownToolError,
} from "./index.ts";

const add = defineTool({
  name: "add",
  description: "add two numbers",
  input: z.object({ a: z.number(), b: z.number() }),
  handler: ({ a, b }) => ({ sum: a + b }),
});

describe("defineTool", () => {
  test("derives a JSON Schema from the Zod input", () => {
    const s = add.schema() as Record<string, unknown>;
    expect(s.type).toBe("object");
    expect((s.properties as Record<string, unknown>).a).toBeDefined();
  });

  test("execute is typed and runs the handler", async () => {
    expect(await add.execute({ a: 2, b: 3 })).toEqual({ sum: 5 });
  });

  test("executeJSON validates input and returns JSON output", async () => {
    expect(await add.executeJSON({ a: 1, b: 1 })).toEqual({ sum: 2 });
  });

  test("executeJSON throws InvalidInputError on bad input", async () => {
    await expect(add.executeJSON({ a: "nope" })).rejects.toBeInstanceOf(InvalidInputError);
  });

  test("rejects a missing/non-function handler", () => {
    expect(() =>
      defineTool({
        name: "x",
        input: z.object({}),
        // deliberately not a function to exercise the guard
        handler: undefined as unknown as () => unknown,
      }),
    ).toThrow(/handler is required/);
  });
});

describe("Registry", () => {
  test("rejects duplicate names", () => {
    const r = new Registry(add);
    expect(() => r.add(add)).toThrow(/duplicate/);
  });

  test("add rejects a null/undefined tool with a clean error", () => {
    const r = new Registry();
    expect(() => r.add(null as unknown as typeof add)).toThrow(/nil tool/);
    expect(() => r.add(undefined as unknown as typeof add)).toThrow(/nil tool/);
  });

  test("tools() is name-sorted; toolDefs() mirrors it", () => {
    const z2 = defineTool({ name: "zeta", input: z.object({}), handler: () => ({}) });
    const r = new Registry(z2, add);
    expect(r.tools().map((t) => t.name())).toEqual(["add", "zeta"]);
    expect(r.toolDefs().map((d) => d.name)).toEqual(["add", "zeta"]);
    expect(r.size).toBe(2);
  });
});

describe("executeCalls", () => {
  test("dispatches by name, preserves order", async () => {
    const r = new Registry(add);
    const results = await executeCalls(r, [
      { id: "1", name: "add", arguments: { a: 1, b: 2 } },
      { id: "2", name: "add", arguments: { a: 10, b: 20 } },
    ]);
    expect(results.map((x) => x.id)).toEqual(["1", "2"]);
    expect(results[0]?.output).toEqual({ sum: 3 });
    expect(results[1]?.output).toEqual({ sum: 30 });
  });

  test("unknown tool surfaces UnknownToolError in the result", async () => {
    const r = new Registry(add);
    const [res] = await executeCalls(r, [{ id: "9", name: "nope", arguments: {} }]);
    expect(res?.error).toBeInstanceOf(UnknownToolError);
  });

  test("a throwing handler is recovered into the result, not propagated", async () => {
    const boom = defineTool({
      name: "boom",
      input: z.object({}),
      handler: () => {
        throw new Error("kaboom");
      },
    });
    const r = new Registry(boom);
    const [res] = await executeCalls(r, [{ id: "1", name: "boom", arguments: {} }]);
    expect((res?.error as Error).message).toBe("kaboom");
  });

  test("a null/undefined registry yields one error result per call, in order", async () => {
    const results = await executeCalls(null as unknown as Registry, [
      { id: "1", name: "add", arguments: {} },
      { id: "2", name: "sub", arguments: {} },
    ]);
    expect(results.map((x) => x.id)).toEqual(["1", "2"]);
    expect(results.map((x) => x.name)).toEqual(["add", "sub"]);
    expect((results[0]?.error as Error).message).toBe("tool: nil registry");
    expect((results[1]?.error as Error).message).toBe("tool: nil registry");
    expect(results[0]?.output).toBeUndefined();
  });

  test("aborted signal short-circuits with an error result", async () => {
    const r = new Registry(add);
    const ctrl = new AbortController();
    ctrl.abort();
    const [res] = await executeCalls(r, [{ id: "1", name: "add", arguments: { a: 1, b: 1 } }], {
      signal: ctrl.signal,
    });
    expect(res?.error).toBeDefined();
    expect(res?.output).toBeUndefined();
  });
});

describe("asToolResultMessages", () => {
  test("maps outputs and errors into tool-result messages", () => {
    const msgs = asToolResultMessages([
      { id: "1", name: "add", output: { sum: 3 } },
      { id: "2", name: "boom", error: new Error("kaboom") },
    ]);
    expect(msgs[0]?.toolCallId).toBe("1");
    expect(messageText(msgs[0]!)).toBe('{"sum":3}');
    expect(messageText(msgs[1]!)).toBe("error: kaboom");
  });
});
