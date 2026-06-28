/**
 * The Plan-and-Execute agent loop.
 *
 *   START -> plan -> execute -> replan -> (execute | END)
 *
 * The planner emits an initial JSON list of steps. The executor runs each step
 * through an inner ReAct sub-agent equipped with the configured tools. After
 * every step the replanner decides whether to continue with the remaining plan,
 * revise it, or finish with an answer. {@link newPlanAndExecute} compiles the
 * loop into a runnable and {@link runPlanAndExecute} is the one-shot wrapper.
 */

import {
  END,
  Graph,
  type NodeFunc,
  type Router,
  type Runnable,
  START,
} from "../graph/index.ts";
import type { Provider } from "../provider/index.ts";
import { messageText, systemMessage, userMessage } from "../schema/index.ts";
import type { Registry } from "../tool/index.ts";
import { type Config as ReActConfig, run as runReAct } from "./react.ts";

/** A single executed plan step paired with the result the executor produced. */
export interface StepRecord {
  /** The step description that was executed. */
  step: string;
  /** The text result the executor returned for that step. */
  result: string;
}

/** The value flowing through the Plan-and-Execute graph. */
export interface PlanExecuteState {
  /** Original user request. */
  input: string;
  /** Remaining steps, in order; the first is next to run. */
  plan: string[];
  /** Executed steps with their results, in order. */
  past: StepRecord[];
  /** When non-empty, terminates the loop with this text as the answer. */
  final: string;
  /** How many full plan/execute/replan cycles have elapsed. */
  iter: number;
}

/** Configuration for a Plan-and-Execute agent; see {@link newPlanAndExecute}. */
export interface PlanExecuteConfig {
  /** Serves every role unless an override is set. Required (or override all). */
  provider?: Provider;
  plannerProvider?: Provider;
  executorProvider?: Provider;
  replannerProvider?: Provider;
  /** Model ID used by every role unless overridden. Required (or override all). */
  model?: string;
  plannerModel?: string;
  executorModel?: string;
  replannerModel?: string;
  /** Registry the executor sub-agent uses. Optional. */
  tools?: Registry;
  /** Caps plan/execute/replan cycles. Default 8. */
  maxIterations?: number;
  /** Caps the inner ReAct loop per step. Default 6. */
  maxStepIterations?: number;
  plannerPrompt?: string;
  replannerPrompt?: string;
}

const DEFAULT_PLANNER_PROMPT = `You are a planning agent. Given a user request, produce a short, ordered plan of concrete steps that, executed in order, will answer the request.

Output ONLY a JSON array of strings. No prose, no markdown, no code fences.
Each string is one step. Keep the plan short (1-5 steps). Do not number the steps; the array order is the order.

Example output: ["look up the population of Quito", "compute the answer"]`;

const DEFAULT_REPLANNER_PROMPT = `You are a replanning agent. You will be shown the original user request, the steps already executed (each with its observed result), and the remaining plan. Decide one of:

1. Continue: the remaining plan is still correct. Repeat it back as-is.
2. Revise: replace the remaining plan with a different list of steps.
3. Finish: there is enough information to answer; produce the final answer.

Output ONLY a JSON object of the form:
  {"plan": ["next step", "..."], "final": ""}
If "final" is a non-empty string, the loop terminates and returns that text as the answer; "plan" is ignored.
If "final" is empty, the loop continues with "plan" as the new remaining steps. If "plan" is also empty, the loop terminates with no answer.
No prose, no markdown, no code fences.`;

function validateConfig(cfg: PlanExecuteConfig): void {
  const allRolesHaveProvider = cfg.plannerProvider && cfg.executorProvider && cfg.replannerProvider;
  if (!cfg.provider && !allRolesHaveProvider) {
    throw new Error("agent: PlanExecuteConfig.provider is required (or override every role)");
  }
  const allRolesHaveModel = cfg.plannerModel && cfg.executorModel && cfg.replannerModel;
  if (!cfg.model && !allRolesHaveModel) {
    throw new Error("agent: PlanExecuteConfig.model is required (or override every role)");
  }
}

const pick = <T>(override: T | undefined, base: T | undefined): T => (override ?? base) as T;

/**
 * Compile a Plan-and-Execute agent into a `Runnable<PlanExecuteState>`.
 *
 * @param cfg - Providers, models, tools and loop caps; see
 * {@link PlanExecuteConfig}.
 * @returns A runnable that plans, executes each step and replans until it
 * finishes or hits the iteration cap.
 * @throws Error when neither a shared provider/model nor a complete set of
 * per-role overrides is supplied.
 * @example
 * ```ts
 * const agent = newPlanAndExecute({ provider, model: "m" });
 * const final = await agent.invoke({ input: "do it", plan: [], past: [], final: "", iter: 0 });
 * console.log(final.final);
 * ```
 */
export function newPlanAndExecute(cfg: PlanExecuteConfig): Runnable<PlanExecuteState> {
  validateConfig(cfg);

  const maxIter = cfg.maxIterations && cfg.maxIterations > 0 ? cfg.maxIterations : 8;
  const maxStep = cfg.maxStepIterations && cfg.maxStepIterations > 0 ? cfg.maxStepIterations : 6;
  const plannerPrompt = cfg.plannerPrompt || DEFAULT_PLANNER_PROMPT;
  const replannerPrompt = cfg.replannerPrompt || DEFAULT_REPLANNER_PROMPT;

  const planNode: NodeFunc<PlanExecuteState> = async (s, ctx) => {
    if (s.input === "") throw new Error("agent: PlanExecuteState.input is empty");
    const resp = await pick(cfg.plannerProvider, cfg.provider).generate(
      {
        model: pick(cfg.plannerModel, cfg.model),
        messages: [systemMessage(plannerPrompt), userMessage(s.input)],
      },
      ctx,
    );
    let plan: string[];
    try {
      plan = parsePlan(messageText(resp.message));
    } catch (e) {
      throw new Error(`agent: planner output: ${(e as Error).message}`);
    }
    return { ...s, plan };
  };

  const executeNode: NodeFunc<PlanExecuteState> = async (s, ctx) => {
    if (s.plan.length === 0) throw new Error("agent: execute node reached with empty plan");
    const [step, ...rest] = s.plan;

    const reactCfg: ReActConfig = {
      provider: pick(cfg.executorProvider, cfg.provider),
      model: pick(cfg.executorModel, cfg.model),
      maxIterations: maxStep,
      ...(cfg.tools ? { tools: cfg.tools } : {}),
    };
    const sysPrompt =
      "You are executing one step of a larger plan. Use tools if helpful. Respond with the result of THIS step only; do not announce the next step.";
    let prompt = `Original request: ${s.input}`;
    if (s.past.length > 0) {
      prompt += "\n\nSteps already completed:\n";
      s.past.forEach((r, i) => {
        prompt += `  ${i + 1}. ${r.step} -> ${r.result}\n`;
      });
    }
    prompt += `\nCurrent step to execute: ${step}`;

    let out: string;
    try {
      out = await runReAct(reactCfg, prompt, { system: [sysPrompt], ...(ctx.signal ? { signal: ctx.signal } : {}) });
    } catch (e) {
      throw new Error(`agent: execute step ${step}: ${(e as Error).message}`);
    }
    return { ...s, plan: rest, past: [...s.past, { step: step!, result: out }] };
  };

  const replanNode: NodeFunc<PlanExecuteState> = async (s, ctx) => {
    const iter = s.iter + 1;
    const resp = await pick(cfg.replannerProvider, cfg.provider).generate(
      {
        model: pick(cfg.replannerModel, cfg.model),
        messages: [systemMessage(replannerPrompt), userMessage(buildReplannerPayload(s))],
      },
      ctx,
    );
    let parsed: { plan: string[]; final: string };
    try {
      parsed = parseReplan(messageText(resp.message));
    } catch (e) {
      throw new Error(`agent: replanner output: ${(e as Error).message}`);
    }
    if (parsed.final !== "") return { ...s, iter, final: parsed.final, plan: [] };
    return { ...s, iter, plan: parsed.plan };
  };

  const router: Router<PlanExecuteState> = (s) => {
    if (s.final !== "") return END;
    if (s.iter >= maxIter) return END;
    if (s.plan.length === 0) return END;
    return "execute";
  };

  const r = new Graph<PlanExecuteState>()
    .addNode("plan", planNode)
    .addNode("execute", executeNode)
    .addNode("replan", replanNode)
    .addEdge(START, "plan")
    .addEdge("plan", "execute")
    .addEdge("execute", "replan")
    .addConditionalEdge("replan", router)
    .compile();
  r.maxSteps = maxIter * 4 + 6;
  return r;
}

/**
 * One-shot wrapper around {@link newPlanAndExecute}: build a fresh runnable,
 * invoke it with the input and return the final answer.
 *
 * @param cfg - Providers, models, tools and loop caps; see
 * {@link PlanExecuteConfig}.
 * @param input - The user request to plan for and answer.
 * @param opts - Optional `AbortSignal` to cancel the run.
 * @returns The final answer text, or an empty string if the loop ended without
 * one.
 * @throws Error for invalid configuration or any failure surfaced by the
 * planner, executor or replanner.
 * @example
 * ```ts
 * const answer = await runPlanAndExecute({ provider, model: "m" }, "please do it");
 * ```
 */
export async function runPlanAndExecute(
  cfg: PlanExecuteConfig,
  input: string,
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  const r = newPlanAndExecute(cfg);
  const final = await r.invoke(
    { input, plan: [], past: [], final: "", iter: 0 },
    opts.signal ? { signal: opts.signal } : {},
  );
  return final.final;
}

// ── Parsing helpers (tolerant of prose / code fences LLMs add) ─────────────────

/**
 * Strip a surrounding Markdown code fence from a string.
 *
 * Removes a leading ```` ```json ```` (or plain ```` ``` ````) opener and its
 * matching trailing fence, tolerating the fenced JSON that models often wrap
 * their output in.
 *
 * @param s - The raw text, possibly wrapped in a code fence.
 * @returns The fence body, or the original string when no fence is present.
 */
export function stripFences(s: string): string {
  const t = s.trim();
  if (!t.startsWith("```")) return s;
  const nl = t.indexOf("\n");
  let body = nl >= 0 ? t.slice(nl + 1) : t.replace(/^```/, "");
  const i = body.lastIndexOf("```");
  if (i >= 0) body = body.slice(0, i);
  return body;
}

/**
 * Parse a planner response into an ordered list of step strings.
 *
 * Tolerant of surrounding prose and code fences: it strips fences, trims to the
 * outermost array brackets and parses the result.
 *
 * @param raw - The planner's raw text output.
 * @returns The plan as an array of step strings.
 * @throws Error when the response is empty or does not parse to a JSON array of
 * strings.
 */
export function parsePlan(raw: string): string[] {
  let body = stripFences(raw).trim();
  if (body === "") throw new Error("empty planner response");
  const i = body.indexOf("[");
  if (i > 0) body = body.slice(i);
  const j = body.lastIndexOf("]");
  if (j >= 0 && j < body.length - 1) body = body.slice(0, j + 1);
  let plan: unknown;
  try {
    plan = JSON.parse(body);
  } catch {
    throw new Error("not a JSON array of strings");
  }
  if (!Array.isArray(plan) || !plan.every((x) => typeof x === "string")) {
    throw new Error("not a JSON array of strings");
  }
  return plan as string[];
}

/**
 * Parse a replanner response into its `plan` and `final` fields.
 *
 * Tolerant of surrounding prose and code fences. Non-string plan entries are
 * dropped and a missing or non-string `final` becomes an empty string.
 *
 * @param raw - The replanner's raw text output.
 * @returns An object with the remaining `plan` steps and the `final` answer
 * (empty when the loop should continue).
 * @throws Error when the response is empty or does not parse to a JSON object.
 */
export function parseReplan(raw: string): { plan: string[]; final: string } {
  let body = stripFences(raw).trim();
  if (body === "") throw new Error("empty replanner response");
  const i = body.indexOf("{");
  if (i > 0) body = body.slice(i);
  const j = body.lastIndexOf("}");
  if (j >= 0 && j < body.length - 1) body = body.slice(0, j + 1);
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    throw new Error("not a JSON {plan,final} object");
  }
  if (typeof v !== "object" || v === null) throw new Error("not a JSON {plan,final} object");
  const obj = v as { plan?: unknown; final?: unknown };
  const plan = Array.isArray(obj.plan) ? obj.plan.filter((x): x is string => typeof x === "string") : [];
  const final = typeof obj.final === "string" ? obj.final : "";
  return { plan, final };
}

function buildReplannerPayload(s: PlanExecuteState): string {
  let b = `Original request:\n${s.input}\n\nSteps already completed:\n`;
  if (s.past.length === 0) b += "  (none)\n";
  else s.past.forEach((r, i) => (b += `  ${i + 1}. ${r.step} -> ${r.result}\n`));
  b += "\nRemaining plan:\n";
  if (s.plan.length === 0) b += "  (none)\n";
  else s.plan.forEach((step, i) => (b += `  ${i + 1}. ${step}\n`));
  return b;
}
