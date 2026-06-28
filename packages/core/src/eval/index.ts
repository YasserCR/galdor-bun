/**
 * core/eval — inline regression framework for prompts and agents.
 *
 * Declare a {@link Dataset}, a {@link Subject} and one or more {@link Scorer}s,
 * then call {@link run} to get a {@link Report}. This module is the public
 * entry point; it re-exports the data types, the built-in scorers, the dataset
 * loaders, and the runner.
 *
 * Built-in scorers:
 *   - {@link exactMatch}: actual === expected (after trimming)
 *   - {@link contains}:   expected substring appears in actual (case-insensitive)
 *   - {@link regex}:      actual matches a pattern
 *   - {@link llmJudge}:   another LLM rates actual against a rubric (0..1)
 *   - {@link scorerFunc}: an arbitrary user function
 *   - {@link named}:      rename any scorer to disambiguate collisions
 */

export {
  type Aggregate,
  type Case,
  type CaseResult,
  type Config,
  type Dataset,
  EvalError,
  Report,
  type Score,
  type Scorer,
  type Subject,
} from "./types.ts";

export {
  type ContainsOptions,
  contains,
  type ExactMatchOptions,
  exactMatch,
  type LLMJudgeOptions,
  llmJudge,
  named,
  parseJudgeScore,
  regex,
  scorerFunc,
} from "./scorers.ts";

export { loadDataset, saveDataset, validateDataset } from "./loader.ts";

export { run } from "./runner.ts";
