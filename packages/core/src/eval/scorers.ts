/**
 * core/eval — built-in scorers.
 *
 * Factory functions that return a {@link Scorer}: deterministic content checks
 * ({@link exactMatch}, {@link contains}, {@link regex}), an LLM-as-judge scorer
 * ({@link llmJudge}), and adapters ({@link scorerFunc}, {@link named}).
 */

import { type Provider } from "../provider/index.ts";
import { messageText, systemMessage, userMessage } from "../schema/index.ts";
import { type Case, EvalError, type Score, type Scorer } from "./types.ts";

// ── exactMatch ────────────────────────────────────────────────────────────────

/** Options for {@link exactMatch}. */
export interface ExactMatchOptions {
  /** When false (the default), folds both sides to lowercase before comparing. */
  caseSensitive?: boolean;
}

/**
 * Builds a scorer that passes (value 1.0) when `actual.trim()` equals
 * `case.expected.trim()`, and fails (0.0) otherwise. An empty `expected` never
 * passes. Useful for deterministic tasks (formatting, classification) with a
 * single correct answer.
 *
 * @param opts - Comparison options; see {@link ExactMatchOptions}.
 * @returns A {@link Scorer} named `"exact_match"`.
 */
export function exactMatch(opts: ExactMatchOptions = {}): Scorer {
  const caseSensitive = opts.caseSensitive ?? false;
  return {
    name: () => "exact_match",
    score(c: Case, actual: string): Promise<Score> {
      let a = actual.trim();
      let b = (c.expected ?? "").trim();
      if (!caseSensitive) {
        a = a.toLowerCase();
        b = b.toLowerCase();
      }
      if (b === "") {
        return Promise.resolve({ value: 0, pass: false, explanation: "Case.expected is empty" });
      }
      if (a === b) return Promise.resolve({ value: 1, pass: true, explanation: "" });
      return Promise.resolve({ value: 0, pass: false, explanation: "actual != expected" });
    },
  };
}

// ── contains ──────────────────────────────────────────────────────────────────

/** Options for {@link contains}. */
export interface ContainsOptions {
  /** When false (the default), compares case-insensitively. */
  caseSensitive?: boolean;
}

/**
 * Builds a scorer that passes (value 1.0) when `case.expected` appears as a
 * substring of `actual` (case-insensitive by default). An empty `expected`
 * never passes. The most forgiving content check; good for "did the model
 * mention X?" tasks.
 *
 * @param opts - Comparison options; see {@link ContainsOptions}.
 * @returns A {@link Scorer} named `"contains"`.
 */
export function contains(opts: ContainsOptions = {}): Scorer {
  const caseSensitive = opts.caseSensitive ?? false;
  return {
    name: () => "contains",
    score(c: Case, actual: string): Promise<Score> {
      let a = actual;
      let b = c.expected ?? "";
      if (b === "") {
        return Promise.resolve({ value: 0, pass: false, explanation: "Case.expected is empty" });
      }
      if (!caseSensitive) {
        a = a.toLowerCase();
        b = b.toLowerCase();
      }
      if (a.includes(b)) return Promise.resolve({ value: 1, pass: true, explanation: "" });
      return Promise.resolve({
        value: 0,
        pass: false,
        explanation: `missing substring ${JSON.stringify(c.expected)}`,
      });
    },
  };
}

// ── regex ─────────────────────────────────────────────────────────────────────

/**
 * Builds a scorer that passes (value 1.0) when `actual` matches `pattern`. The
 * pattern is compiled lazily on the first `score` call and memoized, so a single
 * scorer instance is safe to reuse across concurrently evaluated cases.
 *
 * @param pattern - A regular expression source string.
 * @returns A {@link Scorer} named `"regex"`. Its `score` rejects with an
 * {@link EvalError} if `pattern` is not a valid regular expression.
 */
export function regex(pattern: string): Scorer {
  let compiled: RegExp | undefined;
  let compileErr: unknown;
  let compiled_once = false;

  return {
    name: () => "regex",
    score(_c: Case, actual: string): Promise<Score> {
      if (!compiled_once) {
        compiled_once = true;
        try {
          compiled = new RegExp(pattern);
        } catch (e) {
          compileErr = e;
        }
      }
      if (compileErr !== undefined) {
        const msg = compileErr instanceof Error ? compileErr.message : String(compileErr);
        return Promise.reject(new EvalError(`regex: compile ${JSON.stringify(pattern)}: ${msg}`));
      }
      if (compiled!.test(actual)) {
        return Promise.resolve({ value: 1, pass: true, explanation: "" });
      }
      return Promise.resolve({
        value: 0,
        pass: false,
        explanation: `no match for /${pattern}/`,
      });
    },
  };
}

// ── scorerFunc / named ────────────────────────────────────────────────────────

/**
 * Adapts a plain scoring function to the {@link Scorer} interface.
 *
 * @param name - The name the returned scorer reports.
 * @param fn - The scoring callback.
 * @returns A {@link Scorer} that delegates `score` to `fn`.
 */
export function scorerFunc(
  name: string,
  fn: (c: Case, actual: string, signal?: AbortSignal) => Promise<Score>,
): Scorer {
  return {
    name: () => name,
    score: (c, actual, signal) => fn(c, actual, signal),
  };
}

/**
 * Wraps any scorer to report a different `name()`, so two scorers that would
 * otherwise collide (same underlying name) can coexist in one `Config.scorers`.
 *
 * @param name - The replacement name to report.
 * @param inner - The scorer whose `score` is delegated to.
 * @returns A {@link Scorer} that scores like `inner` but reports `name`.
 */
export function named(name: string, inner: Scorer): Scorer {
  return {
    name: () => name,
    score: (c, actual, signal) => inner.score(c, actual, signal),
  };
}

// ── llmJudge ──────────────────────────────────────────────────────────────────

/** Options for {@link llmJudge}. */
export interface LLMJudgeOptions {
  /** Serves the judge LLM. Required. */
  provider: Provider;
  /** The judge model ID. Required. */
  model: string;
  /** Evaluation criteria, embedded verbatim in the judge's system prompt. */
  rubric?: string;
  /** Distinguish multiple judges in one report (e.g. "judge_correctness").
   * When omitted, `name()` returns "llm_judge". */
  nameOverride?: string;
  /** Minimum normalized score (in [0, 1]) that counts as a pass. Default 0.7. */
  passThreshold?: number;
  /** Caps the judge's reply length. Default 32. */
  maxTokens?: number;
}

const JUDGE_SYSTEM_BASE =
  `You are an evaluation judge. Read the candidate answer and rate it on a 0..100 scale where:
  100 = perfect, exactly matches what's expected
   50 = partially correct, on-topic but flawed
    0 = irrelevant or wrong
Respond with ONLY a single integer between 0 and 100. No prose. No punctuation. No code fences.`;

/**
 * Builds a scorer that uses a second LLM to rate `actual` against the case's
 * `expected` (or just against a rubric for open-ended tasks). The judge is asked
 * to reply with an integer 0..100, rescaled to [0, 1]; values >= `passThreshold`
 * (default 0.7) count as a pass. The judge's provider/model are independent of
 * the system under test, so the judge can be a stronger (or smaller) model than
 * the Subject.
 *
 * @param opts - Judge provider, model, and scoring options; see
 * {@link LLMJudgeOptions}.
 * @returns A {@link Scorer} named by `opts.nameOverride` or `"llm_judge"`.
 * Unparseable judge replies degrade to a failing score of 0 (no throw); a
 * provider error or missing provider/model throws an {@link EvalError}.
 * @example
 * ```ts
 * const judge = llmJudge({ provider, model: "fast-judge", rubric: "Is it correct?" });
 * const score = await judge.score({ id: "q", input: "Capital of France?", expected: "Paris" }, "Paris");
 * ```
 */
export function llmJudge(opts: LLMJudgeOptions): Scorer {
  const nameOverride = opts.nameOverride ?? "";
  return {
    name: () => (nameOverride !== "" ? nameOverride : "llm_judge"),
    async score(c: Case, actual: string, signal?: AbortSignal): Promise<Score> {
      // Guard against missing provider/model: although both are typed as
      // required, a caller can still slip an empty model or a nullish provider
      // through a cast.
      if (opts.provider == null) {
        throw new EvalError("eval: llmJudge.provider is nil");
      }
      if (opts.model === "") {
        throw new EvalError("eval: llmJudge.model is empty");
      }
      let threshold = opts.passThreshold ?? 0;
      if (threshold <= 0) threshold = 0.7;
      let maxTok = opts.maxTokens ?? 0;
      if (maxTok <= 0) maxTok = 32;

      let sys = JUDGE_SYSTEM_BASE;
      if (opts.rubric && opts.rubric !== "") {
        sys += "\n\nEvaluation criteria:\n" + opts.rubric;
      }
      const user = buildJudgeUserPrompt(c, actual);

      let raw: string;
      try {
        const resp = await opts.provider.generate(
          {
            model: opts.model,
            maxTokens: maxTok,
            messages: [systemMessage(sys), userMessage(user)],
          },
          signal !== undefined ? { signal } : undefined,
        );
        raw = messageText(resp.message);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new EvalError(`llm_judge: ${msg}`);
      }

      const n = parseJudgeScore(raw);
      if (n === null) {
        return {
          value: 0,
          pass: false,
          explanation: "could not parse score from judge reply: " + raw,
        };
      }
      let value = n / 100;
      if (value < 0) value = 0;
      else if (value > 1) value = 1;
      return {
        value,
        pass: value >= threshold,
        explanation: `judge raw=${JSON.stringify(raw)} score=${n}/100 threshold=${threshold.toFixed(2)}`,
      };
    },
  };
}

/** Formats the case + actual for the judge. `expected` is only shown when set. */
function buildJudgeUserPrompt(c: Case, actual: string): string {
  let b = "INPUT:\n" + c.input;
  if (c.expected && c.expected !== "") {
    b += "\n\nEXPECTED REFERENCE:\n" + c.expected;
  }
  b += "\n\nCANDIDATE ANSWER:\n" + actual;
  return b;
}

// judgeScoreOutOf matches a number explicitly presented as a score: "88/100"
// or "88%". These are strong, unambiguous signals so they take priority over
// loose integer tokens scattered through prose.
const judgeScoreOutOf = /(\d{1,3})\s*(?:\/\s*100|%)/g;

// judgeIntToken matches a STANDALONE integer run. The \b anchors exclude digits
// embedded in a word ("v2", "gpt4", "Option2").
const judgeIntToken = /\b\d+\b/g;

const wholeInteger = /^[+-]?\d+$/;

/**
 * parseJudgeScore extracts the judge's intended score in [0, 100] from `raw`,
 * or returns null when it cannot do so unambiguously.
 *
 *   - Fast path: the whole trimmed string is an integer -> use it.
 *   - Otherwise prefer an explicit "N/100" or "N%" form.
 *   - Otherwise fall back to standalone integer tokens, but only when they are
 *     unambiguous (every token resolves to the same value). Conflicting numbers
 *     in prose are refused rather than guessed (a false pass/fail).
 */
export function parseJudgeScore(raw: string): number | null {
  raw = raw.trim();
  if (raw === "") return null;

  // Fast path: the whole thing is the number.
  if (wholeInteger.test(raw)) {
    return clampScore(Number.parseInt(raw, 10));
  }

  // Explicit "N/100" or "N%" form wins. If several appear and they disagree,
  // that's ambiguous -> refuse.
  const outOf = [...raw.matchAll(judgeScoreOutOf)];
  if (outOf.length > 0) {
    const first = Number.parseInt(outOf[0]![1]!, 10);
    for (const g of outOf.slice(1)) {
      if (Number.parseInt(g[1]!, 10) !== first) return null;
    }
    return clampScore(first);
  }

  // Fall back to standalone integer tokens, but only if they all agree.
  const toks = raw.match(judgeIntToken);
  if (!toks || toks.length === 0) return null;
  const first = Number.parseInt(toks[0]!, 10);
  if (Number.isNaN(first)) return null;
  for (const t of toks.slice(1)) {
    const v = Number.parseInt(t, 10);
    if (Number.isNaN(v) || v !== first) return null;
  }
  return clampScore(first);
}

function clampScore(n: number): number {
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}
