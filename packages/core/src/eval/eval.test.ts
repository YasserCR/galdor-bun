import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { messageText, Role } from "../schema/index.ts";
import { TestProvider } from "../testprovider/index.ts";
import {
  type Case,
  contains,
  type Dataset,
  EvalError,
  exactMatch,
  llmJudge,
  loadDataset,
  named,
  parseJudgeScore,
  regex,
  Report,
  run,
  saveDataset,
  type Score,
  scorerFunc,
} from "./index.ts";

const mkCase = (over: Partial<Case> = {}): Case => ({ id: "c", input: "", ...over });

// ── scorers: exactMatch ───────────────────────────────────────────────────────

describe("exactMatch", () => {
  test("trims and folds case by default", async () => {
    const got = await exactMatch().score(mkCase({ expected: "Hello" }), "  hello  ");
    expect(got.pass).toBe(true);
    expect(got.value).toBe(1);
  });

  test("mismatch fails", async () => {
    const got = await exactMatch().score(mkCase({ expected: "yes" }), "no");
    expect(got.pass).toBe(false);
  });

  test("caseSensitive distinguishes case", async () => {
    const got = await exactMatch({ caseSensitive: true }).score(mkCase({ expected: "Yes" }), "yes");
    expect(got.pass).toBe(false);
  });

  test("empty expected never passes (even vs whitespace)", async () => {
    const s = exactMatch();
    for (const actual of ["", "   ", "\t\n"]) {
      const got = await s.score(mkCase({ expected: "" }), actual);
      expect(got.pass).toBe(false);
    }
  });

  test("name", () => {
    expect(exactMatch().name()).toBe("exact_match");
  });
});

// ── scorers: contains ─────────────────────────────────────────────────────────

describe("contains", () => {
  test("case-insensitive substring passes", async () => {
    const got = await contains().score(
      mkCase({ expected: "Quito" }),
      "the capital of Ecuador is QUITO.",
    );
    expect(got.pass).toBe(true);
  });

  test("missing substring fails with explanation", async () => {
    const got = await contains().score(
      mkCase({ expected: "Lima" }),
      "the capital of Ecuador is Quito.",
    );
    expect(got.pass).toBe(false);
    expect(got.explanation).toContain("Lima");
  });

  test("empty expected fails", async () => {
    const got = await contains().score(mkCase(), "anything");
    expect(got.pass).toBe(false);
  });
});

// ── scorers: regex ────────────────────────────────────────────────────────────

describe("regex", () => {
  test("match passes", async () => {
    const got = await regex(String.raw`^\d+ items?$`).score(mkCase(), "42 items");
    expect(got.pass).toBe(true);
  });

  test("no match fails", async () => {
    const got = await regex(String.raw`^\d+ items?$`).score(mkCase(), "lots of items");
    expect(got.pass).toBe(false);
  });

  test("compile error surfaces (rejects) on first score", async () => {
    // An invalid pattern: unterminated group.
    const s = regex("[invalid(");
    await expect(s.score(mkCase(), "anything")).rejects.toThrow();
  });

  test("a single instance is reusable across many cases", async () => {
    const ds: Case[] = [];
    for (let i = 0; i < 64; i++) ds.push({ id: `c${i}`, input: "x", expected: "x" });
    const report = await run({
      dataset: { name: "regex-reuse", version: "1", cases: ds },
      subject: async () => "42 items",
      scorers: [regex(String.raw`^\d+ items?$`)],
      parallel: 8,
    });
    expect(report.passed).toBe(ds.length);
  });
});

// ── scorers: scorerFunc / named ───────────────────────────────────────────────

describe("scorerFunc", () => {
  test("adapts a function and reports its name", async () => {
    const s = scorerFunc(
      "len_at_least_5",
      async (_c, actual): Promise<Score> =>
        actual.length >= 5
          ? { value: 1, pass: true, explanation: "" }
          : { value: 0, pass: false, explanation: "" },
    );
    expect(s.name()).toBe("len_at_least_5");
    expect((await s.score(mkCase(), "hello")).pass).toBe(true);
    expect((await s.score(mkCase(), "hi")).pass).toBe(false);
  });
});

describe("named", () => {
  test("rewrites the reported name, delegates scoring", async () => {
    const s = named("exact_alias", exactMatch());
    expect(s.name()).toBe("exact_alias");
    const got = await s.score(mkCase({ expected: "hi" }), "hi");
    expect(got.pass).toBe(true);
  });
});

// ── scorers: llmJudge ─────────────────────────────────────────────────────────

describe("llmJudge", () => {
  test("parses a bare integer and applies the default threshold", async () => {
    const judge = llmJudge({
      provider: new TestProvider({ responses: ["85"] }),
      model: "judge",
      rubric: "test rubric",
    });
    const got = await judge.score(mkCase({ input: "x", expected: "y" }), "z");
    expect(got.value).toBeCloseTo(0.85, 5);
    expect(got.pass).toBe(true);
    expect(got.explanation).toContain("85/100");
  });

  test("fails below the default threshold", async () => {
    const judge = llmJudge({
      provider: new TestProvider({ responses: ["Score: 30/100"] }),
      model: "judge",
    });
    const got = await judge.score(mkCase({ input: "x" }), "z");
    expect(got.value).toBeCloseTo(0.3, 5);
    expect(got.pass).toBe(false);
  });

  test("graceful on an unparseable reply (0 / fail, no throw)", async () => {
    const judge = llmJudge({
      provider: new TestProvider({ responses: ["I refuse to answer."] }),
      model: "judge",
    });
    const got = await judge.score(mkCase({ input: "x" }), "z");
    expect(got.value).toBe(0);
    expect(got.pass).toBe(false);
  });

  test("does not misparse ambiguous prose", async () => {
    for (const reply of ["matches reference 95 ... score 100", "version 2 answer scored 88"]) {
      const judge = llmJudge({
        provider: new TestProvider({ responses: [reply] }),
        model: "judge",
      });
      const got = await judge.score(mkCase({ input: "x" }), "z");
      expect(got.value).toBe(0);
      expect(got.pass).toBe(false);
    }
  });

  test("parses explicit N/100 and N% forms", async () => {
    const cases: Array<[string, number]> = [
      ["Score: 30/100", 0.3],
      ["I'd give it 72%", 0.72],
    ];
    for (const [reply, want] of cases) {
      const judge = llmJudge({
        provider: new TestProvider({ responses: [reply] }),
        model: "judge",
      });
      const got = await judge.score(mkCase({ input: "x" }), "z");
      expect(got.value).toBeCloseTo(want, 5);
    }
  });

  test("custom threshold and nameOverride", async () => {
    const judge = llmJudge({
      provider: new TestProvider({ responses: ["60"] }),
      model: "judge",
      passThreshold: 0.5,
      nameOverride: "judge_style",
    });
    expect(judge.name()).toBe("judge_style");
    const got = await judge.score(mkCase({ input: "x" }), "z");
    expect(got.pass).toBe(true); // 0.60 >= 0.50
  });

  test("rejects an empty model", async () => {
    const judge = llmJudge({ provider: new TestProvider({ responses: ["1"] }), model: "" });
    await expect(judge.score(mkCase(), "z")).rejects.toBeInstanceOf(EvalError);
  });

  test("default name is llm_judge", () => {
    expect(llmJudge({ provider: new TestProvider(), model: "j" }).name()).toBe("llm_judge");
  });
});

// ── parseJudgeScore (internal regression guard) ───────────────────────────────

describe("parseJudgeScore", () => {
  test("ignores digits embedded in words; refuses genuine conflicts", () => {
    const cases: Array<[string, number | null]> = [
      ["85", 85],
      ["Based on gpt4 analysis, score 85", 85],
      ["v2 model answered; final 90", 90],
      ["Option 2", 2],
      ["matches 95 ... but only 70", null],
      ["no number here", null],
      ["", null],
      ["150", 100], // clamped
    ];
    for (const [raw, want] of cases) {
      expect(parseJudgeScore(raw)).toBe(want);
    }
  });
});

// ── runner ────────────────────────────────────────────────────────────────────

describe("run", () => {
  test("all pass: counts, passRate, aggregate mean", async () => {
    const report = await run({
      dataset: {
        name: "smoke",
        version: "1",
        cases: [
          { id: "c1", input: "hello", expected: "hello" },
          { id: "c2", input: "world", expected: "world" },
        ],
      },
      subject: async (input) => input,
      scorers: [exactMatch()],
    });
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(0);
    expect(report.errored).toBe(0);
    expect(report.meets(1.0)).toBe(true);
    expect(report.aggregates.exact_match?.mean).toBe(1.0);
  });

  test("partial pass: passRate 0.5", async () => {
    const report = await run({
      dataset: {
        name: "mixed",
        version: "1",
        cases: [
          { id: "c1", input: "hello", expected: "hello" },
          { id: "c2", input: "hello", expected: "world" },
        ],
      },
      subject: async () => "hello",
      scorers: [exactMatch()],
    });
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.passRate()).toBe(0.5);
    expect(report.meets(0.9)).toBe(false);
    expect(report.meets(0.5)).toBe(true);
  });

  test("subject error counts as errored, captured in CaseResult.err", async () => {
    const report = await run({
      dataset: { name: "x", version: "1", cases: [{ id: "c1", input: "x", expected: "x" }] },
      subject: async () => {
        throw new Error("provider down");
      },
      scorers: [exactMatch()],
    });
    expect(report.errored).toBe(1);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.cases[0]?.err).toContain("provider down");
  });

  test("a case passes only when EVERY scorer passes", async () => {
    const report = await run({
      dataset: {
        name: "x",
        version: "1",
        cases: [{ id: "c1", input: "x", expected: "the cat sat on the mat" }],
      },
      subject: async () => "the cat sat on the mat",
      scorers: [exactMatch(), regex("^bird")],
    });
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(1);
  });

  test("multiple scorers drive independent aggregates", async () => {
    const report = await run({
      dataset: {
        name: "x",
        version: "1",
        cases: [
          { id: "c1", input: "a", expected: "alpha" }, // exact ✓, contains ✓
          { id: "c2", input: "b", expected: "alp" }, // exact ✗, contains ✓ (substring)
        ],
      },
      subject: async () => "alpha",
      scorers: [exactMatch(), contains()],
    });
    expect(report.aggregates.exact_match?.pass).toBe(1);
    expect(report.aggregates.exact_match?.fail).toBe(1);
    expect(report.aggregates.contains?.pass).toBe(2);
  });

  test("rejects bad config", async () => {
    const base = {
      dataset: { name: "x", version: "1", cases: [{ id: "a", input: "" }] },
      subject: async () => "",
      scorers: [exactMatch()],
    };
    // missing subject
    await expect(
      run({ ...base, subject: undefined as never }),
    ).rejects.toBeInstanceOf(EvalError);
    // empty scorers
    await expect(run({ ...base, scorers: [] })).rejects.toBeInstanceOf(EvalError);
    // empty dataset cases
    await expect(
      run({ ...base, dataset: { name: "x", version: "1", cases: [] } }),
    ).rejects.toBeInstanceOf(EvalError);
  });

  test("rejects duplicate scorer names", async () => {
    await expect(
      run({
        dataset: { name: "x", version: "1", cases: [{ id: "c1", input: "x", expected: "x" }] },
        subject: async (i) => i,
        scorers: [exactMatch(), exactMatch()],
      }),
    ).rejects.toBeInstanceOf(EvalError);
  });

  test("named() lets duplicate underlying scorers coexist", async () => {
    const report = await run({
      dataset: { name: "x", version: "1", cases: [{ id: "c1", input: "x", expected: "x" }] },
      subject: async (i) => i,
      scorers: [exactMatch(), named("exact_2", exactMatch())],
    });
    expect(report.passed).toBe(1);
    expect(report.aggregates.exact_match).toBeDefined();
    expect(report.aggregates.exact_2).toBeDefined();
  });

  test("pre-cancelled signal records cases as errored, never passes", async () => {
    const report = await run(
      {
        dataset: {
          name: "x",
          version: "1",
          cases: [
            { id: "c1", input: "x", expected: "x" },
            { id: "c2", input: "x", expected: "x" },
          ],
        },
        subject: async (i) => i,
        scorers: [exactMatch()],
        parallel: 2,
      },
      AbortSignal.abort(),
    );
    expect(report.passed).toBe(0);
    expect(report.errored).toBe(2);
    expect(report.meets(1.0)).toBe(false);
  });

  test("a throwing scorer is contained (degrades to a failing case)", async () => {
    const boom = named("boom_scorer", {
      name: () => "boom_scorer",
      score: async (): Promise<Score> => {
        throw new Error("scorer exploded");
      },
    });
    const report = await run({
      dataset: { name: "x", version: "1", cases: [{ id: "c1", input: "x", expected: "x" }] },
      subject: async (i) => i,
      scorers: [boom],
      parallel: 1,
    });
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(1);
    expect(report.cases[0]?.scores.boom_scorer?.explanation).toContain("scorer error");
  });

  test("preserves case order by id", async () => {
    const report = await run({
      dataset: {
        name: "x",
        version: "1",
        cases: [
          { id: "c", input: "x", expected: "x" },
          { id: "a", input: "x", expected: "x" },
          { id: "b", input: "x", expected: "x" },
        ],
      },
      subject: async () => "x",
      scorers: [exactMatch()],
    });
    expect(report.cases.map((c) => c.case.id)).toEqual(["a", "b", "c"]);
  });

  test("bounded concurrency: never exceeds `parallel` in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const ds: Case[] = [];
    for (let i = 0; i < 8; i++) ds.push({ id: `c${i}`, input: "x", expected: "x" });
    await run({
      dataset: { name: "slow", version: "1", cases: ds },
      subject: async (i) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(20);
        inFlight--;
        return i;
      },
      scorers: [exactMatch()],
      parallel: 4,
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1); // actually concurrent
  });

  test("per-case timeout records a timed-out case as errored", async () => {
    const report = await run({
      dataset: { name: "x", version: "1", cases: [{ id: "slow", input: "x", expected: "x" }] },
      subject: (_i, signal) =>
        new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => resolve("x"), 1000);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        }),
      scorers: [exactMatch()],
      timeoutPerCaseMs: 20,
    });
    expect(report.errored).toBe(1);
    expect(report.passed).toBe(0);
  });

  test("end-to-end with a TestProvider-backed subject + llmJudge", async () => {
    // The subject is a Provider call; the judge is a second Provider call.
    const subjectProvider = new TestProvider({ responses: ["Paris", "Berlin"] });
    const judgeProvider = new TestProvider({ responses: ["100", "100"] });
    const subject = async (input: string): Promise<string> => {
      const resp = await subjectProvider.generate({
        model: "subject",
        messages: [{ role: Role.User, content: [{ type: "text", text: input }] }],
      });
      return messageText(resp.message);
    };
    const report = await run({
      dataset: {
        name: "capitals",
        version: "1",
        cases: [
          { id: "fr", input: "Capital of France?", expected: "Paris" },
          { id: "de", input: "Capital of Germany?", expected: "Berlin" },
        ],
      },
      subject,
      scorers: [
        contains(),
        llmJudge({ provider: judgeProvider, model: "judge", rubric: "correct?" }),
      ],
    });
    expect(report.passed).toBe(2);
    expect(report.passRate()).toBe(1);
    expect(report.aggregates.llm_judge?.mean).toBe(1);
    expect(report.aggregates.contains?.pass).toBe(2);
  });
});

// ── Report (data shape + helpers) ─────────────────────────────────────────────

describe("Report", () => {
  test("passRate/meets with an explicit construction", () => {
    const r = new Report("x", "1", new Date());
    r.cases = new Array(4).fill(null).map((_, i) => ({
      case: { id: `c${i}`, input: "" },
      actual: "",
      err: "",
      scores: {},
      pass: false,
      durationMs: 0,
    }));
    r.passed = 1;
    expect(r.meets(0)).toBe(true); // a 0 threshold accepts any pass rate
    expect(r.meets(1.0)).toBe(false); // 25% < 100%
    expect(r.passRate()).toBe(0.25);
  });

  test("empty report has passRate 0", () => {
    expect(new Report("x", "1", new Date()).passRate()).toBe(0);
  });
});

// ── loader ────────────────────────────────────────────────────────────────────

describe("loadDataset / saveDataset", () => {
  const written: string[] = [];
  afterEach(() => {
    for (const p of written.splice(0)) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  });

  test("roundtrip preserves cases and metadata", async () => {
    const path = join(tmpdir(), `eval-ds-${Date.now()}-${Math.random()}.json`);
    written.push(path);
    const original: Dataset = {
      name: "loader-test",
      version: "1",
      cases: [
        { id: "a", input: "hello", expected: "world" },
        { id: "b", input: "ping", expected: "pong", metadata: { tag: "smoke" } },
      ],
    };
    await saveDataset(original, path);
    const loaded = await loadDataset(path);
    expect(loaded.name).toBe("loader-test");
    expect(loaded.cases).toHaveLength(2);
    expect(loaded.cases[1]?.metadata?.tag).toBe("smoke");
  });

  test("rejects duplicate case ids", async () => {
    const path = join(tmpdir(), `eval-dup-${Date.now()}-${Math.random()}.json`);
    written.push(path);
    await Bun.write(
      path,
      JSON.stringify({
        name: "x",
        version: "1",
        cases: [
          { id: "a", input: "i" },
          { id: "a", input: "j" },
        ],
      }),
    );
    await expect(loadDataset(path)).rejects.toBeInstanceOf(EvalError);
  });

  test("rejects a missing file", async () => {
    await expect(loadDataset(join(tmpdir(), "definitely-missing-xyz.json"))).rejects.toBeInstanceOf(
      EvalError,
    );
  });
});
