/**
 * core/council/swarm — the swarm pattern.
 *
 * Peer agents collaborate over a shared message log; any agent can transfer
 * control to another by calling a synthetic `handoff_to_<name>` tool the
 * framework intercepts. The graph has one node per agent. Each agent node runs
 * a bounded inner ReAct loop: model → tools → model → … until either the model
 * produces a final assistant text (terminate) or calls a handoff tool (route to
 * the named peer).
 */

import { END, Graph, type NodeFunc, type Router, START, type Runnable } from "../graph/index.ts";
import type { Provider, Request } from "../provider/index.ts";
import {
  type JSONValue,
  type Message,
  messageText,
  Role,
  systemMessage,
  type ToolCall,
  type ToolDef,
  toolResultMessage,
} from "../schema/index.ts";
import { asToolResultMessages, executeCalls, type Registry } from "../tool/index.ts";
import { MaxHopsExceededError, UnknownHandoffTargetError } from "./errors.ts";
import { isSafeWorkerName } from "./shared.ts";

/**
 * One peer in a {@link SwarmConfig swarm}. Each agent has its own provider/model,
 * its own domain tools, and a list of other agents it may hand off to. Handoffs
 * surface to the LLM as synthetic tools named `handoff_to_<name>`.
 */
export interface SwarmAgent {
  /** Uniquely identifies the agent within a Swarm. Must match `[A-Za-z0-9_-]+`. */
  name: string;
  /**
   * Appended to the agent's system prompt for the other agents to see. Keep it
   * specific so the routing LLM picks the right peer.
   */
  description: string;
  /** The LLM serving this agent. Required. */
  provider: Provider;
  /** The model ID. Required. */
  model: string;
  /** The agent's domain registry. Omit for only the synthetic handoff tools. */
  tools?: Registry;
  /**
   * Names of other Swarm agents this one may transfer control to. The framework
   * injects a handoff tool for each. Empty means the agent cannot hand off — its
   * final answer terminates the swarm.
   */
  handoffs: string[];
  /**
   * Overrides the built-in agent system prompt. The framework still appends a
   * description of available handoff tools to whatever you provide.
   */
  systemPrompt?: string;
  /** Bounds the inner model↔tools loop on each activation. Default 6. */
  maxIterations?: number;
}

/** Configures the swarm runtime. */
export interface SwarmConfig {
  /** The peer agents that make up the swarm. Must be non-empty with unique names. */
  agents: SwarmAgent[];
  /** Names the agent that handles the user's first message. Must match an agent. */
  start: string;
  /** Caps control transfers between agents (incl. the initial activation). Default 8. */
  maxHops?: number;
}

/** The state value that flows through the swarm graph. */
export interface SwarmState {
  /** The shared conversation across all agents. */
  messages: Message[];
  /** The agent currently holding the conversation; updated on handoff. */
  active: string;
  /** Counts handoffs (including the initial activation). */
  hops: number;
  /** Set when an agent terminates the conversation with a non-tool-call answer. */
  final: string;
}

/** Synthetic-tool-name prefix that marks a handoff. */
const HANDOFF_PREFIX = "handoff_to_";
/** Internal node the router diverts to when a run must terminate with an error. */
const SWARM_TRAP_NODE = "__swarm_trap__";

function handoffToolName(target: string): string {
  return HANDOFF_PREFIX + target;
}

/**
 * Compiles a {@link SwarmConfig} into a `Runnable<SwarmState>` that implements
 * the swarm pattern.
 *
 * @param cfg The swarm configuration.
 * @returns A compiled runnable; invoke it with a seeded {@link SwarmState}.
 * @throws Error when the config is invalid — empty agents, an unsafe/reserved or
 *   duplicate agent name, a missing provider/model, an unknown or self-referential
 *   handoff target, an unset `start`, or a domain tool whose name collides with
 *   the reserved `handoff_to_` prefix.
 * @example
 * const run = newSwarm({ agents: [researcher, writer], start: "researcher" });
 */
export function newSwarm(cfg: SwarmConfig): Runnable<SwarmState> {
  if (!cfg.agents || cfg.agents.length === 0) {
    throw new Error("council: SwarmConfig.agents must be non-empty");
  }
  const byName = new Map<string, SwarmAgent>();
  for (const a of cfg.agents) {
    if (!a) throw new Error("council: SwarmConfig.agents contains nil");
    if (!isSafeWorkerName(a.name)) {
      throw new Error(`council: SwarmAgent.name ${JSON.stringify(a.name)} must match [A-Za-z0-9_-]+`);
    }
    if (a.name === START || a.name === END || a.name === SWARM_TRAP_NODE) {
      throw new Error(`council: SwarmAgent.name ${JSON.stringify(a.name)} is reserved`);
    }
    if (!a.provider) throw new Error(`council: SwarmAgent ${JSON.stringify(a.name)} has nil provider`);
    if (a.model === "" || a.model === undefined) {
      throw new Error(`council: SwarmAgent ${JSON.stringify(a.name)} has empty model`);
    }
    if (byName.has(a.name)) throw new Error(`council: duplicate SwarmAgent.name ${JSON.stringify(a.name)}`);
    // A domain tool whose name starts with the handoff prefix would be hijacked
    // by detectHandoff and never reach the registry — reject it up front.
    if (a.tools) {
      for (const t of a.tools.tools()) {
        if (t.name().startsWith(HANDOFF_PREFIX)) {
          throw new Error(
            `council: agent ${JSON.stringify(a.name)} domain tool ${JSON.stringify(t.name())} collides with reserved handoff prefix ${JSON.stringify(HANDOFF_PREFIX)}`,
          );
        }
      }
    }
    byName.set(a.name, a);
  }
  if (cfg.start === "" || cfg.start === undefined) {
    throw new Error("council: SwarmConfig.start is required");
  }
  if (!byName.has(cfg.start)) {
    throw new Error(`council: SwarmConfig.start ${JSON.stringify(cfg.start)} is not a registered agent`);
  }
  for (const a of cfg.agents) {
    for (const target of a.handoffs ?? []) {
      if (!byName.has(target)) {
        throw new Error(`council: agent ${JSON.stringify(a.name)} lists unknown handoff target ${JSON.stringify(target)}`);
      }
      if (target === a.name) {
        throw new Error(`council: agent ${JSON.stringify(a.name)} cannot hand off to itself`);
      }
    }
  }

  const maxHops = cfg.maxHops && cfg.maxHops > 0 ? cfg.maxHops : 8;

  let g = new Graph<SwarmState>();
  for (const a of cfg.agents) {
    g = g.addNode(a.name, makeSwarmAgentNode(a, byName));
    g = g.addConditionalEdge(a.name, makeSwarmRouter(maxHops, byName));
  }
  g = g.addNode(SWARM_TRAP_NODE, makeSwarmTrap(byName));
  g = g.addEdge(SWARM_TRAP_NODE, END);
  g = g.addEdge(START, cfg.start);

  const r = g.compile();
  // Each handoff is one node transition; pad generously since the router's
  // terminal hop also counts.
  r.maxSteps = maxHops * 4 + 4;
  return r;
}

/**
 * One-shot convenience wrapper around {@link newSwarm}: seeds the conversation
 * with the user message, runs the swarm, and returns the final text.
 *
 * @param cfg The swarm configuration.
 * @param input The user's first message.
 * @param signal Optional abort signal forwarded to each agent's provider.
 * @returns The terminating agent's final answer text.
 * @throws {@link MaxHopsExceededError} or {@link UnknownHandoffTargetError}
 *   (wrapped in a NodeError) on a capped or misrouted run; also any error from
 *   {@link newSwarm} or an agent.
 * @example
 * const answer = await runSwarm(cfg, "Research and summarize X.");
 */
export async function runSwarm(cfg: SwarmConfig, input: string, signal?: AbortSignal): Promise<string> {
  const r = newSwarm(cfg);
  const initial: SwarmState = {
    messages: [{ role: Role.User, content: [{ type: "text", text: input }] }],
    active: cfg.start,
    hops: 0,
    final: "",
  };
  const final = await r.invoke(initial, signal ? { signal } : {});
  return final.final;
}

/**
 * Builds the conditional-edge router for an agent node. It directs control to
 * END once a final answer exists or no agent is active, to the trap node when
 * the active name is unknown or the hop cap is reached, and otherwise to the
 * currently active agent.
 *
 * @param maxHops The hop cap shared by the swarm.
 * @param byName Lookup of registered agents by name.
 * @returns A {@link Router} over {@link SwarmState}.
 */
export function makeSwarmRouter(maxHops: number, byName: Map<string, SwarmAgent>): Router<SwarmState> {
  return (s) => {
    if (s.final !== "") return END;
    // No active agent and no final: nothing left to do.
    if (s.active === "") return END;
    // A handoff named an agent that does not exist; surface it rather than
    // terminating silently.
    if (!byName.has(s.active)) return SWARM_TRAP_NODE;
    // Capped before reaching a final answer; surface it.
    if (s.hops >= maxHops) return SWARM_TRAP_NODE;
    return s.active;
  };
}

/**
 * Builds the trap node. The router sends control here when a run would otherwise
 * terminate without a final answer, so the failure is raised loudly instead of
 * returning a silent empty result.
 *
 * @param byName Lookup of registered agents by name.
 * @returns A {@link NodeFunc} that always throws.
 * @throws {@link UnknownHandoffTargetError} when `active` names an unregistered
 *   agent; otherwise {@link MaxHopsExceededError}.
 */
export function makeSwarmTrap(byName: Map<string, SwarmAgent>): NodeFunc<SwarmState> {
  return (s) => {
    if (s.active !== "" && !byName.has(s.active)) {
      throw new UnknownHandoffTargetError(s.active);
    }
    throw new MaxHopsExceededError(s.hops);
  };
}

/**
 * Produces the NodeFunc that runs one activation of an agent — an inner ReAct
 * loop that terminates on either a final assistant text or a handoff tool call.
 */
function makeSwarmAgentNode(a: SwarmAgent, byName: Map<string, SwarmAgent>): NodeFunc<SwarmState> {
  const maxIter = a.maxIterations && a.maxIterations > 0 ? a.maxIterations : 6;
  // The set of handoff targets THIS agent declared. Only these edges may
  // transfer control; a handoff_to_<x> naming a target outside this set is not a
  // real handoff and is acknowledged as an ordinary tool error.
  const allowed = new Set(a.handoffs ?? []);

  return async (s, ctx) => {
    const hops = s.hops + 1;
    const toolDefs = buildSwarmToolDefs(a);
    const sys = buildSwarmSystemPrompt(a, byName);
    // Shared log (returned to the runtime) and the request-message list (carries
    // the system prompt) accumulate the same turns in lockstep.
    const sharedMessages = [...s.messages];
    const reqMsgs = buildSwarmMessages(sys, s.messages);

    for (let i = 0; i < maxIter; i++) {
      const req: Request = { model: a.model, messages: reqMsgs, tools: toolDefs };
      if (toolDefs.length > 0) req.toolChoice = "auto";
      const resp = await a.provider.generate(req, ctx);
      sharedMessages.push(resp.message);
      reqMsgs.push(resp.message);

      const calls = resp.message.toolCalls ?? [];
      if (calls.length === 0) {
        // Final answer — terminate the swarm.
        return { ...s, messages: sharedMessages, hops, final: messageText(resp.message), active: "" };
      }

      // A declared handoff short-circuits the remaining tool calls: control goes
      // to the target agent on the next graph hop with the conversation intact.
      const handoff = detectHandoff(calls, allowed);
      if (handoff) {
        const results = acknowledgeHandoff(calls, handoff.target, handoff.task);
        return { ...s, messages: [...sharedMessages, ...results], hops, active: handoff.target };
      }

      // Domain (and undeclared-handoff) tool calls — execute the real ones and
      // synthesize error results for any handoff_to_<x> the agent may not use.
      const { realCalls, rejected } = partitionHandoffCalls(calls);
      if (realCalls.length > 0 && !a.tools) {
        throw new Error(`council: agent ${JSON.stringify(a.name)} produced tool calls but has nil tools`);
      }
      let resMsgs: Message[] = [];
      if (realCalls.length > 0) {
        const toolResults = await executeCalls(a.tools as Registry, realCalls, ctx);
        resMsgs = asToolResultMessages(toolResults);
      }
      resMsgs = [...resMsgs, ...rejected];
      sharedMessages.push(...resMsgs);
      reqMsgs.push(...resMsgs);
    }

    // Inner loop bailed without converging: terminal failure for THIS
    // activation, but leave final empty so the caller can inspect messages.
    throw new Error(`council: agent ${JSON.stringify(a.name)} exhausted maxIterations (${maxIter})`);
  };
}

function buildSwarmToolDefs(a: SwarmAgent): ToolDef[] {
  const defs: ToolDef[] = [];
  if (a.tools) defs.push(...a.tools.toolDefs());
  for (const target of a.handoffs ?? []) {
    defs.push({
      name: handoffToolName(target),
      description: `Hand off control of the conversation to agent ${target}. Use when ${target} is better suited to the next step.`,
      schema: handoffSchema(),
    });
  }
  return defs;
}

function handoffSchema(): JSONValue {
  return {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Optional brief description of what the receiving agent should do next.",
      },
    },
    additionalProperties: false,
  };
}

function buildSwarmSystemPrompt(a: SwarmAgent, byName: Map<string, SwarmAgent>): string {
  let body = a.systemPrompt && a.systemPrompt !== ""
    ? a.systemPrompt
    : `You are agent ${a.name} — ${a.description}.\nCollaborate with the other agents in the swarm. Use the available tools when helpful.`;
  const handoffs = a.handoffs ?? [];
  if (handoffs.length === 0) return body;
  body += "\n\nYou may hand off to:";
  for (const target of handoffs) {
    const peer = byName.get(target);
    body += "\n  - " + target;
    if (peer && peer.description !== "") body += ": " + peer.description;
  }
  body +=
    "\n\nTo hand off, call the corresponding handoff_to_<name> tool. Once you hand off you cannot speak again until you are handed back to.";
  return body;
}

/**
 * Prepends/replaces the system message before forwarding the shared
 * conversation to the active agent. Earlier agents' system prompts are filtered
 * out so the new agent sees only its own instructions.
 */
function buildSwarmMessages(systemPrompt: string, shared: Message[]): Message[] {
  const out: Message[] = [systemMessage(systemPrompt)];
  for (const m of shared) {
    if (m.role === Role.System) continue;
    out.push(m);
  }
  return out;
}

interface Handoff {
  target: string;
  task: string;
}

/**
 * Returns the first DECLARED handoff in `calls`. A handoff_to_<x> whose target
 * is not in `allowed` is not a real handoff — it is left for
 * partitionHandoffCalls to reject — so only a permitted edge transfers control.
 */
function detectHandoff(calls: ToolCall[], allowed: Set<string>): Handoff | undefined {
  for (const c of calls) {
    const target = handoffTargetOf(c.name);
    if (target !== undefined && allowed.has(target)) {
      return { target, task: extractHandoffTask(c.arguments) };
    }
  }
  return undefined;
}

/** Reports the target agent a handoff tool names, or undefined if not a handoff. */
function handoffTargetOf(name: string): string | undefined {
  if (name.length > HANDOFF_PREFIX.length && name.startsWith(HANDOFF_PREFIX)) {
    return name.slice(HANDOFF_PREFIX.length);
  }
  return undefined;
}

/**
 * Splits a turn's tool calls into the ones to execute against the domain
 * registry (realCalls) and error tool-results for any undeclared
 * handoff_to_<x>. Permitted handoffs are intercepted earlier by detectHandoff
 * and never reach here.
 */
function partitionHandoffCalls(calls: ToolCall[]): { realCalls: ToolCall[]; rejected: Message[] } {
  const realCalls: ToolCall[] = [];
  const rejected: Message[] = [];
  for (const c of calls) {
    const target = handoffTargetOf(c.name);
    if (target !== undefined) {
      rejected.push(toolResultMessage(c.id, `Error: you are not permitted to hand off to ${JSON.stringify(target)}.`));
      continue;
    }
    realCalls.push(c);
  }
  return { realCalls, rejected };
}

function extractHandoffTask(args: JSONValue): string {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const t = (args as Record<string, JSONValue>).task;
    if (typeof t === "string") return t;
  }
  return "";
}

/**
 * Produces tool-result messages for every tool call in the same turn as the
 * handoff. The handoff's result includes the target name so the next agent sees
 * an explicit transition marker in its history.
 */
function acknowledgeHandoff(calls: ToolCall[], target: string, task: string): Message[] {
  return calls.map((c) => {
    let body: string;
    if (c.name === handoffToolName(target)) {
      body = `Control handed off to ${target}.`;
      if (task !== "") body += " Task: " + task;
    } else {
      // Sibling tool calls in the same turn as a handoff are dropped — the
      // receiving agent decides what to do next. We still acknowledge them so
      // the conversation history is well-formed.
      body = `Tool ${JSON.stringify(c.name)} skipped because control was handed off to ${target} in the same turn.`;
    }
    return toolResultMessage(c.id, body);
  });
}
