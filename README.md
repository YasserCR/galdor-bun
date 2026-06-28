# galdor

> Build, orchestrate and observe AI agents in TypeScript — native OpenTelemetry, an embedded dashboard, and a single binary, all on Bun.

galdor is a Bun workspace monorepo for building production agents: a typed
provider layer over Anthropic, OpenAI (and OpenAI-compatible backends) and
Google Gemini; a graph runtime with ReAct and plan-and-execute agents; tools
defined once with [Zod](https://zod.dev) and validated at runtime; and
first-class observability that persists `gen_ai.*` / `galdor.*` spans you can
explore from the CLI or the bundled dashboard.

## Getting started

Clone the workspace and build it from source:

```bash
# install bun (https://bun.sh)
curl -fsSL https://bun.sh/install | bash

git clone <repo-url> galdor
cd galdor
bun install
bun run build
```

The required Bun floor is recorded in [`.bun-version`](.bun-version) and
`engines.bun` in `package.json`.

## Quickstart

A ReAct agent that reasons, calls a tool, and feeds the result back to the model:

```ts
import { z } from "zod";
import { tool, agent } from "@galdor/core";
import { newAnthropic } from "@galdor/provider-anthropic";

const add = tool.defineTool({
  name: "add",
  description: "add two numbers",
  input: z.object({ a: z.number(), b: z.number() }),
  handler: ({ a, b }) => ({ sum: a + b }),
});

const provider = newAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const react = agent.newReAct({
  provider,
  model: "claude-sonnet-4-5",
  tools: new tool.Registry(add),
});

const final = await react.invoke(agent.seedState("what is 2 + 3?"));
console.log(final.finalText);
```

Swap the provider line for `newOpenAI({ apiKey, baseURL })` or
`newGoogle({ apiKey })` to target a different backend — the agent code is
unchanged.

## Packages

| Package | What it provides |
| --- | --- |
| `@galdor/core` | The framework: `schema`, `provider`, `tool`, `graph`, `agent`, `store`, `observability`, `eval`, `replay`, `memory`, `embedder`, `council`, `spellbook`, and the scripted `testprovider`. |
| `@galdor/provider-anthropic` | Anthropic (Claude Messages API) — tool use, vision, extended thinking, structured output. |
| `@galdor/provider-openai` | OpenAI Chat Completions, plus any OpenAI-compatible backend (Groq, Together, DeepSeek, vLLM, Ollama, …) via `baseURL`. |
| `@galdor/provider-google` | Google Gemini. |
| `@galdor/mcp` | Model Context Protocol client + server (JSON-RPC 2.0 over stdio, SSE and Streamable HTTP). |
| `@galdor/a2a` | Agent-to-Agent protocol client + server (JSON-RPC 2.0 over HTTP). |
| `@galdor/dashboard` | Embedded observability UI served over `Bun.serve`. |
| `@galdor/cli` | The `galdor` command-line tool (`scry`, `ui`, `cast`, `doctor`), compiled to a single binary. |

`@galdor/core` carries no provider SDK dependencies; providers and backends live
in their own packages so you only pull in what you use.

## Observability + dashboard

Every provider call, tool execution and graph step can emit OpenTelemetry spans.
Wire up the SQLite-backed pipeline in one call with `setupTracing` from
`@galdor/core/observability`; spans land in a `bun:sqlite` database that both the
CLI and the dashboard read.

```bash
galdor scry list --db ./traces.db     # inspect runs and spans from the terminal
galdor ui --db ./traces.db            # dashboard at http://127.0.0.1:7777
```

The dashboard is a self-contained UI on `Bun.serve` — no external collector or
backing service required.

## Building the single binary

The CLI compiles to one self-contained executable:

```bash
cd packages/cli
bun run build        # → ./galdor  (bun build --compile)
./galdor doctor
```

Ship the resulting `galdor` binary on its own; it embeds the Bun runtime.

## Node / pnpm compatibility

The pure framework, protocol and provider packages — `@galdor/core` (apart from
the SQLite span store), `@galdor/provider-*`, `@galdor/mcp` and `@galdor/a2a` —
are runtime-agnostic once built to JavaScript and work fine under Node or pnpm.
The `bun:sqlite` span store, the `@galdor/dashboard` server and the compiled CLI
depend on Bun built-ins (`bun:sqlite`, `Bun.serve`, `bun build --compile`) and
require Bun to run.

## Develop

```bash
bun install
bun test
bun run typecheck
```

## License

Apache-2.0.
