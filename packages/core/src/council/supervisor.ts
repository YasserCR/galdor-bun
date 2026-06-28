/**
 * core/council/supervisor — the routing-supervisor pattern.
 *
 * A router LLM picks one of the configured workers each hop, sees the worker's
 * answer the next hop, and finishes when the user's request is satisfied. Built
 * on the graph runtime:
 *
 *   START -> supervisor -> (worker_1 | worker_2 | ... | END)
 *   worker_n -> supervisor
 */

import { END, Graph, type Router, START, type Runnable } from "../graph/index.ts";
import type { Provider } from "../provider/index.ts";
import { messageText, systemMessage, userMessage } from "../schema/index.ts";
import { MaxHopsExceededError } from "./errors.ts";
import { isSafeWorkerName, stripFences } from "./shared.ts";

/**
 * The routable unit a {@link SupervisorConfig supervisor} dispatches to. A
 * worker is just a named async function, so anything — a ReAct runnable, a
 * deterministic helper, a nested supervisor, an external HTTP call — can be
 * wrapped behind this one interface.
 */
export interface Worker {
  /**
   * Uniquely identifies the worker within a Supervisor. Used as the graph-node
   * name and as the value the routing LLM emits to select this worker; must
   * match `[A-Za-z0-9_-]+`.
   */
  name: string;
  /** Shown to the routing LLM verbatim. Make it specific. */
  description: string;
  /**
   * Executes the worker with the task the supervisor decided to delegate; a
   * thrown error halts the supervisor's run.
   */
  run: (task: string, signal?: AbortSignal) => Promise<string>;
}

/** Configures the Supervisor loop. */
export interface SupervisorConfig {
  /** The routing LLM. Required. */
  provider: Provider;
  /** The routing model ID. Required. */
  model: string;
  /** The set of callable workers. Must be non-empty; names must be unique. */
  workers: Worker[];
  /** Caps supervisor → worker → supervisor cycles. Default 8. */
  maxHops?: number;
  /**
   * Overrides the built-in routing system prompt. A custom prompt must still
   * instruct the LLM to emit the same strict JSON shape
   * (`{"worker":"…","task":"…"}` or `{"final":"…"}`).
   */
  systemPrompt?: string;
}

/** One row of {@link SupervisorState.history}: a single worker dispatch and its result. */
export interface WorkerInvocation {
  /** Name of the worker that was dispatched. */
  worker: string;
  /** The task string the supervisor delegated. */
  task: string;
  /** The text the worker returned. */
  output: string;
}

/**
 * The state value that flows through the supervisor graph. Construct it with
 * `input` set; the runtime populates the remaining fields.
 */
export interface SupervisorState {
  /** The original user request. */
  input: string;
  /** Every supervisor → worker invocation in order. */
  history: WorkerInvocation[];
  /** When non-empty, terminates the loop and is returned as the answer. */
  final: string;
  /** How many times the supervisor LLM has been consulted. */
  hops: number;
  /** The worker selected for the next turn. Internal. */
  next: string;
  /** The task delegated alongside `next`. Internal. */
  nextTask: string;
}

/** Internal node the router diverts to when a run hits its hop cap. */
const SUPERVISOR_TRAP_NODE = "__supervisor_trap__";
const SUPERVISOR_NODE = "supervisor";

const DEFAULT_SUPERVISOR_PROMPT = `You are a routing supervisor coordinating specialized workers.

Each turn, decide one of:
1. Delegate to a worker: respond with {"worker": "name", "task": "what to do"}.
   The worker's answer will come back to you next turn.
2. Finish: respond with {"final": "your final answer to the user"}.

Pick the worker whose Description best matches the next step. Keep "task"
short and specific — the worker only sees that string, not the full history.
If the user's request is fully addressed, finish.

Respond with ONLY a JSON object. No prose, no markdown, no code fences.`;

/**
 * Compiles a {@link SupervisorConfig} into a `Runnable<SupervisorState>` that
 * implements the routing-supervisor pattern.
 *
 * @param cfg The supervisor configuration.
 * @returns A compiled runnable; invoke it with a {@link SupervisorState} whose
 *   `input` is set.
 * @throws Error when the config is invalid — missing provider/model, empty or
 *   duplicate workers, an unsafe or reserved worker name, or a worker without a
 *   `run` function.
 * @example
 * const run = newSupervisor({ provider, model: "...", workers: [math] });
 * const out = await run.invoke({ input: "2+3?", history: [], final: "", hops: 0, next: "", nextTask: "" });
 */
export function newSupervisor(cfg: SupervisorConfig): Runnable<SupervisorState> {
  if (!cfg.provider) throw new Error("council: SupervisorConfig.provider is required");
  if (cfg.model === "" || cfg.model === undefined) {
    throw new Error("council: SupervisorConfig.model is required");
  }
  if (!cfg.workers || cfg.workers.length === 0) {
    throw new Error("council: SupervisorConfig.workers must be non-empty");
  }

  const seen = new Set<string>();
  for (const w of cfg.workers) {
    if (w.name === "" || w.name === undefined) throw new Error("council: Worker.name is empty");
    if (!isSafeWorkerName(w.name)) {
      throw new Error(`council: Worker.name ${JSON.stringify(w.name)} must match [A-Za-z0-9_-]+`);
    }
    if (w.name === START || w.name === END || w.name === SUPERVISOR_NODE || w.name === SUPERVISOR_TRAP_NODE) {
      throw new Error(`council: Worker.name ${JSON.stringify(w.name)} is reserved`);
    }
    if (typeof w.run !== "function") throw new Error(`council: Worker ${JSON.stringify(w.name)} has nil run`);
    if (seen.has(w.name)) throw new Error(`council: duplicate Worker.name ${JSON.stringify(w.name)}`);
    seen.add(w.name);
  }

  const maxHops = cfg.maxHops && cfg.maxHops > 0 ? cfg.maxHops : 8;
  const sysPrompt = cfg.systemPrompt && cfg.systemPrompt !== "" ? cfg.systemPrompt : DEFAULT_SUPERVISOR_PROMPT;

  const supervisorNode = async (s: SupervisorState, ctx: { signal?: AbortSignal }): Promise<SupervisorState> => {
    const hops = s.hops + 1;
    const payload = buildSupervisorPayload(s, cfg.workers);
    const resp = await cfg.provider.generate(
      {
        model: cfg.model,
        messages: [systemMessage(sysPrompt), userMessage(payload)],
      },
      ctx,
    );
    const decision = parseSupervisorDecision(messageText(resp.message));
    if (decision.final !== "") {
      return { ...s, hops, final: decision.final, next: "", nextTask: "" };
    }
    if (!seen.has(decision.worker)) {
      throw new Error(`council: supervisor chose unknown worker ${JSON.stringify(decision.worker)}`);
    }
    return { ...s, hops, next: decision.worker, nextTask: decision.task };
  };

  const router: Router<SupervisorState> = (s) => {
    if (s.final !== "") return END;
    // Capped before producing a final answer; divert to the trap node so the
    // run fails loudly rather than returning a silent empty result.
    if (s.hops >= maxHops) return SUPERVISOR_TRAP_NODE;
    if (s.next === "") return END;
    return s.next;
  };

  let g = new Graph<SupervisorState>()
    .addNode(SUPERVISOR_NODE, supervisorNode)
    .addNode(SUPERVISOR_TRAP_NODE, (s) => {
      throw new MaxHopsExceededError(s.hops);
    })
    .addEdge(SUPERVISOR_TRAP_NODE, END)
    .addEdge(START, SUPERVISOR_NODE)
    .addConditionalEdge(SUPERVISOR_NODE, router);

  for (const w of cfg.workers) {
    g = g
      .addNode(w.name, async (s, ctx) => {
        let out: string;
        try {
          out = await w.run(s.nextTask, ctx.signal);
        } catch (e) {
          throw new Error(`council: worker ${JSON.stringify(w.name)}: ${e instanceof Error ? e.message : String(e)}`, {
            cause: e,
          });
        }
        const history = [...s.history, { worker: w.name, task: s.nextTask, output: out }];
        // Clear the next slot so a malformed decision next turn fails loudly
        // instead of silently re-routing to the same worker.
        return { ...s, history, next: "", nextTask: "" };
      })
      .addEdge(w.name, SUPERVISOR_NODE);
  }

  const r = g.compile();
  // Each hop is supervisor + worker + back-edge = 3 transitions.
  r.maxSteps = maxHops * 3 + 4;
  return r;
}

/**
 * One-shot convenience wrapper around {@link newSupervisor}: builds the runnable,
 * seeds the state from `input`, runs it, and returns the final answer.
 *
 * @param cfg The supervisor configuration.
 * @param input The user request to satisfy.
 * @param signal Optional abort signal forwarded to the provider and workers.
 * @returns The supervisor's final answer text.
 * @throws {@link MaxHopsExceededError} (wrapped in a NodeError) if the run is
 *   capped before finishing; also any error from {@link newSupervisor} or a worker.
 * @example
 * const answer = await runSupervisor(cfg, "What is 2 + 3?");
 */
export async function runSupervisor(cfg: SupervisorConfig, input: string, signal?: AbortSignal): Promise<string> {
  const r = newSupervisor(cfg);
  const initial: SupervisorState = { input, history: [], final: "", hops: 0, next: "", nextTask: "" };
  const final = await r.invoke(initial, signal ? { signal } : {});
  return final.final;
}

/** Parsed shape of the routing LLM's reply. */
interface SupervisorDecision {
  worker: string;
  task: string;
  final: string;
}

/**
 * Parses the routing LLM's reply into a {@link SupervisorDecision}. Tolerates
 * surrounding code fences and leading/trailing prose around the JSON object.
 *
 * @param raw The model's raw reply text.
 * @returns The parsed decision: a delegation (`worker`/`task`) or a `final` answer.
 * @throws Error when the reply is empty, is not parseable JSON, or is neither a
 *   delegation nor a final answer.
 */
export function parseSupervisorDecision(raw: string): SupervisorDecision {
  let body = stripFences(raw).trim();
  if (body === "") throw new Error("council: supervisor decision: empty supervisor response");
  const i = body.indexOf("{");
  if (i > 0) body = body.slice(i);
  const j = body.lastIndexOf("}");
  if (j >= 0 && j < body.length - 1) body = body.slice(0, j + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(
      `council: supervisor decision: not a JSON {worker,task,final} object: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const worker = typeof obj.worker === "string" ? obj.worker : "";
  const task = typeof obj.task === "string" ? obj.task : "";
  const final = typeof obj.final === "string" ? obj.final : "";
  if (final === "" && worker === "") {
    throw new Error("council: supervisor decision: response is neither a delegation nor a final answer");
  }
  return { worker, task, final };
}

function buildSupervisorPayload(s: SupervisorState, workers: Worker[]): string {
  const lines: string[] = ["Workers available:"];
  for (const w of workers) lines.push(`  - ${w.name}: ${w.description}`);
  lines.push("", "User request:", s.input, "", "Work completed so far:");
  if (s.history.length === 0) {
    lines.push("  (none)");
  } else {
    s.history.forEach((h, idx) => {
      lines.push(`  ${idx + 1}. [${h.worker}] task=${JSON.stringify(h.task)} -> ${h.output}`);
    });
  }
  // Trailing newline so the payload ends cleanly.
  return lines.join("\n") + "\n";
}
