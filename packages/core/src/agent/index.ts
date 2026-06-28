/**
 * High-level agent helpers built on the graph runtime.
 *
 * This module exposes two strategies for driving a language model through a
 * task: {@link newReAct}, a reason-and-act loop that interleaves model turns
 * with tool execution, and {@link newPlanAndExecute}, which first drafts a plan
 * and then works through it step by step. Both compile to a `Runnable` over the
 * graph runtime, so streaming, checkpointing and human-in-the-loop resume all
 * work through the same interface.
 *
 * @example
 * ```ts
 * import { run } from "./index.ts";
 *
 * const answer = await run({ provider, model: "m" }, "capital of Ecuador?");
 * ```
 */

export {
  type Config,
  MaxIterationsError,
  newReAct,
  run,
  seedState,
  type State,
} from "./react.ts";
export {
  newPlanAndExecute,
  parsePlan,
  parseReplan,
  type PlanExecuteConfig,
  type PlanExecuteState,
  runPlanAndExecute,
  type StepRecord,
  stripFences,
} from "./planexecute.ts";
