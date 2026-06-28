/**
 * Per-run graph-topology recording.
 *
 * {@link recordGraphSpec} returns graph {@link Hooks} that persist a
 * {@link Runnable}'s topology (its {@link GraphSpec}) into a span {@link Store}
 * once per run. The dashboard reads that record to draw the per-run DAG on the
 * run-detail page, and the CLI's `weave` verb prints it — neither has to re-run
 * the graph to know its shape.
 *
 * The spec is serialized once, at call time, because a compiled graph's
 * topology never changes; `beforeRun` only writes the pre-serialized blob under
 * the run's id. Compose it with {@link traceHooks} via `mergeHooks` to get both
 * span emission and topology recording from a single run.
 *
 * @module
 */

import type { GraphSpec, Hooks, Runnable } from "../graph/index.ts";
import type { Store } from "../store/index.ts";

/**
 * Build graph {@link Hooks} that record a runnable's topology into `store`.
 *
 * The runnable's {@link Runnable.inspect | inspect()} output is serialized once
 * up front; the returned `beforeRun` writes it under the run id every run, but
 * only when a non-empty run id is present (an anonymous run has nowhere to file
 * the spec). Writing is best-effort: a store error is swallowed rather than
 * failing the run, since a missing per-run DAG should never abort real work.
 *
 * @typeParam S - the graph state type.
 * @param store - the span store the spec is persisted into.
 * @param runnable - the compiled graph whose topology is recorded.
 * @returns hooks to pass to a run, typically merged with {@link traceHooks}.
 * @example
 * ```ts
 * const tracing = setupTracing("traces.db");
 * const hooks = mergeHooks(traceHooks<S>(tracing.tracer), recordGraphSpec(tracing.store, runnable));
 * await runnable.invoke(initial, { runId: "run-1", hooks });
 * ```
 */
export function recordGraphSpec<S>(store: Store, runnable: Runnable<S>): Hooks<S> {
  const spec: GraphSpec = runnable.inspect();
  const specJSON = JSON.stringify(spec);
  return {
    beforeRun(_ctx, runId) {
      if (runId === "") return;
      try {
        store.setGraphSpec(runId, specJSON);
      } catch {
        // Best effort: never fail a run because its topology couldn't be filed.
      }
    },
  };
}
