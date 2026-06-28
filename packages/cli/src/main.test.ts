/**
 * End-to-end tests for the themed CLI verbs that need a real process boundary:
 * `weave` reads a persisted graph topology from a store, and `council` runs a
 * multi-agent topology against a mock OpenAI-compatible endpoint. Each case
 * spawns the actual entry point so process exit codes are observed exactly as a
 * shell would see them.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { END, Graph, START } from "@galdor/core/graph";
import { Store } from "@galdor/core/store";

const MAIN = join(import.meta.dir, "main.ts");

let workDir: string;
beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "galdor-cli-"));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

interface CLIResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn the CLI entry point and capture its exit code and streams. */
async function runCLI(args: string[], env: Record<string, string> = {}): Promise<CLIResult> {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * A mock OpenAI-compatible `/chat/completions` server that replays a fixed
 * script of assistant message contents, one per request (the last entry repeats
 * once the script is exhausted).
 */
function mockOpenAI(script: string[]): { baseURL: string; stop: () => void } {
  let i = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      const content = script[Math.min(i, script.length - 1)] ?? "";
      i++;
      return Response.json({
        model: "mock",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

describe("weave", () => {
  test("prints the recorded topology (entry, nodes, edges) and exits 0", async () => {
    const db = join(workDir, "weave.db");
    const st = Store.open(db);
    const g = new Graph<{ n: number }>()
      .addNode("check", (s) => s)
      .addNode("approve", (s) => s)
      .addEdge(START, "check")
      .addConditionalEdges("check", () => "ok", { ok: "approve", deny: END })
      .addEdge("approve", END)
      .compile();
    st.setGraphSpec("run-1", JSON.stringify(g.inspect()));
    st.checkpoint("TRUNCATE");
    st.close();

    const r = await runCLI(["weave", "run-1", "--db", db]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("entry: check");
    expect(r.stdout).toContain("nodes: approve, check");
    expect(r.stdout).toContain("__start__ -> check");
    expect(r.stdout).toContain("check -> {deny:__end__, ok:approve}");
  });

  test("reports no topology and exits 0 when none was recorded", async () => {
    const db = join(workDir, "weave-empty.db");
    Store.open(db).close();
    const r = await runCLI(["weave", "ghost", "--db", db]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no graph topology recorded for run ghost");
  });

  test("missing run-id is a usage error (exit 64)", async () => {
    const db = join(workDir, "weave.db");
    const r = await runCLI(["weave", "--db", db]);
    expect(r.code).toBe(64);
  });
});

describe("council", () => {
  test("supervisor delegates to a worker then prints the final answer (exit 0)", async () => {
    const cfg = join(workDir, "supervisor.json");
    await writeFile(
      cfg,
      JSON.stringify({
        type: "supervisor",
        workers: [{ name: "echo", description: "repeats text", systemPrompt: "You echo." }],
      }),
    );
    // Call 1: supervisor delegates. Call 2: the worker's ReAct agent answers.
    // Call 3: supervisor finalizes.
    const srv = mockOpenAI([
      JSON.stringify({ worker: "echo", task: "say hi" }),
      "hi from echo",
      JSON.stringify({ final: "done: hi from echo" }),
    ]);
    try {
      const r = await runCLI(
        ["council", "--config", cfg, "--provider", "openai", "--model", "mock", "--base-url", srv.baseURL, "please greet"],
        { OPENAI_API_KEY: "dummy" },
      );
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("done: hi from echo");
    } finally {
      srv.stop();
    }
  });

  test("swarm runs a single peer to a final answer (exit 0)", async () => {
    const cfg = join(workDir, "swarm.json");
    await writeFile(
      cfg,
      JSON.stringify({
        type: "swarm",
        start: "solo",
        agents: [{ name: "solo", description: "handles everything", handoffs: [] }],
      }),
    );
    const srv = mockOpenAI(["swarm says hello"]);
    try {
      const r = await runCLI(
        ["council", "--config", cfg, "--provider", "openai", "--model", "mock", "--base-url", srv.baseURL, "hello"],
        { OPENAI_API_KEY: "dummy" },
      );
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("swarm says hello");
    } finally {
      srv.stop();
    }
  });

  test("an unknown topology type is a config error (exit 64)", async () => {
    const cfg = join(workDir, "bad.json");
    await writeFile(cfg, JSON.stringify({ type: "mystery" }));
    const r = await runCLI(["council", "--config", cfg, "--model", "mock", "hi"]);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain("unknown type");
  });

  test("a missing --config is a usage error (exit 64)", async () => {
    const r = await runCLI(["council", "--model", "mock", "hi"]);
    expect(r.code).toBe(64);
  });
});
