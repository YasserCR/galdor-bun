/**
 * Evaluating an agent against a dataset of expected answers.
 *
 * Run it:
 *
 *   bun packages/examples/eval-quickstart.ts
 *
 * We declare a small `Dataset` of capital-city questions, wrap a ReAct agent as
 * the `Subject` under test, and score its answers with two built-in scorers:
 * `exactMatch` (answer equals the reference) and `contains` (reference appears
 * somewhere in the answer). The subject is backed by a `TestProvider`, so the
 * whole evaluation runs offline and deterministically.
 *
 * One case is deliberately answered wrong, so the printed report shows a mix of
 * passes and failures along with the per-scorer aggregates.
 */

import { run as runEval, exactMatch, contains, type Dataset, type Subject } from "@galdor/core/eval";
import { run as runAgent } from "@galdor/core/agent";
import { TestProvider } from "@galdor/core/testprovider";

// What our stand-in "model" would answer for each question. Guayaquil is the
// wrong capital of Ecuador on purpose, to produce a failing case.
const oracle = new Map<string, string>([
  ["What is the capital of France?", "Paris"],
  ["What is the capital of Japan?", "Tokyo"],
  ["What is the capital of Egypt?", "Cairo"],
  ["What is the capital of Ecuador?", "Guayaquil"],
]);

// The subject: for each input, a fresh TestProvider scripted with that answer
// drives a one-shot ReAct turn. This is the same `agent.run` you'd call against
// a real provider.
const subject: Subject = async (input) => {
  const provider = new TestProvider({ responses: [oracle.get(input) ?? "I don't know."] });
  return runAgent({ provider, model: "demo" }, input);
};

const dataset: Dataset = {
  name: "world-capitals",
  version: "1",
  cases: [
    { id: "fr", input: "What is the capital of France?", expected: "Paris" },
    { id: "jp", input: "What is the capital of Japan?", expected: "Tokyo" },
    { id: "eg", input: "What is the capital of Egypt?", expected: "Cairo" },
    { id: "ec", input: "What is the capital of Ecuador?", expected: "Quito" },
  ],
};

const report = await runEval({
  dataset,
  subject,
  scorers: [exactMatch(), contains()],
});

console.log(`=== report: ${report.dataset} v${report.version} ===`);
console.log(`pass rate : ${(report.passRate() * 100).toFixed(0)}%`);
console.log(`passed    : ${report.passed}`);
console.log(`failed    : ${report.failed}`);
console.log(`errored   : ${report.errored}`);
console.log();

console.log("=== per case ===");
for (const c of report.cases) {
  const verdict = c.pass ? "PASS" : "FAIL";
  console.log(
    `[${verdict}] ${c.case.id}: expected=${JSON.stringify(c.case.expected)} actual=${JSON.stringify(c.actual)}`,
  );
}
console.log();

console.log("=== scorer aggregates ===");
for (const a of Object.values(report.aggregates)) {
  console.log(`${a.scorer}: mean=${a.mean.toFixed(2)} pass=${a.pass} fail=${a.fail}`);
}
