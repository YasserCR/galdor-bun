import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type Capabilities,
  type Event,
  EventType,
  type Provider,
  type Request,
  type Response,
} from "../provider/index.ts";
import { assistantMessage, type Message, Role, textPart } from "../schema/index.ts";
import { TestProvider } from "../testprovider/index.ts";
import { defineTool, Registry } from "../tool/index.ts";
import {
  MaxIterationsError,
  newReAct,
  parsePlan,
  parseReplan,
  run,
  runPlanAndExecute,
  stripFences,
} from "./index.ts";

const caps: Capabilities = {
  streaming: true,
  toolCalling: true,
  structuredOutput: true,
  promptCaching: false,
  visionInput: false,
  reasoning: false,
  maxContextTokens: 8192,
};

/** A provider that replays scripted Response objects (incl. tool-call turns). */
class ScriptedProvider implements Provider {
  #calls: Response[];
  #i = 0;
  seen: Request[] = [];
  constructor(calls: Response[]) {
    this.#calls = calls;
  }
  name() {
    return "scripted";
  }
  capabilities() {
    return caps;
  }
  async generate(req: Request): Promise<Response> {
    this.seen.push(req);
    const r = this.#calls[this.#i++];
    if (!r) throw new Error("scripted: out of responses");
    return structuredClone(r);
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<Event> {
    throw new Error("not used");
  }
}

const toolCallTurn = (id: string, name: string, args: unknown): Response => ({
  message: { role: Role.Assistant, content: [], toolCalls: [{ id, name, arguments: args as never }] },
  stopReason: "tool_use",
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  model: "test",
});

const textTurn = (text: string): Response => ({
  message: assistantMessage(text),
  stopReason: "end_turn",
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  model: "test",
});

describe("ReAct — no tools", () => {
  test("returns the model's text answer in one iteration", async () => {
    const p = new TestProvider({ responses: ["Quito"] });
    const out = await run({ provider: p, model: "m" }, "capital of Ecuador?");
    expect(out).toBe("Quito");
    expect(p.requests()).toHaveLength(1);
  });
});

describe("ReAct — tool loop", () => {
  test("executes a tool call, then returns the final text", async () => {
    const add = defineTool({
      name: "add",
      input: z.object({ a: z.number(), b: z.number() }),
      handler: ({ a, b }) => ({ sum: a + b }),
    });
    const tools = new Registry(add);
    const provider = new ScriptedProvider([
      toolCallTurn("c1", "add", { a: 2, b: 3 }),
      textTurn("the sum is 5"),
    ]);

    const r = newReAct({ provider, tools, model: "m" });
    const final = await r.invoke({ messages: [], finalText: "", iterations: 0, stoppedAtIterationCap: false });

    expect(final.finalText).toBe("the sum is 5");
    expect(final.iterations).toBe(2);
    // a tool-result message was appended between the two assistant turns
    const toolMsg = final.messages.find((m: Message) => m.role === Role.Tool);
    expect(toolMsg?.content[0]).toEqual(textPart('{"sum":5}'));
  });

  test("stops at the iteration cap when tools never resolve", async () => {
    const echo = defineTool({ name: "echo", input: z.object({}), handler: () => ({}) });
    const tools = new Registry(echo);
    // Always asks for a tool → never terminates on its own.
    const provider = new ScriptedProvider([
      toolCallTurn("c1", "echo", {}),
      toolCallTurn("c2", "echo", {}),
      toolCallTurn("c3", "echo", {}),
    ]);
    await expect(
      run({ provider, tools, model: "m", maxIterations: 2 }, "go"),
    ).rejects.toBeInstanceOf(MaxIterationsError);
  });
});

describe("ReAct — validation", () => {
  test("missing provider/model is rejected", () => {
    // @ts-expect-error intentionally missing provider
    expect(() => newReAct({ model: "m" })).toThrow(/provider is required/);
  });

  test("forceToolUse without tools is rejected", () => {
    const p = new TestProvider();
    expect(() => newReAct({ provider: p, model: "m", forceToolUse: true })).toThrow(/forceToolUse/);
  });
});

describe("Plan-and-Execute", () => {
  test("plans one step, executes it, then finishes via the replanner", async () => {
    // One shared provider serves planner, executor (inner ReAct), replanner.
    const p = new TestProvider({
      responses: ['["do the thing"]', "did the thing", '{"plan":[],"final":"all done"}'],
    });
    const out = await runPlanAndExecute({ provider: p, model: "m" }, "please do it");
    expect(out).toBe("all done");
    // planner + 1 executor turn + replanner = 3 provider calls
    expect(p.requests()).toHaveLength(3);
  });
});

describe("parsing helpers", () => {
  test("stripFences removes ```json fences", () => {
    expect(stripFences('```json\n["a"]\n```')).toContain('["a"]');
  });

  test("parsePlan tolerates prose and fences around the array", () => {
    expect(parsePlan('Here you go:\n```json\n["x","y"]\n```')).toEqual(["x", "y"]);
  });

  test("parseReplan reads plan and final", () => {
    expect(parseReplan('{"plan":["next"],"final":""}')).toEqual({ plan: ["next"], final: "" });
    expect(parseReplan('{"plan":[],"final":"answer"}')).toEqual({ plan: [], final: "answer" });
  });

  test("parsePlan rejects non-array JSON", () => {
    expect(() => parsePlan('{"not":"an array"}')).toThrow(/JSON array/);
  });
});
