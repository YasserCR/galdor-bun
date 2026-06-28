/**
 * Lifecycle callbacks fired around a run and each node.
 *
 * These are the seam observability code uses to emit spans, but any caller can
 * install custom hooks. `beforeRun` and `beforeNode` may return an updated
 * {@link RunContext} that is then used for the wrapped scope. A value thrown
 * from a hook is caught and logged rather than propagated, so broken
 * instrumentation never breaks the run.
 */

import type { Logger, RunContext } from "../runtime/context.ts";

/**
 * Optional lifecycle callbacks for a run.
 *
 * @typeParam S - the graph's state type.
 */
export interface Hooks<S> {
  /** Fired once before the loop starts; a returned context becomes the run's context. */
  beforeRun?(ctx: RunContext, runId: string, initial: S): RunContext | void;
  /** Fired once at termination, whether the run succeeded or failed. */
  afterRun?(ctx: RunContext, runId: string, final: S, error: unknown): void;
  /** Fired before a node dispatches; a returned context is used for the node and {@link Hooks.afterNode}. */
  beforeNode?(ctx: RunContext, runId: string, node: string, step: number, state: S): RunContext | void;
  /** Fired after a node returns; `error` is the node error when one occurred. */
  afterNode?(ctx: RunContext, runId: string, node: string, step: number, state: S, error: unknown): void;
}

/** Log a value thrown from a hook without rethrowing it. */
function recoverHook(logger: Logger | undefined, hook: string, runId: string, node: string | undefined, value: unknown): void {
  logger?.warn("graph: recovered panic in hook", {
    hook,
    runId,
    ...(node ? { node } : {}),
    panicValue: value,
  });
}

/** Invoke {@link Hooks.beforeRun} if present, returning its updated context or `ctx` unchanged. */
export function runBefore<S>(hooks: Hooks<S> | undefined, ctx: RunContext, logger: Logger | undefined, runId: string, initial: S): RunContext {
  if (!hooks?.beforeRun) return ctx;
  try {
    return hooks.beforeRun(ctx, runId, initial) ?? ctx;
  } catch (e) {
    recoverHook(logger, "beforeRun", runId, undefined, e);
    return ctx;
  }
}

/** Invoke {@link Hooks.afterRun} if present, swallowing any thrown value. */
export function runAfter<S>(hooks: Hooks<S> | undefined, ctx: RunContext, logger: Logger | undefined, runId: string, final: S, error: unknown): void {
  if (!hooks?.afterRun) return;
  try {
    hooks.afterRun(ctx, runId, final, error);
  } catch (e) {
    recoverHook(logger, "afterRun", runId, undefined, e);
  }
}

/** Invoke {@link Hooks.beforeNode} if present, returning its updated context or `ctx` unchanged. */
export function nodeBefore<S>(hooks: Hooks<S> | undefined, ctx: RunContext, logger: Logger | undefined, runId: string, node: string, step: number, state: S): RunContext {
  if (!hooks?.beforeNode) return ctx;
  try {
    return hooks.beforeNode(ctx, runId, node, step, state) ?? ctx;
  } catch (e) {
    recoverHook(logger, "beforeNode", runId, node, e);
    return ctx;
  }
}

/** Invoke {@link Hooks.afterNode} if present, swallowing any thrown value. */
export function nodeAfter<S>(hooks: Hooks<S> | undefined, ctx: RunContext, logger: Logger | undefined, runId: string, node: string, step: number, state: S, error: unknown): void {
  if (!hooks?.afterNode) return;
  try {
    hooks.afterNode(ctx, runId, node, step, state, error);
  } catch (e) {
    recoverHook(logger, "afterNode", runId, node, e);
  }
}

/**
 * Compose several {@link Hooks} into one. Each composed callback fires every
 * component's matching callback in order; `beforeRun` and `beforeNode` thread
 * their context returns, so each component sees the context updated by the
 * previous one.
 *
 * @param hooksList - hooks to combine; `undefined` and empty entries are ignored.
 * @returns a single {@link Hooks} object delegating to all components.
 */
export function mergeHooks<S>(...hooksList: Array<Hooks<S> | undefined>): Hooks<S> {
  const hs = hooksList.filter((h): h is Hooks<S> => h !== undefined && Object.values(h).some(Boolean));
  if (hs.length === 0) return {};
  if (hs.length === 1) return hs[0]!;
  return {
    beforeRun(ctx, runId, initial) {
      for (const h of hs) if (h.beforeRun) ctx = h.beforeRun(ctx, runId, initial) ?? ctx;
      return ctx;
    },
    afterRun(ctx, runId, final, error) {
      for (const h of hs) h.afterRun?.(ctx, runId, final, error);
    },
    beforeNode(ctx, runId, node, step, state) {
      for (const h of hs) if (h.beforeNode) ctx = h.beforeNode(ctx, runId, node, step, state) ?? ctx;
      return ctx;
    },
    afterNode(ctx, runId, node, step, state, error) {
      for (const h of hs) h.afterNode?.(ctx, runId, node, step, state, error);
    },
  };
}
