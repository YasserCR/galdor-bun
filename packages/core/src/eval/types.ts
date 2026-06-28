/**
 * core/eval — inline regression framework for prompts and agents.
 *
 * Declare a {@link Dataset} (a list of input/expected {@link Case}s), a
 * {@link Subject} (the agent under test) and one or more {@link Scorer}s; then
 * {@link run} executes every case with bounded concurrency and produces a
 * {@link Report}.
 *
 * The core contracts:
 *  - A {@link Subject} is `(input, signal?) => Promise<string>` — cancellation is
 *    an explicit {@link AbortSignal}, and failures are thrown.
 *  - A {@link Scorer} exposes `score(c, actual, signal?): Promise<Score>` — it
 *    likewise throws on failure.
 *  - Built-in scorers are factory functions (`exactMatch()`, `llmJudge({...})`)
 *    that return a {@link Scorer}.
 */

/**
 * Case is one test point in a Dataset: an input fed to the Subject and
 * (optionally) an expected reference output used by Scorers.
 */
export interface Case {
  /** Uniquely identifies the case within a Dataset. Stable IDs make report
   * diffs across runs meaningful. */
  id: string;
  /** The string fed to the Subject. */
  input: string;
  /** Reference answer used by content-comparison scorers (exactMatch,
   * contains). Optional; LLM-judge scorers often work without it. */
  expected?: string;
  /** Free-form key/value data carried through the run (category, difficulty…). */
  metadata?: Record<string, string>;
}

/**
 * Dataset is a versioned collection of Cases. The version shows up in every
 * Report so a regression can be attributed to "model changed" vs. "dataset
 * changed".
 */
export interface Dataset {
  /** Human-readable name for the corpus; echoed into every {@link Report}. */
  name: string;
  /** Version tag bumped whenever the cases change; recorded in the Report. */
  version: string;
  /** The test points, each with a stable, unique {@link Case.id}. */
  cases: Case[];
}

/**
 * Subject is the system under evaluation: takes a single input string and
 * resolves to the agent's text answer (or rejects). Wrap a ReAct runnable, a
 * Supervisor, a Plan-and-Execute pipeline, or any other agent shape behind this
 * signature.
 */
export type Subject = (input: string, signal?: AbortSignal) => Promise<string>;

/**
 * Score is the result of one Scorer applied to one Case + actual output.
 * `value` is normalized to [0, 1]; `pass` is the discrete verdict (typically
 * `value >= scorer-specific threshold`).
 */
export interface Score {
  /** Normalized rating in [0, 1]. */
  value: number;
  /** Discrete verdict — typically `value >= threshold`. */
  pass: boolean;
  /** Short human-readable rationale (may be empty on a clean pass). */
  explanation: string;
}

/**
 * Scorer rates an agent's output against the case's expected value (and
 * possibly other criteria the Scorer carries internally).
 *
 * `name()` uniquely identifies the scorer in a Report's aggregates so multiple
 * instances of the same type (e.g. two llmJudge scorers with different rubrics)
 * can coexist — wrap one with {@link named} to disambiguate.
 */
export interface Scorer {
  /** Unique key for this scorer in a {@link Report}'s aggregates. */
  name(): string;
  /**
   * Rate `actual` for the given case.
   * @param c - The case being evaluated (carries `input`/`expected`).
   * @param actual - The Subject's output for this case.
   * @param signal - Optional cancellation signal.
   * @returns The {@link Score}.
   * @throws If the scorer cannot evaluate (e.g. misconfiguration).
   */
  score(c: Case, actual: string, signal?: AbortSignal): Promise<Score>;
}

/** CaseResult is the per-case slice of a {@link Report}. */
export interface CaseResult {
  /** The case that was evaluated. */
  case: Case;
  /** The Subject's output. Empty when the case errored. */
  actual: string;
  /** Non-empty when the Subject errored (or the run was cancelled). */
  err: string;
  /** Per-scorer scores, keyed by scorer name. */
  scores: Record<string, Score>;
  /** True when every scorer passed. */
  pass: boolean;
  durationMs: number;
}

/** Aggregate summarizes one scorer's results across all cases. */
export interface Aggregate {
  /** The scorer name these totals belong to. */
  scorer: string;
  /** Mean {@link Score.value} across all scored cases. */
  mean: number;
  /** Number of cases this scorer passed. */
  pass: number;
  /** Number of cases this scorer failed. */
  fail: number;
}

/**
 * Config bundles everything {@link run} needs.
 */
export interface Config {
  /** The test corpus. Required. */
  dataset: Dataset;
  /** The system under test. Required. */
  subject: Subject;
  /** Rate the Subject's output on each case. Must be non-empty; a case passes
   * when EVERY scorer's `pass` is true. */
  scorers: Scorer[];
  /** Caps the number of cases evaluated concurrently. Default 4. Set to 1 for
   * fully sequential execution. */
  parallel?: number;
  /** Pass-rate threshold in [0,1] for CI gates. Carried for callers (compare
   * against {@link Report.meets}); `run` itself does not enforce it. */
  minPass?: number;
  /** When > 0, derives a per-case deadline. A timeout counts as an error (not a
   * fail) so it can be diagnosed separately. */
  timeoutPerCaseMs?: number;
}

/**
 * Report is the output of a {@link run}: per-case results, per-scorer
 * aggregates, and roll-up counters. The plain data fields serialize directly to
 * JSON; {@link Report.passRate} and {@link Report.meets} are convenience helpers
 * layered on top.
 */
export class Report {
  dataset: string;
  version: string;
  startedAt: Date;
  durationMs = 0;
  cases: CaseResult[] = [];
  aggregates: Record<string, Aggregate> = {};
  passed = 0;
  failed = 0;
  errored = 0;

  /**
   * @param dataset - The dataset name being reported on.
   * @param version - The dataset version.
   * @param startedAt - When the run began.
   */
  constructor(dataset: string, version: string, startedAt: Date) {
    this.dataset = dataset;
    this.version = version;
    this.startedAt = startedAt;
  }

  /** Fraction of cases that passed every scorer, in [0, 1]. Errored cases count
   * as failures. */
  passRate(): number {
    const total = this.cases.length;
    if (total === 0) return 0;
    return this.passed / total;
  }

  /** Whether `passRate()` is >= minPass. Convenience for CI gates. */
  meets(minPass: number): boolean {
    return this.passRate() >= minPass;
  }
}

/** Thrown by {@link run} for setup errors (empty dataset, duplicate scorer
 * names, …) and by {@link llmJudge} when misconfigured. */
export class EvalError extends Error {
  override name = "EvalError";
}
