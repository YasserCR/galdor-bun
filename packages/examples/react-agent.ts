/**
 * ReAct agent: reason, optionally act, then answer — with no network calls.
 *
 * Run it:
 *
 *   bun packages/examples/react-agent.ts
 *
 * The script shows two flavours of the reason-and-act loop:
 *
 *   1. A plain question/answer turn, where the model replies directly. The
 *      provider is a `TestProvider` scripted with a single canned response, so
 *      the agent resolves instantly and offline.
 *
 *   2. A tool-using turn, where the model first asks to call a tool, the loop
 *      executes that tool, feeds the result back, and the model produces a
 *      final answer. The provider here is a tiny hand-written one that emits a
 *      tool call on its first turn and a closing sentence on its second.
 *
 * Both flavours use the same `agent.run` / `agent.newReAct` entry points you
 * would use against a real model — only the provider changes.
 */

import { z } from "zod";
import { run } from "@galdor/core/agent";
import { defineTool, Registry } from "@galdor/core/tool";
import { TestProvider } from "@galdor/core/testprovider";
import type {
  Capabilities,
  Event,
  Provider,
  Request,
  Response,
} from "@galdor/core/provider";
import {
  Role,
  StopReason,
  textPart,
  type Usage,
} from "@galdor/core/schema";

const noUsage: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

// ── 1. A direct answer via a scripted TestProvider ────────────────────────────

async function directAnswer(): Promise<void> {
  // TestProvider returns its scripted responses in order; one call, one answer.
  const provider = new TestProvider({
    responses: ["The capital of Ecuador is Quito."],
  });

  const answer = await run({ provider, model: "demo-model" }, "What is the capital of Ecuador?");

  console.log("=== direct answer ===");
  console.log("Q: What is the capital of Ecuador?");
  console.log("A:", answer);
  console.log();
}

// ── 2. A tool-using turn driven by an inline scripted provider ────────────────

/**
 * A minimal provider whose `generate` walks a fixed list of responses. The
 * first response asks to call the `add` tool; the second, returned after the
 * tool result is fed back, is the final answer. `stream` is never reached by
 * the ReAct loop in this example, so it stays a stub.
 */
class ScriptedToolProvider implements Provider {
  #responses: Response[];
  #cursor = 0;

  constructor(responses: Response[]) {
    this.#responses = responses;
  }

  name(): string {
    return "scripted";
  }

  capabilities(): Capabilities {
    return {
      streaming: false,
      toolCalling: true,
      structuredOutput: false,
      promptCaching: false,
      visionInput: false,
      reasoning: false,
      maxContextTokens: 8192,
    };
  }

  async generate(_req: Request): Promise<Response> {
    const next = this.#responses[this.#cursor++];
    if (!next) throw new Error("scripted provider: ran out of responses");
    return next;
  }

  async *stream(): AsyncIterable<Event> {
    throw new Error("scripted provider: stream is not used in this example");
  }
}

async function toolUsingAnswer(): Promise<void> {
  // A single tool: add two integers. The Zod schema both validates the model's
  // arguments and is advertised to the provider as JSON Schema.
  const add = defineTool({
    name: "add",
    description: "Add two integers and return their sum.",
    input: z.object({ a: z.number(), b: z.number() }),
    handler: ({ a, b }) => ({ sum: a + b }),
  });

  // Turn 1: the model requests the `add` tool with a=2, b=3.
  const askForTool: Response = {
    message: {
      role: Role.Assistant,
      content: [textPart("I'll add those for you.")],
      toolCalls: [{ id: "call-1", name: "add", arguments: { a: 2, b: 3 } }],
    },
    stopReason: StopReason.ToolUse,
    usage: noUsage,
    model: "scripted",
  };

  // Turn 2: after seeing the tool result, the model writes the final answer.
  const finalAnswer: Response = {
    message: { role: Role.Assistant, content: [textPart("2 + 3 = 5.")] },
    stopReason: StopReason.EndTurn,
    usage: noUsage,
    model: "scripted",
  };

  const provider = new ScriptedToolProvider([askForTool, finalAnswer]);

  const answer = await run(
    { provider, model: "scripted", tools: new Registry(add) },
    "What is 2 + 3? Use the add tool.",
  );

  console.log("=== tool-using answer ===");
  console.log("Q: What is 2 + 3? Use the add tool.");
  console.log("A:", answer);
}

await directAnswer();
await toolUsingAnswer();
