import { describe, expect, test } from "bun:test";
import {
  assistantMessage,
  ContentType,
  ephemeralCache,
  isValidRole,
  messageText,
  Role,
  systemMessage,
  textPart,
  toolResultMessage,
  usageTotal,
  userMessage,
} from "./index.ts";

describe("schema messages", () => {
  test("constructors set role and text content", () => {
    expect(systemMessage("sys").role).toBe(Role.System);
    expect(userMessage("hi").role).toBe(Role.User);
    expect(assistantMessage("yo").role).toBe(Role.Assistant);

    const m = userMessage("hello");
    expect(m.content).toHaveLength(1);
    expect(m.content[0]?.type).toBe(ContentType.Text);
    expect(messageText(m)).toBe("hello");
  });

  test("toolResultMessage links back to the call id", () => {
    const m = toolResultMessage("call_123", "42");
    expect(m.role).toBe(Role.Tool);
    expect(m.toolCallId).toBe("call_123");
    expect(messageText(m)).toBe("42");
  });

  test("messageText concatenates only text parts", () => {
    const m = {
      role: Role.Assistant,
      content: [textPart("a"), { type: ContentType.Thinking, text: "ignored" }, textPart("b")],
    };
    expect(messageText(m)).toBe("ab");
  });
});

describe("schema helpers", () => {
  test("isValidRole accepts known roles, rejects others", () => {
    expect(isValidRole("user")).toBe(true);
    expect(isValidRole("tool")).toBe(true);
    expect(isValidRole("wizard")).toBe(false);
  });

  test("usageTotal sums all token buckets", () => {
    expect(
      usageTotal({
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationTokens: 3,
        cacheReadTokens: 4,
      }),
    ).toBe(37);
  });

  test("ephemeralCache produces an ephemeral control", () => {
    expect(ephemeralCache().type).toBe("ephemeral");
  });
});
