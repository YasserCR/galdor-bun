/**
 * The ReAct (reason-and-act) agent loop.
 *
 * Compiles a `Runnable<State>` over the graph runtime with this shape:
 *
 *   START -> model
 *   model -> (tool calls?  tools  :  END)
 *   tools -> model
 *
 * The model node asks the provider for the next turn; if that turn requests
 * tools, the tools node runs them and feeds the results back to the model,
 * otherwise the loop ends with the assistant's text. Because the result is an
 * ordinary Runnable, checkpointing, streaming and resume all work without extra
 * wiring. {@link run} is the one-shot convenience wrapper around it.
 */

import {
  END,
  Graph,
  type NodeFunc,
  type Router,
  type Runnable,
  START,
} from "../graph/index.ts";
import {
  type Provider,
  type Request,
  type RunContext,
} from "../provider/index.ts";
import {
  type Message,
  messageText,
  Role,
  systemMessage,
  userMessage,
} from "../schema/index.ts";
import {
  asToolResultMessages,
  executeCalls,
  type Registry,
} from "../tool/index.ts";

/**
 * The value that flows through the ReAct graph as it runs.
 *
 * Each node receives a {@link State} and returns an updated copy; the graph
 * carries it from the model node to the tools node and back until the loop
 * terminates.
 */
export interface State {
  /** The running conversation. */
  messages: Message[];
  /** Set when the loop ends on an assistant message with no tool calls. */
  finalText: string;
  /** How many times the model node executed in this run. */
  iterations: number;
  /** Set when the loop stopped at the iteration cap with tool calls pending. */
  stoppedAtIterationCap: boolean;
}

/**
 * Raised by {@link run} when the loop hit the iteration cap while tool calls
 * were still pending, so callers don't mistake a truncated run for a completed
 * empty answer. Any best-effort partial text the model produced is carried on
 * {@link MaxIterationsError.finalText}.
 */
export class MaxIterationsError extends Error {
  override name = "MaxIterationsError";
  readonly finalText: string;
  constructor(finalText: string) {
    super("agent: stopped at MaxIterations with tool calls still pending");
    this.finalText = finalText;
  }
}

/** Configuration for a ReAct agent built by {@link newReAct} or {@link run}. */
export interface Config {
  /** Required. The provider that generates each model turn. */
  provider: Provider;
  /** Optional; when set, its toolDefs are attached and the model may call tools. */
  tools?: Registry;
  /** Required model ID. */
  model: string;
  /** Bounds model<->tools cycles. Default 10. */
  maxIterations?: number;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  /** When true, the first model turn must invoke a tool (ToolChoice required). */
  forceToolUse?: boolean;
}

function validateConfig(cfg: Config): void {
  if (!cfg.provider) throw new Error("agent: Config.provider is required");
  if (!cfg.model) throw new Error("agent: Config.model is required");
  const caps = cfg.provider.capabilities();
  if (cfg.tools && !caps.toolCalling) {
    throw new Error(
      `agent: provider ${cfg.provider.name()} does not support tool calling but Config.tools is set`,
    );
  }
  if (cfg.forceToolUse && !cfg.tools) {
    throw new Error("agent: Config.forceToolUse=true requires Config.tools to be set");
  }
  if (cfg.maxIterations !== undefined && cfg.maxIterations < 0) {
    throw new Error(
      `agent: Config.maxIterations must be >= 0 (got ${cfg.maxIterations}); use 0 for the default`,
    );
  }
}

/**
 * Compile a ReAct agent into a `Runnable<State>`.
 *
 * @param cfg - Provider, model and loop settings; see {@link Config}.
 * @returns A runnable that drives the reason-and-act loop and can be invoked,
 * streamed, checkpointed or resumed like any other graph.
 * @throws Error when the configuration is invalid — for example a missing
 * provider or model, tools supplied to a provider that cannot call tools, or a
 * negative `maxIterations`.
 * @example
 * ```ts
 * const agent = newReAct({ provider, tools, model: "m" });
 * const final = await agent.invoke(seedState("add 2 and 3"));
 * console.log(final.finalText);
 * ```
 */
export function newReAct(cfg: Config): Runnable<State> {
  validateConfig(cfg);

  const maxIter = cfg.maxIterations && cfg.maxIterations > 0 ? cfg.maxIterations : 10;
  const toolDefs = cfg.tools ? cfg.tools.toolDefs() : [];

  const modelNode: NodeFunc<State> = async (s, ctx) => {
    const req: Request = { model: cfg.model, messages: s.messages };
    if (toolDefs.length > 0) req.tools = toolDefs;
    if (cfg.temperature !== undefined) req.temperature = cfg.temperature;
    if (cfg.topP !== undefined) req.topP = cfg.topP;
    if (cfg.maxTokens !== undefined) req.maxTokens = cfg.maxTokens;
    if (cfg.stopSequences !== undefined) req.stopSequences = cfg.stopSequences;
    if (cfg.forceToolUse && toolDefs.length > 0) req.toolChoice = "required";
    else if (toolDefs.length > 0) req.toolChoice = "auto";

    const resp = await cfg.provider.generate(req, ctx);
    const messages = [...s.messages, resp.message];
    const iterations = s.iterations + 1;

    const calls = resp.message.toolCalls ?? [];
    if (calls.length === 0) {
      return { ...s, messages, iterations, finalText: messageText(resp.message) };
    }
    if (iterations >= maxIter) {
      // Cap reached with tool calls pending: the router ends this cycle without
      // executing the tools. Flag the truncation and surface any text produced.
      return {
        ...s,
        messages,
        iterations,
        stoppedAtIterationCap: true,
        finalText: messageText(resp.message),
      };
    }
    return { ...s, messages, iterations };
  };

  const toolsNode: NodeFunc<State> = async (s, ctx) => {
    if (!cfg.tools) throw new Error("agent: tools node reached but Config.tools is nil");
    const last = s.messages.at(-1);
    if (!last) throw new Error("agent: tools node reached with empty messages");
    if (last.role !== Role.Assistant || !last.toolCalls || last.toolCalls.length === 0) {
      throw new Error("agent: tools node reached without pending tool calls");
    }
    const results = await executeCalls(cfg.tools, last.toolCalls, ctx);
    return { ...s, messages: [...s.messages, ...asToolResultMessages(results)] };
  };

  const router: Router<State> = (s) => {
    if (s.iterations >= maxIter) return END;
    const last = s.messages.at(-1);
    if (last && last.role === Role.Assistant && last.toolCalls && last.toolCalls.length > 0) {
      return "tools";
    }
    return END;
  };

  let g = new Graph<State>().addNode("model", modelNode).addEdge(START, "model").addConditionalEdge("model", router);
  if (cfg.tools) {
    g = g.addNode("tools", toolsNode).addEdge("tools", "model");
  }

  const r = g.compile();
  // Each model<->tools cycle is two hops, plus the terminal hop; 3x headroom so
  // the runtime step ceiling never fires before the soft cap in the router.
  r.maxSteps = maxIter * 3 + 4;
  return r;
}

/**
 * Build a fresh {@link State} from the user input and any system prompts.
 *
 * @param input - The user message that starts the conversation.
 * @param system - Zero or more system prompts prepended in order; empty
 * strings are skipped.
 * @returns A seed state with the messages assembled and counters reset.
 */
export function seedState(input: string, system: string[] = []): State {
  const messages: Message[] = [];
  for (const s of system) if (s !== "") messages.push(systemMessage(s));
  messages.push(userMessage(input));
  return { messages, finalText: "", iterations: 0, stoppedAtIterationCap: false };
}

/**
 * One-shot convenience wrapper around {@link newReAct}: build a fresh runnable,
 * invoke it with the input and return the final assistant text.
 *
 * @param cfg - Provider, model and loop settings; see {@link Config}.
 * @param input - The user request to answer.
 * @param opts - Optional system prompts and an `AbortSignal` to cancel the run.
 * @returns The assistant's final text answer.
 * @throws MaxIterationsError when the loop was truncated at the iteration cap
 * with tool calls still pending; the partial text is on its `finalText` field.
 * @throws Error for any invalid configuration surfaced by {@link newReAct}.
 *
 * For multi-turn chat, mid-run pauses, streaming or checkpointing, build the
 * runnable directly via {@link newReAct} and drive it like any other graph.
 * @example
 * ```ts
 * const answer = await run({ provider, model: "m" }, "capital of Ecuador?");
 * ```
 */
export async function run(
  cfg: Config,
  input: string,
  opts: { system?: string[]; signal?: AbortSignal } = {},
): Promise<string> {
  const r = newReAct(cfg);
  const final = await r.invoke(seedState(input, opts.system), opts.signal ? { signal: opts.signal } : {});
  if (final.stoppedAtIterationCap) throw new MaxIterationsError(final.finalText);
  return final.finalText;
}
