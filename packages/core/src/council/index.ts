/**
 * core/council — multi-agent coordination patterns.
 *
 * Two runtimes, both compiled onto the graph runtime so streaming,
 * checkpointing and observability integrate the same way:
 *   - supervisor — a router LLM dispatches to one of N workers each hop.
 *   - swarm      — peer agents collaborate over a shared log and hand off
 *                  control via synthetic `handoff_to_<name>` tools.
 *
 * @example
 * import { runSupervisor } from "./council/index.ts";
 *
 * const answer = await runSupervisor(
 *   { provider, model: "...", workers: [research, write] },
 *   "Draft a short report on X.",
 * );
 */

export { MaxHopsExceededError, UnknownHandoffTargetError } from "./errors.ts";
export {
  newSupervisor,
  parseSupervisorDecision,
  runSupervisor,
  type SupervisorConfig,
  type SupervisorState,
  type Worker,
  type WorkerInvocation,
} from "./supervisor.ts";
export {
  makeSwarmRouter,
  makeSwarmTrap,
  newSwarm,
  runSwarm,
  type SwarmAgent,
  type SwarmConfig,
  type SwarmState,
} from "./swarm.ts";
