import { describe, expect, test } from "bun:test";
import { type Message, Role } from "../schema/index.ts";
import { ToolCallInvariantError, validateToolCalls } from "./toolcalls.ts";

const withCalls = (calls: Message["toolCalls"]): Message => ({
  role: Role.Assistant,
  content: [],
  ...(calls ? { toolCalls: calls } : {}),
});

describe("validateToolCalls", () => {
  test("returns null when there are no tool calls", () => {
    expect(validateToolCalls(withCalls(undefined))).toBeNull();
  });

  test("accepts a well-formed tool call", () => {
    const msg = withCalls([{ id: "call_1", name: "search", arguments: { q: "x" } }]);
    expect(validateToolCalls(msg)).toBeNull();
  });

  test("accepts a tool call with absent arguments", () => {
    const msg = withCalls([{ id: "call_1", name: "ping", arguments: undefined as never }]);
    expect(validateToolCalls(msg)).toBeNull();
  });

  test("rejects an empty id", () => {
    const msg = withCalls([{ id: "", name: "search", arguments: {} }]);
    const err = validateToolCalls(msg);
    expect(err).toBeInstanceOf(ToolCallInvariantError);
    expect(err?.message).toContain("empty id");
  });

  test("rejects an empty name", () => {
    const msg = withCalls([{ id: "call_1", name: "", arguments: {} }]);
    const err = validateToolCalls(msg);
    expect(err).toBeInstanceOf(ToolCallInvariantError);
    expect(err?.message).toContain("empty name");
  });
});
