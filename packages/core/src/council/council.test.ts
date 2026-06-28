/**
 * core/council — tests for the supervisor and swarm runtimes.
 *
 * The supervisor's routing decision is plain JSON text, so it is driven with
 * the shared `TestProvider`. The swarm's handoffs are tool calls (which
 * TestProvider cannot emit), so swarm tests use a tiny in-test `ScriptProvider`
 * that replays scripted `Message` objects — including tool-call messages — in
 * order.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { NodeError } from "../graph/index.ts";
import {
  type Capabilities,
  type Provider,
  type Request,
  type Response,
  type RunContext,
} from "../provider/index.ts";
import { assistantMessage, type Message, messageText, Role } from "../schema/index.ts";
import { defineTool, Registry } from "../tool/index.ts";
import { TestProvider } from "../testprovider/index.ts";

import {
  makeSwarmRouter,
  makeSwarmTrap,
  MaxHopsExceededError,
  newSupervisor,
  newSwarm,
  runSupervisor,
  runSwarm,
  type SupervisorState,
  type SwarmAgent,
  type SwarmState,
  UnknownHandoffTargetError,
} from "./index.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const caps = (): Capabilities => ({
  streaming: false,
  toolCalling: true,
  structuredOutput: true,
  promptCaching: false,
  visionInput: false,
  reasoning: false,
  maxContextTokens: 8192,
});

/** Replays scripted Message objects (incl. tool calls) sequentially. */
class ScriptProvider implements Provider {
  #msgs: Message[];
  #i = 0;
  constructor(msgs: Message[]) {
    this.#msgs = msgs;
  }
  name(): string {
    return "script";
  }
  capabilities(): Capabilities {
    return caps();
  }
  async generate(_req: Request, ctx?: RunContext): Promise<Response> {
    ctx?.signal?.throwIfAborted();
    const m = this.#msgs[this.#i];
    if (!m) throw new Error("script: plan exhausted");
    this.#i++;
    return {
      message: m,
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      model: "script-1",
    };
  }
  async *stream(): AsyncIterable<never> {
    throw new Error("unsupported");
  }
  get calls(): number {
    return this.#i;
  }
}

function handoffCall(target: string, task: string): Message {
  return {
    role: Role.Assistant,
    content: [],
    toolCalls: [{ id: "h1", name: "handoff_to_" + target, arguments: task ? { task } : {} }],
  };
}

function unwrapCause(e: unknown): unknown {
  return e instanceof NodeError ? e.cause : e;
}

// ── Supervisor ─────────────────────────────────────────────────────────────────

describe("supervisor", () => {
  test("routes to a worker then finalizes", async () => {
    const provider = new TestProvider({
      responses: [`{"worker":"math","task":"compute 2+3"}`, `{"final":"The answer is 5."}`],
    });
    let mathTask = "";
    const final = await runSupervisor(
      {
        provider,
        model: "x",
        workers: [
          {
            name: "math",
            description: "performs calculations",
            run: async (task) => {
              mathTask = task;
              return "5";
            },
          },
        ],
      },
      "what is 2 plus 3?",
    );
    expect(final).toBe("The answer is 5.");
    expect(mathTask).toContain("2+3");
    expect(provider.requests().length).toBe(2);
  });

  test("records history across hops", async () => {
    const provider = new TestProvider({
      responses: [`{"worker":"a","task":"step one"}`, `{"worker":"b","task":"step two"}`, `{"final":"done"}`],
    });
    const r = newSupervisor({
      provider,
      model: "x",
      workers: [
        { name: "a", description: "first", run: async () => "out-a" },
        { name: "b", description: "second", run: async () => "out-b" },
      ],
    });
    const final = await r.invoke({ input: "hi", history: [], final: "", hops: 0, next: "", nextTask: "" });
    expect(final.final).toBe("done");
    expect(final.history.length).toBe(2);
    expect(final.history[0]).toEqual({ worker: "a", task: "step one", output: "out-a" });
    expect(final.history[1]).toEqual({ worker: "b", task: "step two", output: "out-b" });
    expect(final.hops).toBe(3);
  });

  test("tolerates code fences around the JSON decision", async () => {
    const provider = new TestProvider({
      responses: ['```json\n{"worker":"only","task":"do it"}\n```', '```json\n{"final":"finished"}\n```'],
    });
    const final = await runSupervisor(
      {
        provider,
        model: "x",
        workers: [{ name: "only", description: "single", run: async () => "ok" }],
      },
      "anything",
    );
    expect(final).toBe("finished");
  });

  test("caps at maxHops with MaxHopsExceededError", async () => {
    const provider = new TestProvider({
      responses: Array(5).fill(`{"worker":"loop","task":"again"}`),
    });
    const r = newSupervisor({
      provider,
      model: "x",
      maxHops: 3,
      workers: [{ name: "loop", description: "x", run: async () => "x" }],
    });
    let caught: unknown;
    try {
      await r.invoke({ input: "loop", history: [], final: "", hops: 0, next: "", nextTask: "" });
    } catch (e) {
      caught = e;
    }
    expect(unwrapCause(caught)).toBeInstanceOf(MaxHopsExceededError);
    expect((unwrapCause(caught) as MaxHopsExceededError).hops).toBe(3);
    const state = (caught as NodeError).state as SupervisorState;
    expect(state.hops).toBe(3);
    expect(state.final).toBe("");
  });

  test("rejects an unknown worker chosen by the router", async () => {
    const provider = new TestProvider({ responses: [`{"worker":"ghost","task":"x"}`] });
    await expect(
      runSupervisor(
        {
          provider,
          model: "x",
          workers: [{ name: "real", description: "y", run: async () => "" }],
        },
        "hi",
      ),
    ).rejects.toThrow(/ghost/);
  });

  test("rejects bad config", () => {
    const goodWorker = { name: "a", description: "", run: async () => "" };
    const p = new TestProvider({});
    expect(() => newSupervisor({ provider: undefined as never, model: "x", workers: [goodWorker] })).toThrow();
    expect(() => newSupervisor({ provider: p, model: "", workers: [goodWorker] })).toThrow();
    expect(() => newSupervisor({ provider: p, model: "x", workers: [] })).toThrow();
    expect(() =>
      newSupervisor({ provider: p, model: "x", workers: [{ ...goodWorker, name: "supervisor" }] }),
    ).toThrow();
    expect(() => newSupervisor({ provider: p, model: "x", workers: [{ ...goodWorker, name: "bad name" }] })).toThrow();
    expect(() => newSupervisor({ provider: p, model: "x", workers: [goodWorker, goodWorker] })).toThrow();
  });
});

// ── Swarm ──────────────────────────────────────────────────────────────────────

describe("swarm", () => {
  test("a handoff transfers control to the named peer", async () => {
    const provider = new ScriptProvider([handoffCall("writer", "summarize the findings"), assistantMessage("Here is the summary.")]);
    const final = await runSwarm(
      {
        agents: [
          { name: "researcher", description: "looks up facts", provider, model: "x", handoffs: ["writer"] },
          { name: "writer", description: "writes summaries", provider, model: "x", handoffs: [] },
        ],
        start: "researcher",
      },
      "research the topic",
    );
    expect(final).toBe("Here is the summary.");
    expect(provider.calls).toBe(2);
  });

  test("an agent executes a domain tool then produces a final answer", async () => {
    const add = defineTool({
      name: "add",
      description: "add two numbers",
      input: z.object({ a: z.number(), b: z.number() }),
      handler: ({ a, b }) => ({ sum: a + b }),
    });
    const reg = new Registry(add);
    const provider = new ScriptProvider([
      { role: Role.Assistant, content: [], toolCalls: [{ id: "c1", name: "add", arguments: { a: 2, b: 3 } }] },
      assistantMessage("the sum is 5"),
    ]);
    const final = await runSwarm(
      {
        agents: [{ name: "solo", description: "does math", provider, model: "x", tools: reg, handoffs: [] }],
        start: "solo",
      },
      "add 2 and 3",
    );
    expect(final).toBe("the sum is 5");
    expect(provider.calls).toBe(2);
  });

  test("caps at maxHops with MaxHopsExceededError", async () => {
    const provider = new ScriptProvider([handoffCall("b", ""), handoffCall("a", ""), handoffCall("b", "")]);
    const r = newSwarm({
      agents: [
        { name: "a", description: "x", provider, model: "x", handoffs: ["b"] },
        { name: "b", description: "y", provider, model: "x", handoffs: ["a"] },
      ],
      start: "a",
      maxHops: 3,
    });
    let caught: unknown;
    try {
      await r.invoke({ messages: [{ role: Role.User, content: [{ type: "text", text: "loop" }] }], active: "a", hops: 0, final: "" });
    } catch (e) {
      caught = e;
    }
    expect(unwrapCause(caught)).toBeInstanceOf(MaxHopsExceededError);
    const state = (caught as NodeError).state as SwarmState;
    expect(state.hops).toBe(3);
    expect(state.final).toBe("");
  });

  test("a handoff emits a tool-result acknowledging the transfer", async () => {
    const provider = new ScriptProvider([handoffCall("writer", "do it"), assistantMessage("done")]);
    const r = newSwarm({
      agents: [
        { name: "researcher", description: "r", provider, model: "x", handoffs: ["writer"] },
        { name: "writer", description: "w", provider, model: "x", handoffs: [] },
      ],
      start: "researcher",
    });
    const final = await r.invoke({
      messages: [{ role: Role.User, content: [{ type: "text", text: "go" }] }],
      active: "researcher",
      hops: 0,
      final: "",
    });
    const ack = final.messages.find((m) => m.role === Role.Tool && messageText(m).includes("handed off to writer"));
    expect(ack).toBeDefined();
    expect(final.final).toBe("done");
  });

  test("an undeclared handoff does not transfer control", async () => {
    // Agent "a" has an EMPTY handoffs list but emits handoff_to_b: control must
    // NOT transfer; the call is rejected as a tool error and a keeps control.
    const provider = new ScriptProvider([handoffCall("b", "do it"), assistantMessage("a finishes itself")]);
    const final = await runSwarm(
      {
        agents: [
          { name: "a", description: "x", provider, model: "x", handoffs: [] },
          { name: "b", description: "y", provider, model: "x", handoffs: [] },
        ],
        start: "a",
      },
      "go",
    );
    expect(final).toBe("a finishes itself");
    // Only a's two generate calls happened — b was never activated.
    expect(provider.calls).toBe(2);
  });

  test("an unknown handoff target surfaces UnknownHandoffTargetError", () => {
    const byName = new Map<string, SwarmAgent>([["a", { name: "a" } as SwarmAgent]]);
    const router = makeSwarmRouter(8, byName);
    expect(router({ messages: [], active: "ghost", hops: 1, final: "" })).toBe("__swarm_trap__");
    const trap = makeSwarmTrap(byName);
    expect(() => trap({ messages: [], active: "ghost", hops: 1, final: "" }, { runId: "" })).toThrow(
      UnknownHandoffTargetError,
    );
  });

  test("rejects a handoff_to_-prefixed domain tool at construction", () => {
    const collide = defineTool({
      name: "handoff_to_x",
      description: "collides",
      input: z.object({}),
      handler: () => ({}),
    });
    const reg = new Registry(collide);
    const provider = new ScriptProvider([]);
    expect(() =>
      newSwarm({
        agents: [{ name: "a", description: "x", provider, model: "x", tools: reg, handoffs: [] }],
        start: "a",
      }),
    ).toThrow(/handoff_to_x/);
  });

  test("rejects bad config", () => {
    const provider = new ScriptProvider([]);
    const good: SwarmAgent = { name: "a", description: "x", provider, model: "x", handoffs: [] };
    expect(() => newSwarm({ agents: [], start: "a" })).toThrow();
    expect(() => newSwarm({ agents: [good], start: "" })).toThrow();
    expect(() => newSwarm({ agents: [good], start: "ghost" })).toThrow();
    expect(() =>
      newSwarm({ agents: [{ ...good, handoffs: ["a"] }], start: "a" }),
    ).toThrow(); // handoff to self
    expect(() =>
      newSwarm({ agents: [{ ...good, handoffs: ["ghost"] }], start: "a" }),
    ).toThrow(); // handoff to ghost
    expect(() => newSwarm({ agents: [good, { ...good, description: "y" }], start: "a" })).toThrow(); // dup name
    expect(() => newSwarm({ agents: [{ ...good, name: "bad name" }], start: "bad name" })).toThrow();
    expect(() => newSwarm({ agents: [{ ...good, provider: undefined as never }], start: "a" })).toThrow();
    expect(() => newSwarm({ agents: [{ ...good, model: "" }], start: "a" })).toThrow();
  });
});
