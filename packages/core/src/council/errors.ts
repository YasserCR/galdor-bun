/**
 * core/council/errors — typed errors surfaced by the council runtimes.
 *
 * Both errors are thrown from a graph trap node, so the runtime delivers them
 * wrapped in a {@link NodeError}; inspect its `.cause` to recover the original.
 * Discriminate between them with `instanceof`.
 */

/**
 * Thrown when a supervisor or swarm run reaches its hop cap without producing a
 * final answer. Lets callers distinguish a truncated runaway loop from a
 * genuine empty result. Shared by both runtimes.
 *
 * @example
 * try {
 *   await runSupervisor(cfg, "do the thing");
 * } catch (e) {
 *   if (e instanceof MaxHopsExceededError) console.log(e.hops);
 * }
 */
export class MaxHopsExceededError extends Error {
  override name = "MaxHopsExceededError";
  /** The number of hops that had been taken when the cap was reached. */
  readonly hops: number;
  /** @param hops The hop count at which the run was halted. */
  constructor(hops: number) {
    super(`council: max hops exceeded without a final answer (hops=${hops})`);
    this.hops = hops;
  }
}

/**
 * Thrown when control would transfer to an agent that is not registered in the
 * swarm. Surfaces a misfired handoff instead of terminating silently with an
 * empty result.
 */
export class UnknownHandoffTargetError extends Error {
  override name = "UnknownHandoffTargetError";
  /** The name of the agent the handoff attempted to reach. */
  readonly target: string;
  /** @param target The unregistered agent name that was requested. */
  constructor(target: string) {
    super(`council: handoff to unknown agent: ${JSON.stringify(target)}`);
    this.target = target;
  }
}
