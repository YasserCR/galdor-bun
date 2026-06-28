import { describe, expect, test } from "bun:test";
import {
  ContentType,
  ephemeralCache,
  type Message,
  Role,
  userMessage,
} from "../schema/index.ts";
import { UnsupportedError } from "./errors.ts";
import type { Capabilities, Request } from "./index.ts";
import { validateRequest } from "./capabilities.ts";

const allCaps = (): Capabilities => ({
  streaming: true,
  toolCalling: true,
  structuredOutput: true,
  promptCaching: true,
  visionInput: true,
  reasoning: true,
  maxContextTokens: 8192,
});

const baseReq = (): Request => ({ model: "m", messages: [userMessage("hi")] });

describe("validateRequest", () => {
  test("accepts a request that fits the capabilities", () => {
    expect(validateRequest(allCaps(), baseReq())).toBeNull();
  });

  test("rejects tools when toolCalling is unsupported", () => {
    const caps = { ...allCaps(), toolCalling: false };
    const req: Request = {
      ...baseReq(),
      tools: [{ name: "search", description: "", schema: {} }],
    };
    const err = validateRequest(caps, req);
    expect(err).toBeInstanceOf(UnsupportedError);
    expect(err?.kind).toBe("unsupported");
  });

  test("rejects responseFormat when structuredOutput is unsupported", () => {
    const caps = { ...allCaps(), structuredOutput: false };
    const req: Request = { ...baseReq(), responseFormat: { type: "json_object" } };
    expect(validateRequest(caps, req)).toBeInstanceOf(UnsupportedError);
  });

  test("rejects image parts when visionInput is unsupported", () => {
    const caps = { ...allCaps(), visionInput: false };
    const imgMsg: Message = {
      role: Role.User,
      content: [{ type: ContentType.Image, image: { url: "http://x/y.png" } }],
    };
    const req: Request = { ...baseReq(), messages: [imgMsg] };
    expect(validateRequest(caps, req)).toBeInstanceOf(UnsupportedError);
  });

  test("rejects cache-control hints when promptCaching is unsupported", () => {
    const caps = { ...allCaps(), promptCaching: false };
    const cached: Message = { ...userMessage("hi"), cacheControl: ephemeralCache() };
    const req: Request = { ...baseReq(), messages: [cached] };
    expect(validateRequest(caps, req)).toBeInstanceOf(UnsupportedError);
  });

  test("rejects enabled reasoning when reasoning is unsupported", () => {
    const caps = { ...allCaps(), reasoning: false };
    const req: Request = { ...baseReq(), reasoning: { enabled: true } };
    expect(validateRequest(caps, req)).toBeInstanceOf(UnsupportedError);
  });

  test("does not reject disabled reasoning when reasoning is unsupported", () => {
    const caps = { ...allCaps(), reasoning: false };
    const req: Request = { ...baseReq(), reasoning: { enabled: false } };
    expect(validateRequest(caps, req)).toBeNull();
  });
});
