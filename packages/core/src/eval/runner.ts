/**
 * core/eval — the runner.
 *
 * Drives a {@link Dataset} through its {@link Subject} under a bounded-concurrency
 * worker pool, applies each {@link Scorer}, and tallies the results into a
 * {@link Report}.
 */

import {
  type Aggregate,
  type Case,
  type CaseResult,
  type Config,
  EvalError,
  Report,
  type Score,
  type Scorer,
} from "./types.ts";

/**
 * Executes the dataset against the Subject and resolves to a {@link Report}.
 *
 * Cases run concurrently up to `cfg.parallel` (default 4); scorers are applied
 * sequentially per case. A case passes when EVERY scorer's `pass` is true. The
 * Report's `cases` are sorted by case id so reports diff cleanly across runs.
 *
 * @param cfg - The dataset, subject, scorers, and run options.
 * @param signal - Optional cancellation signal. A pre-cancelled (or
 * cancelled-mid-flight) signal records the affected cases as errored — never as
 * passes.
 * @returns The completed {@link Report}.
 * @throws {EvalError} On invalid config: missing subject, empty scorers, empty
 * dataset, or duplicate scorer names.
 * @example
 * ```ts
 * const report = await run({
 *   dataset: { name: "smoke", version: "1", cases: [{ id: "a", input: "hi", expected: "hi" }] },
 *   subject: async (input) => input,
 *   scorers: [exactMatch()],
 * });
 * console.log(report.passRate());
 * ```
 */
export async function run(cfg: Config, signal?: AbortSignal): Promise<Report> {
  if (typeof cfg.subject !== "function") {
    throw new EvalError("eval: Config.subject is nil");
  }
  if (!cfg.scorers || cfg.scorers.length === 0) {
    throw new EvalError("eval: Config.scorers must be non-empty");
  }
  if (!cfg.dataset || !cfg.dataset.cases || cfg.dataset.cases.length === 0) {
    throw new EvalError("eval: Dataset.cases is empty");
  }
  // Scorer names key the per-case and aggregate maps; duplicates would silently
  // overwrite each other and corrupt the report.
  const seenNames = new Set<string>();
  for (const s of cfg.scorers) {
    const name = s.name();
    if (seenNames.has(name)) {
      throw new EvalError(
        `eval: duplicate scorer name ${JSON.stringify(name)} (wrap one with named() to disambiguate)`,
      );
    }
    seenNames.add(name);
  }

  let parallel = cfg.parallel ?? 0;
  if (parallel <= 0) parallel = 4;

  const startedAt = new Date();
  const startMs = performance.now();
  const report = new Report(cfg.dataset.name, cfg.dataset.version, startedAt);
  const cases = cfg.dataset.cases;
  const results: CaseResult[] = new Array(cases.length);

  // Bounded-concurrency worker pool: each worker pulls the next index and writes
  // its result back at the same index. Ordering is preserved without extra
  // synchronization (the final sort is by case id).
  let next = 0;
  const workerCount = Math.min(parallel, cases.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        for (;;) {
          const idx = next++;
          if (idx >= cases.length) break;
          results[idx] = await evalOne(cfg, cases[idx]!, signal);
        }
      })(),
    );
  }
  await Promise.all(workers);

  report.cases = results;
  report.durationMs = performance.now() - startMs;
  tallyReport(report, cfg.scorers);
  return report;
}

async function evalOne(cfg: Config, c: Case, parentSignal?: AbortSignal): Promise<CaseResult> {
  const start = performance.now();

  // Derive a per-case signal: parent ∪ per-case timeout.
  const signal = deriveSignal(parentSignal, cfg.timeoutPerCaseMs);

  const result: CaseResult = {
    case: c,
    actual: "",
    err: "",
    scores: {},
    pass: false,
    durationMs: 0,
  };

  // Honor cancellation before doing any work so a cancelled run stops promptly
  // and never falsely reports a pass.
  if (signal?.aborted) {
    result.err = "context: " + abortMessage(signal);
    result.durationMs = performance.now() - start;
    return result;
  }

  let actual: string;
  try {
    actual = await cfg.subject(c.input, signal);
  } catch (e) {
    // Any thrown error is recorded as Errored; the rest of the batch still
    // runs. Scorers do not run for an errored case.
    result.err = errString(e);
    result.durationMs = performance.now() - start;
    return result;
  }

  result.actual = actual;
  let pass = true;
  for (const s of cfg.scorers) {
    let sc: Score;
    try {
      sc = await s.score(c, actual, signal);
    } catch (e) {
      // Scorer errors degrade to "fail" with the error in the explanation so
      // the report stays well-formed.
      sc = { value: 0, pass: false, explanation: "scorer error: " + errString(e) };
    }
    result.scores[s.name()] = sc;
    if (!sc.pass) pass = false;
  }
  result.pass = pass;
  result.durationMs = performance.now() - start;
  return result;
}

/** Combine the parent signal with a per-case timeout (either may be absent). */
function deriveSignal(parent: AbortSignal | undefined, timeoutMs?: number): AbortSignal | undefined {
  const timeout = timeoutMs && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (parent && timeout) return AbortSignal.any([parent, timeout]);
  return parent ?? timeout;
}

function abortMessage(signal: AbortSignal): string {
  const r = signal.reason;
  if (r instanceof Error) return r.message;
  if (r === undefined) return "aborted";
  return String(r);
}

function errString(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Fill passed/failed/errored counters plus per-scorer aggregates, then sort
 * the cases by id for stable report diffs. */
function tallyReport(r: Report, scorers: Scorer[]): void {
  interface Acc {
    sum: number;
    pass: number;
    fail: number;
    n: number;
  }
  const totals = new Map<string, Acc>();
  for (const sc of scorers) {
    totals.set(sc.name(), { sum: 0, pass: 0, fail: 0, n: 0 });
  }

  for (const cr of r.cases) {
    if (cr.err !== "") {
      r.errored++;
    } else if (cr.pass) {
      r.passed++;
    } else {
      r.failed++;
    }
    for (const [name, sc] of Object.entries(cr.scores)) {
      const a = totals.get(name);
      if (!a) continue;
      a.sum += sc.value;
      a.n++;
      if (sc.pass) a.pass++;
      else a.fail++;
    }
  }

  // Deterministic order for the aggregate keys is scorer registration order.
  const aggregates: Record<string, Aggregate> = {};
  for (const sc of scorers) {
    const name = sc.name();
    const a = totals.get(name)!;
    aggregates[name] = {
      scorer: name,
      mean: a.n > 0 ? a.sum / a.n : 0,
      pass: a.pass,
      fail: a.fail,
    };
  }
  r.aggregates = aggregates;

  // Stable sort by case id so reports diff cleanly even when workers finish out
  // of order (Array.prototype.sort is stable in ES2019+).
  r.cases.sort((x, y) => (x.case.id < y.case.id ? -1 : x.case.id > y.case.id ? 1 : 0));
}
