#!/usr/bin/env bun
/**
 * galdor — the command-line tool for building, orchestrating, and observing
 * AI agents.
 *
 * Single binary by design: `bun build --compile` (see `bun run build`) bundles
 * this entry point plus the embedded dashboard into one self-contained
 * executable.
 *
 * Commands: version · doctor · ui · scry (list|show) · weave · cast · council ·
 *           trial · spellbook (list|get) · mcp (serve).
 * Exit codes: 0 ok · 1 failed threshold · 2 setup error · 64 usage error.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { runDuration, runStatus, Store } from "@galdor/core/store";
import { spanDuration } from "@galdor/core/store";

const VERSION = "0.0.0";

/** True when running under the Bun runtime; false under Node (and elsewhere). */
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * Identifies the active JavaScript runtime for diagnostics, e.g. `bun 1.1.0`
 * under Bun or `node 24.0.0` under Node.
 */
function runtimeTag(): string {
  return isBun ? `bun ${Bun.version}` : `node ${process.versions.node}`;
}

function defaultDbPath(): string {
  return process.env.GALDOR_DB || join(homedir(), ".galdor", "traces.db");
}

/** Minimal flag parser: returns { flags, positionals }. */
function parseArgs(argv: string[]): { flags: Map<string, string>; pos: string[] } {
  const flags = new Map<string, string>();
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) flags.set(a.slice(2), argv[++i]!);
      else flags.set(a.slice(2), "true");
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

const nanosToMs = (n: bigint): number => Number(n / 1_000_000n);

function fail(message: string, code: number): never {
  console.error(`galdor: ${message}`);
  process.exit(code);
}

const HELP = `galdor — build, orchestrate and observe AI agents

Usage: galdor <command> [options]

Commands:
  version                       print the version
  doctor                        check the environment for setup problems
  ui        --db <path>         start the observability dashboard
  scry list --db <path>         list recent runs
  scry show <run-id> --db <p>   show a run's span tree
  weave <run-id> --db <path>    print the graph topology recorded for a run
  cast --provider <p> --model <m> "<prompt>"
                                run a one-shot ReAct agent (provider: anthropic)
  council --config <path.json> [--provider <p>] [--model <m>] "<input>"
                                run a multi-agent topology (supervisor or swarm)
                                from a JSON config (provider: anthropic|openai)
  trial --dataset <path.json> --provider <p> --model <m> [--min-pass <0..1>]
                                evaluate a ReAct agent over a JSON dataset
                                (provider: anthropic|openai); exit 1 if the pass
                                rate is below --min-pass
  spellbook list --dir <d>      list prompt templates (name + version)
  spellbook get <name> [--version <v>] --dir <d>
                                print a prompt template (latest if no --version)
  mcp serve [--name <n>]        serve an MCP server over stdio (tools: echo)

Global: --db defaults to $GALDOR_DB or ~/.galdor/traces.db`;

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  const { flags, pos } = parseArgs(rest);

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;

    case "version":
    case "--version":
      console.log(`galdor ${VERSION} (${runtimeTag()})`);
      return;

    case "doctor":
      return doctor();

    case "ui":
      return ui(flags.get("db") ?? defaultDbPath(), Number(flags.get("port") ?? 7777));

    case "scry":
      return scry(pos, flags);

    case "weave":
      return weave(pos, flags);

    case "cast":
      return cast(pos, flags);

    case "council":
      return council(pos, flags);

    case "trial":
      return trial(flags);

    case "spellbook":
      return spellbook(pos, flags);

    case "mcp":
      return mcp(pos, flags);

    default:
      fail(`unknown command ${JSON.stringify(cmd)} (try 'galdor help')`, 64);
  }
}

function doctor(): void {
  console.log("galdor doctor");
  console.log(`  runtime:        ${runtimeTag()}`);
  const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"];
  for (const k of keys) console.log(`  ${k}: ${process.env[k] ? "set" : "—"}`);
  console.log(`  GALDOR_DB:      ${defaultDbPath()}`);
  console.log("ok");
}

async function ui(dbPath: string, port: number): Promise<void> {
  // Import lazily so `galdor version` etc. don't pull the server in.
  const { startDashboard } = await import("@galdor/dashboard");
  let store: Store;
  try {
    store = Store.openExisting(dbPath);
  } catch (e) {
    fail((e as Error).message, 2);
  }
  const server = startDashboard({ store, port });
  await server.ready; // ensures the OS-assigned port is known on Node before we print it
  const url = `http://${server.hostname}:${server.port}`;
  console.log(`galdor ui → ${url}  (db: ${dbPath})`);
  console.log("Ctrl-C to stop.");
}

function scry(pos: string[], flags: Map<string, string>): void {
  const sub = pos[0];
  const dbPath = flags.get("db") ?? defaultDbPath();
  let store: Store;
  try {
    store = Store.openExisting(dbPath);
  } catch (e) {
    fail((e as Error).message, 2);
  }

  if (sub === "list") {
    const runs = store.listRuns(Number(flags.get("limit") ?? 20));
    if (runs.length === 0) {
      console.log("no runs recorded");
      return;
    }
    console.log("RUN".padEnd(28), "STATUS".padEnd(7), "SPANS".padEnd(6), "DURATION");
    for (const r of runs) {
      console.log(
        (r.runId || "(no id)").padEnd(28),
        runStatus(r).padEnd(7),
        String(r.spanCount).padEnd(6),
        `${nanosToMs(runDuration(r))} ms`,
      );
    }
    return;
  }

  if (sub === "show") {
    const runId = pos[1];
    if (!runId) fail("scry show requires a <run-id>", 64);
    const spans = store.spansForRun(runId);
    if (spans.length === 0) {
      console.log(`no spans for run ${runId}`);
      return;
    }
    const byId = new Map(spans.map((s) => [s.spanId, s]));
    const depth = (s: (typeof spans)[number]): number => {
      let d = 0;
      let cur = s;
      while (cur.parentSpanId && byId.has(cur.parentSpanId)) {
        cur = byId.get(cur.parentSpanId)!;
        d++;
      }
      return d;
    };
    for (const s of spans) {
      const mark = s.statusCode === "error" ? " [error]" : "";
      console.log(`${"  ".repeat(depth(s))}${s.name}  ${nanosToMs(spanDuration(s))}ms${mark}`);
    }
    return;
  }

  fail("scry subcommand must be 'list' or 'show'", 64);
}

/**
 * Print the graph topology recorded for a run. The spec is captured at run time
 * (the same one the dashboard renders), so `weave <run-id>` works on any traced
 * run without re-executing the graph. Runs not driven through a graph runnable
 * carry no topology; that is reported plainly and exits 0.
 */
function weave(pos: string[], flags: Map<string, string>): void {
  const runId = pos[0];
  if (!runId) fail("weave requires a <run-id>", 64);
  const dbPath = flags.get("db") ?? defaultDbPath();
  let store: Store;
  try {
    store = Store.openExisting(dbPath);
  } catch (e) {
    fail((e as Error).message, 2);
  }

  const raw = store.getGraphSpec(runId);
  if (raw === "") {
    console.log(`no graph topology recorded for run ${runId}`);
    console.log("  (only runs executed through a graph runnable capture a topology)");
    return;
  }

  let spec: import("@galdor/core/graph").GraphSpec;
  try {
    spec = JSON.parse(raw);
  } catch (e) {
    fail(`weave: decode topology: ${(e as Error).message}`, 2);
  }

  console.log(`run ${runId} topology`);
  console.log(`  entry: ${spec.entry}`);
  console.log(`  nodes: ${spec.nodes.join(", ") || "(none)"}`);
  console.log("  edges:");
  if (spec.edges.length === 0 && spec.conditional.length === 0) {
    console.log("    (none)");
  }
  for (const e of spec.edges) console.log(`    ${e.from} -> ${e.to}`);
  for (const c of spec.conditional) {
    if (c.labels) {
      const labels = Object.entries(c.labels)
        .map(([label, target]) => `${label}:${target}`)
        .join(", ");
      console.log(`    ${c.from} -> {${labels}}  (router)`);
    } else {
      console.log(`    ${c.from} -> (router)`);
    }
  }
}

/**
 * Resolve a Provider from a `--provider` name, reading the matching API key from
 * the environment. Shared by `cast` and `trial` so both verbs select providers
 * identically; `verb` only colors the usage-error text. Exits with code 2 when
 * the required key is unset, or 64 for an unsupported provider name.
 */
async function selectProvider(
  verb: string,
  providerName: string,
  flags: Map<string, string>,
): Promise<import("@galdor/core/provider").Provider> {
  if (providerName === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) fail("ANTHROPIC_API_KEY is not set", 2);
    const { newAnthropic } = await import("@galdor/provider-anthropic");
    return newAnthropic({ apiKey: key });
  }
  if (providerName === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key) fail("OPENAI_API_KEY is not set", 2);
    const { newOpenAI } = await import("@galdor/provider-openai");
    return newOpenAI({ apiKey: key, ...(flags.get("base-url") ? { baseURL: flags.get("base-url")! } : {}) });
  }
  fail(`${verb}: unsupported provider ${JSON.stringify(providerName)} (try 'anthropic' or 'openai')`, 64);
}

async function cast(pos: string[], flags: Map<string, string>): Promise<void> {
  const prompt = pos[0];
  if (!prompt) fail('cast requires a prompt, e.g. galdor cast --model claude-haiku-4-5 "hello"', 64);
  const providerName = flags.get("provider") ?? "anthropic";
  const model = flags.get("model");
  if (!model) fail("cast requires --model", 64);

  const { run } = await import("@galdor/core/agent");
  const provider = await selectProvider("cast", providerName, flags);

  try {
    const answer = await run({ provider, model }, prompt);
    console.log(answer);
  } catch (e) {
    fail((e as Error).message, 1);
  }
}

/** One worker in a supervisor council: a named agent the router may delegate to. */
interface WorkerConfig {
  name: string;
  description: string;
  /** Prepended as the worker's system prompt when it runs its ReAct agent. */
  systemPrompt?: string;
}

/** One peer in a swarm council, plus the names of peers it may hand off to. */
interface SwarmAgentConfig {
  name: string;
  description: string;
  /** Prepended as the agent's system prompt for its inner ReAct loop. */
  systemPrompt?: string;
  handoffs?: string[];
}

/** The JSON topology a `galdor council` run is built from. */
interface CouncilConfig {
  type: "supervisor" | "swarm";
  /** Routing model for a supervisor; falls back to `--model` when omitted. */
  model?: string;
  /** Supervisor workers (supervisor type). */
  workers?: WorkerConfig[];
  /** Swarm peers (swarm type). */
  agents?: SwarmAgentConfig[];
  /** Name of the swarm peer that handles the first message; defaults to the first agent. */
  start?: string;
}

/**
 * Run a multi-agent topology declared in a JSON config. A `supervisor` config
 * dispatches a routing LLM over named workers, each a one-shot ReAct agent; a
 * `swarm` config runs peer agents that hand control to one another. The provider
 * is chosen exactly like `cast`/`trial` (the shared {@link selectProvider}
 * helper); the model comes from the config or `--model`.
 *
 * Exit codes: 64 for a missing/invalid config or usage; 1 for an orchestration
 * error; the provider helper's own codes (e.g. 2 for a missing API key).
 */
async function council(pos: string[], flags: Map<string, string>): Promise<void> {
  const configPath = flags.get("config");
  if (!configPath) fail("council requires --config <path.json>", 64);
  const input = pos[0];
  if (!input) fail('council requires an input, e.g. galdor council --config team.json "<input>"', 64);

  const { readFile } = await import("node:fs/promises");
  let cfg: CouncilConfig;
  try {
    cfg = JSON.parse(await readFile(configPath, "utf8")) as CouncilConfig;
  } catch (e) {
    fail(`council: ${(e as Error).message}`, 64);
  }

  const providerName = flags.get("provider") ?? "anthropic";

  if (cfg.type === "supervisor") {
    const model = cfg.model ?? flags.get("model");
    if (!model) fail("council: supervisor requires a model (config.model or --model)", 64);
    const workersRaw = cfg.workers;
    if (!Array.isArray(workersRaw) || workersRaw.length === 0) {
      fail("council: supervisor requires a non-empty workers array", 64);
    }

    const provider = await selectProvider("council", providerName, flags);
    const { runSupervisor } = await import("@galdor/core/council");
    const { run: runAgent } = await import("@galdor/core/agent");

    // Each worker drives its own one-shot ReAct agent over the selected
    // provider/model, with its configured system prompt threaded in.
    const workers = workersRaw.map((w) => ({
      name: w.name,
      description: w.description,
      run: (task: string, signal?: AbortSignal): Promise<string> =>
        runAgent({ provider, model }, task, {
          ...(w.systemPrompt ? { system: [w.systemPrompt] } : {}),
          ...(signal ? { signal } : {}),
        }),
    }));

    try {
      const answer = await runSupervisor({ provider, model, workers }, input);
      console.log(answer);
    } catch (e) {
      fail((e as Error).message, 1);
    }
    return;
  }

  if (cfg.type === "swarm") {
    const model = cfg.model ?? flags.get("model");
    if (!model) fail("council: swarm requires --model", 64);
    const agentsRaw = cfg.agents;
    if (!Array.isArray(agentsRaw) || agentsRaw.length === 0) {
      fail("council: swarm requires a non-empty agents array", 64);
    }

    const provider = await selectProvider("council", providerName, flags);
    const { runSwarm } = await import("@galdor/core/council");

    // Every peer shares the selected provider/model and runs its own inner
    // ReAct loop; handoffs surface to the LLM as synthetic tools.
    const agents = agentsRaw.map((a) => ({
      name: a.name,
      description: a.description,
      provider,
      model,
      handoffs: a.handoffs ?? [],
      ...(a.systemPrompt ? { systemPrompt: a.systemPrompt } : {}),
    }));
    const start = cfg.start ?? agents[0]!.name;

    try {
      const answer = await runSwarm({ agents, start }, input);
      console.log(answer);
    } catch (e) {
      fail((e as Error).message, 1);
    }
    return;
  }

  fail(`council: unknown type ${JSON.stringify(cfg.type)} (want "supervisor" or "swarm")`, 64);
}

/**
 * Evaluate a ReAct agent over a JSON dataset. Loads the dataset, wraps the agent
 * as an eval Subject, scores each case with the built-in `contains` scorer
 * (case-insensitive substring of the case's `expected`), and prints the report.
 * When `--min-pass` is set, exits 1 if the pass rate falls below it.
 */
async function trial(flags: Map<string, string>): Promise<void> {
  const datasetPath = flags.get("dataset");
  if (!datasetPath) fail("trial requires --dataset <path.json>", 64);
  const providerName = flags.get("provider") ?? "anthropic";
  const model = flags.get("model");
  if (!model) fail("trial requires --model", 64);

  // Parse the optional CI gate up front so a bad value fails as a usage error.
  let minPass: number | undefined;
  const minPassRaw = flags.get("min-pass");
  if (minPassRaw !== undefined) {
    minPass = Number(minPassRaw);
    if (!Number.isFinite(minPass) || minPass < 0 || minPass > 1) {
      fail("trial: --min-pass must be a number in [0, 1]", 64);
    }
  }

  const provider = await selectProvider("trial", providerName, flags);

  const { loadDataset, run: runEval, contains } = await import("@galdor/core/eval");
  const { run: runAgent } = await import("@galdor/core/agent");

  let dataset: import("@galdor/core/eval").Dataset;
  try {
    dataset = await loadDataset(datasetPath);
  } catch (e) {
    fail((e as Error).message, 2);
  }

  // Subject: drive the ReAct agent once per case and return its final text,
  // threading the eval runner's per-case cancellation signal through.
  const subject = (input: string, signal?: AbortSignal): Promise<string> =>
    runAgent({ provider, model }, input, signal ? { signal } : {});

  let report: import("@galdor/core/eval").Report;
  try {
    report = await runEval({
      dataset,
      subject,
      scorers: [contains()],
      ...(minPass !== undefined ? { minPass } : {}),
    });
  } catch (e) {
    fail((e as Error).message, 2);
  }

  printReport(report);

  if (minPass !== undefined && !report.meets(minPass)) process.exit(1);
}

/** Print an eval {@link Report}: dataset name, pass rate, per-scorer aggregates. */
function printReport(report: import("@galdor/core/eval").Report): void {
  const pct = (report.passRate() * 100).toFixed(1);
  console.log(`trial: ${report.dataset} @ ${report.version}`);
  console.log(
    `  pass rate: ${pct}%  (passed ${report.passed}, failed ${report.failed}, ` +
      `errored ${report.errored} of ${report.cases.length})`,
  );
  console.log("  scorers:");
  for (const a of Object.values(report.aggregates)) {
    console.log(`    ${a.scorer.padEnd(14)} mean ${a.mean.toFixed(3)}  pass ${a.pass}  fail ${a.fail}`);
  }
}

/**
 * Browse a file-backed prompt registry. `list` prints every spell's name and
 * version; `get <name>` prints one spell's template, defaulting to the latest
 * version when `--version` is omitted. Both require `--dir`.
 */
async function spellbook(pos: string[], flags: Map<string, string>): Promise<void> {
  const sub = pos[0];
  const dir = flags.get("dir");
  if (!dir) fail("spellbook requires --dir <d>", 64);

  const { openBook } = await import("@galdor/core/spellbook");
  let book: import("@galdor/core/spellbook").Book;
  try {
    book = openBook(dir);
  } catch (e) {
    fail((e as Error).message, 2);
  }

  if (sub === "list") {
    const spells = book.list();
    if (spells.length === 0) {
      console.log("no spells found");
      return;
    }
    for (const s of spells) console.log(`${s.name}  ${s.version}`);
    return;
  }

  if (sub === "get") {
    const name = pos[1];
    if (!name) fail("spellbook get requires a <name>", 64);
    const version = flags.get("version");
    let spell: import("@galdor/core/spellbook").Spell;
    try {
      spell = version ? book.get(name, version) : book.latest(name);
    } catch (e) {
      fail((e as Error).message, 2);
    }
    console.log(spell.template);
    return;
  }

  fail("spellbook subcommand must be 'list' or 'get'", 64);
}

/**
 * Start an MCP server over stdio, exposing a tiny built-in registry so any MCP
 * client (desktop app, IDE plugin, another agent) can drive it. The registry
 * holds a single `echo` tool. The server speaks newline-delimited JSON-RPC on
 * stdin/stdout and serves until the peer closes the stream (EOF); a one-line
 * notice goes to stderr to keep stdout reserved for the protocol.
 */
async function mcp(pos: string[], flags: Map<string, string>): Promise<void> {
  const sub = pos[0];
  if (sub !== "serve") fail("mcp subcommand must be 'serve'", 64);

  const name = flags.get("name") ?? "galdor-mcp";

  const { z } = await import("zod");
  const { defineTool, Registry } = await import("@galdor/core/tool");
  const { Server, StdioTransport } = await import("@galdor/mcp");

  // A minimal tool so a connected client has something to call: echo returns
  // whatever text it is handed.
  const echo = defineTool({
    name: "echo",
    description: "Echo the given text back to the caller.",
    input: z.object({ text: z.string() }),
    handler: ({ text }) => ({ text }),
  });
  const registry = new Registry(echo);

  const server = new Server(registry, { name, version: VERSION });
  const transport = new StdioTransport(process.stdin, process.stdout);

  // Notice on stderr: stdout carries the JSON-RPC frames and must stay clean.
  console.error(`galdor mcp serve → ${name} over stdio (tools: echo). Ctrl-D to stop.`);
  await server.serve(transport);
}

await main();
