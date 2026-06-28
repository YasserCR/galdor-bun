# Contributing to galdor

Thanks for your interest in improving galdor. This document explains how to set
up the project, the conventions we follow, and how to get a change merged.

## Prerequisites

- [Bun](https://bun.sh) `>= 1.3.0` (this repo is pinned to `1.3.14` via `.bun-version`).
- Node.js `>= 22.5` if you also want to exercise the Node code paths.

## Project layout

This is a Bun workspace monorepo. Every package lives under `packages/*`:

- `core` — schema, provider, tool, graph, agent, store, observability, and the
  rest of the framework primitives.
- `provider-anthropic`, `provider-openai`, `provider-google`, `provider-bedrock`
  — model provider adapters.
- `mcp`, `a2a` — interoperability transports.
- `dashboard` — the embedded observability UI.
- `cli` — the `galdor` command-line tool.
- `examples` — runnable, offline examples.

## Getting started

```bash
git clone <your-fork-url> galdor
cd galdor
bun install
```

Common tasks (run from the repo root):

```bash
bun test            # run the test suite
bun run typecheck   # type-check every package
bun run lint        # Biome lint
bun run format      # Biome format (writes changes)
bun run build       # compile every package to dist/
```

The `Makefile` wraps these plus a few extras (`make help` lists them).

## Making a change

1. Create a branch off `main`.
2. Keep changes focused; one logical change per pull request.
3. Add or update tests for any behavior you change — the suite must stay green.
4. Run `bun run lint`, `bun run typecheck`, and `bun test` before pushing.
5. Match the surrounding code: comments describe behavior, not history.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/) for the
subject line, e.g. `feat: …`, `fix: …`, `docs: …`, `refactor: …`, `test: …`,
`build: …`, `chore: …`. Keep the subject in the imperative mood and under ~72
characters; put detail in the body.

## Developer Certificate of Origin (DCO)

This project uses the **DCO** instead of a CLA. By signing off on your commits
you certify that you wrote the code, or otherwise have the right to submit it
under the project's Apache 2.0 license. See [`DCO.txt`](DCO.txt) for the full
text.

Sign off every commit by adding a `Signed-off-by` trailer that matches your
author identity:

```
Signed-off-by: Your Name <you@example.com>
```

Git adds this automatically with the `-s` flag:

```bash
git commit -s -m "fix: handle empty tool output"
```

To sign off work that is already committed:

```bash
git commit --amend -s --no-edit       # the last commit
git rebase --signoff main             # a whole branch
```

A CI check verifies that every commit in a pull request is signed off.

## Pull requests

Open your pull request against `main`. CI runs lint, type-check, build, the test
suite, and the DCO check. A maintainer will review once those pass. See
[`GOVERNANCE.md`](GOVERNANCE.md) for how decisions are made and
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for the expectations we hold each
other to.
