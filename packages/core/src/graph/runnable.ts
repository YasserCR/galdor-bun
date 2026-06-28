/**
 * The compiled, executable graph and its two execution paths.
 *
 * A {@link Runnable} is produced by compiling a graph and drives state through
 * its nodes:
 *   - {@link Runnable.invoke} / {@link Runnable.resume} — the awaitable loop.
 *     Resolves with the final state; rejects on error; pauses by throwing
 *     {@link InterruptedError} (the partial state rides on `.state`).
 *   - {@link Runnable.stream} — an async generator of typed {@link Event}s. It
 *     never rejects for run errors; instead it emits a terminal Error event.
 *
 * Cancellation and deadlines are expressed with {@link AbortSignal}:
 *   - a run-level timeout uses `AbortSignal.timeout`, combined with the caller's
 *     own signal;
 *   - a per-node timeout uses a fresh `AbortSignal.timeout` combined for each
 *     node.
 * Cancellation is COOPERATIVE: a node that ignores its signal runs to
 * completion, so long-running work should observe `ctx.signal` to bail out early.
 */

import type { Logger, RunContext } from "../runtime/context.ts";
import type { CompiledGraph, NodeFunc, Router } from "./graph.ts";
import { END } from "./graph.ts";
import { type Checkpoint, type Checkpointer, CheckpointReason } from "./checkpoint.ts";
import { type Event, EventType } from "./event.ts";
import { type Hooks, nodeAfter, nodeBefore, runAfter, runBefore } from "./hooks.ts";
import { type GraphSpec, inspectGraph } from "./spec.ts";
import {
  CheckpointerMissingRunIDError,
  CheckpointNotFoundError,
  EmptyRouterResultError,
  InterruptedError,
  MaxStepsError,
  NodeError,
  NodePanicError,
  NoOutgoingEdgeError,
  ResumeMissingCheckpointerError,
  ResumeMissingRunIDError,
  RouterError,
  RunAbortedError,
  RunTimeoutError,
  UnknownBranchLabelError,
  UnknownNodeError,
} from "./errors.ts";

const DEFAULT_MAX_STEPS = 100;

/**
 * Per-call configuration for a single {@link Runnable.invoke},
 * {@link Runnable.resume}, or {@link Runnable.stream} call. Every field is
 * optional.
 *
 * @typeParam S - the graph's state type.
 */
export interface RunOptions<S> {
  /** Persistence used for checkpoint save/load; required to enable resume. */
  checkpointer?: Checkpointer<S>;
  /** Stable run identifier; required whenever {@link RunOptions.checkpointer} is set. */
  runId?: string;
  /** Overrides the runnable's step ceiling for this call when greater than 0. */
  maxSteps?: number;
  /** On resume, replaces the loaded checkpoint's state before continuing. */
  overrideState?: S;
  /** Lifecycle callbacks fired around the run and each node. */
  hooks?: Hooks<S>;
  /** Caps total wall-clock time in milliseconds; fires {@link RunTimeoutError}. */
  timeoutMs?: number;
  /** Caps any single node's wall-clock time in milliseconds; cooperative. */
  nodeTimeoutMs?: number;
  /** Optional logger used for recovered panics and diagnostics. */
  logger?: Logger;
  /** The caller's cancellation signal; aborting it ends the run. */
  signal?: AbortSignal;
}

/** Combine zero or more abort signals into one that aborts when any does. */
function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const real = signals.filter((s): s is AbortSignal => s !== undefined);
  if (real.length === 0) return undefined;
  if (real.length === 1) return real[0];
  return AbortSignal.any(real);
}

/**
 * A compiled graph ready to execute. Obtain one from {@link Graph.compile};
 * then drive it with {@link Runnable.invoke}, {@link Runnable.resume}, or
 * {@link Runnable.stream}.
 *
 * @typeParam S - the graph's state type.
 *
 * @example
 * ```ts
 * const r = new Graph<{ n: number }>()
 *   .addNode("inc", (s) => ({ n: s.n + 1 }))
 *   .addEdge(START, "inc")
 *   .addConditionalEdge("inc", (s) => (s.n < 3 ? "inc" : END))
 *   .compile();
 * const out = await r.invoke({ n: 0 }); // { n: 3 }
 * ```
 */
export class Runnable<S> {
  readonly #g: CompiledGraph<S>;
  /** Step ceiling; 0 means use the built-in default (100). */
  maxSteps = 0;

  /** Wrap compiled graph data; normally called by {@link Graph.compile}. */
  constructor(compiled: CompiledGraph<S>) {
    this.#g = compiled;
  }

  /** Name of the entry node the run starts from. */
  get entry(): string {
    return this.#g.entry;
  }

  /**
   * Snapshot this graph's topology as a plain, JSON-able {@link GraphSpec}.
   *
   * The result describes shape only (the state type is erased), so it can be
   * persisted, diffed, rendered by the dashboard, or printed by the CLI without
   * running the graph. Output is deterministic.
   *
   * @returns the entry node, registered nodes, static edges and conditional
   * edges derived from the compiled graph.
   * @example
   * ```ts
   * const spec = runnable.inspect();
   * console.log(spec.entry, spec.nodes, spec.edges);
   * ```
   */
  inspect(): GraphSpec {
    return inspectGraph(this.#g);
  }

  #maxStepsOrDefault(opts: RunOptions<S>): number {
    if (opts.maxSteps && opts.maxSteps > 0) return opts.maxSteps;
    if (this.maxSteps > 0) return this.maxSteps;
    return DEFAULT_MAX_STEPS;
  }

  /**
   * Resolve the next node from `current` given the latest state. Throws the
   * relevant run error (empty/unknown label, unknown node, no edge, router panic).
   */
  #resolveNext(current: string, state: S): string {
    const stat = this.#g.staticEdges.get(current);
    if (stat !== undefined) return stat;

    const router = this.#g.conditionalEdges.get(current);
    if (router) {
      let out: string;
      try {
        out = safeRouter(router, state, current);
      } catch (e) {
        // A router panic arrives as a bare NodePanicError (no `.state`). Wrap it
        // so it carries the current state and source node like every other
        // mid-run error, on both the invoke and stream paths.
        if (e instanceof NodePanicError) throw new RouterError(current, e, state);
        throw e;
      }
      if (out === "") throw new EmptyRouterResultError(current, state);
      const bm = this.#g.branchMaps.get(current);
      if (bm) {
        const next = bm.get(out);
        if (next === undefined) throw new UnknownBranchLabelError(current, out, state);
        return next;
      }
      if (out !== END && !this.#g.nodes.has(out)) throw new UnknownNodeError(out, state);
      return out;
    }
    throw new NoOutgoingEdgeError(current, state);
  }

  async #saveCheckpoint(opts: RunOptions<S>, ck: Checkpoint<S>): Promise<void> {
    if (!opts.checkpointer) return;
    await opts.checkpointer.save(ck);
  }

  // ── invoke / resume ─────────────────────────────────────────────────────────

  /**
   * Run the graph to completion, resolving with the final state once END is
   * reached.
   *
   * @param initial - the starting state passed to the entry node.
   * @param opts - per-call configuration; see {@link RunOptions}.
   * @returns the final state at termination.
   * @throws {CheckpointerMissingRunIDError} when a checkpointer is given without a runId.
   * @throws {InterruptedError} when the run pauses at an interrupt-gated node.
   * @throws {NodeError} when a node throws; the partial state rides on `.state`.
   * @throws {RunTimeoutError} when the run-level timeout fires.
   * @throws {RunAbortedError} when the caller's signal aborts the run.
   * @example
   * ```ts
   * const final = await runnable.invoke({ n: 0 }, { timeoutMs: 5_000 });
   * ```
   */
  invoke(initial: S, opts: RunOptions<S> = {}): Promise<S> {
    if (opts.checkpointer && !opts.runId) throw new CheckpointerMissingRunIDError();
    return this.#runLoop(initial, this.#g.entry, 0, opts, false);
  }

  /**
   * Continue a previously interrupted run. Loads the latest checkpoint, applies
   * {@link RunOptions.overrideState} if given, and re-enters at the
   * checkpoint's node — bypassing the interrupt gate for the first hop so the
   * resumed node actually runs.
   *
   * @param opts - must carry a {@link RunOptions.checkpointer} and {@link RunOptions.runId}.
   * @returns the final state at termination.
   * @throws {ResumeMissingCheckpointerError} when no checkpointer is supplied.
   * @throws {ResumeMissingRunIDError} when no runId is supplied.
   * @throws {CheckpointNotFoundError} when no checkpoint exists for the runId.
   */
  async resume(opts: RunOptions<S>): Promise<S> {
    if (!opts.checkpointer) throw new ResumeMissingCheckpointerError();
    if (!opts.runId) throw new ResumeMissingRunIDError();
    const ck = await opts.checkpointer.load(opts.runId);
    if (!ck) throw new CheckpointNotFoundError(opts.runId);
    const state = opts.overrideState !== undefined ? opts.overrideState : ck.state;
    return this.#runLoop(state, ck.node, ck.step - 1, opts, true);
  }

  async #runLoop(
    initial: S,
    startNode: string,
    startStep: number,
    opts: RunOptions<S>,
    bypassInterrupt: boolean,
  ): Promise<S> {
    let state = initial;
    const start = Date.now();
    const runId = opts.runId ?? "";

    const timeoutSignal = opts.timeoutMs && opts.timeoutMs > 0 ? AbortSignal.timeout(opts.timeoutMs) : undefined;
    const runSignal = combineSignals(opts.signal, timeoutSignal);

    let ctx: RunContext = { runId, ...(runSignal ? { signal: runSignal } : {}) };
    ctx = runBefore(opts.hooks, ctx, opts.logger, runId, initial);

    let runErr: unknown;
    try {
      let next = startNode;
      const maxSteps = this.#maxStepsOrDefault(opts);

      for (let step = startStep; ; step++) {
        if (runSignal?.aborted) {
          if (timeoutSignal?.aborted) throw new RunTimeoutError(Date.now() - start, state);
          throw new RunAbortedError(runSignal.reason, state);
        }
        if (next === END) {
          await this.#saveCheckpoint(opts, mkCheckpoint(runId, step, END, state, CheckpointReason.End));
          return state;
        }
        if (step >= maxSteps) throw new MaxStepsError(maxSteps, state);

        if (this.#g.interruptBefore.has(next) && !bypassInterrupt) {
          await this.#saveCheckpoint(opts, mkCheckpoint(runId, step + 1, next, state, CheckpointReason.Interrupt));
          throw new InterruptedError(next, state);
        }
        bypassInterrupt = false;

        const node = this.#g.nodes.get(next);
        if (!node) throw new UnknownNodeError(next, state);

        await this.#saveCheckpoint(opts, mkCheckpoint(runId, step + 1, next, state, CheckpointReason.Step));

        let nodeCtx = nodeBefore(opts.hooks, ctx, opts.logger, runId, next, step + 1, state);
        nodeCtx = applyNodeTimeout(nodeCtx, opts.nodeTimeoutMs);

        let out: S | undefined;
        let nodeErr: unknown;
        try {
          out = await node(state, nodeCtx);
        } catch (e) {
          nodeErr = e;
        }
        nodeAfter(opts.hooks, nodeCtx, opts.logger, runId, next, step + 1, nodeErr === undefined ? out! : state, nodeErr);
        if (nodeErr !== undefined) {
          throw wrapNodeError(next, nodeErr, state, opts.logger, step + 1, runId);
        }
        state = out!;
        next = this.#resolveNext(next, state);
      }
    } catch (e) {
      runErr = e;
      throw e;
    } finally {
      runAfter(opts.hooks, ctx, opts.logger, runId, state, runErr);
    }
  }

  // ── stream ───────────────────────────────────────────────────────────────────

  /**
   * Run the graph and emit typed {@link Event}s as an async generator. Unlike
   * {@link Runnable.invoke}, this never rejects for run errors — a failure (node
   * error, timeout, abort, interrupt, or max-steps) is reported as a terminal
   * Error event and the generator then completes.
   *
   * @param initial - the starting state passed to the entry node.
   * @param opts - per-call configuration; see {@link RunOptions}.
   * @returns an async generator yielding the run's event sequence.
   * @example
   * ```ts
   * for await (const ev of runnable.stream({ n: 0 })) {
   *   if (ev.type === EventType.RunEnd) console.log(ev.state);
   * }
   * ```
   */
  async *stream(initial: S, opts: RunOptions<S> = {}): AsyncGenerator<Event<S>> {
    let state = initial;
    const runId = opts.runId ?? "";

    const timeoutSignal = opts.timeoutMs && opts.timeoutMs > 0 ? AbortSignal.timeout(opts.timeoutMs) : undefined;
    const runSignal = combineSignals(opts.signal, timeoutSignal);

    let ctx: RunContext = { runId, ...(runSignal ? { signal: runSignal } : {}) };
    ctx = runBefore(opts.hooks, ctx, opts.logger, runId, initial);

    let runErr: unknown;
    try {
      if (opts.checkpointer && !opts.runId) {
        runErr = new CheckpointerMissingRunIDError();
        yield { type: EventType.Error, node: "", state, step: 0, error: runErr };
        return;
      }

      const maxSteps = this.#maxStepsOrDefault(opts);
      yield { type: EventType.RunStart, node: this.#g.entry, state, step: 0 };

      let next = this.#g.entry;
      let step = 0;
      for (;;) {
        if (runSignal?.aborted) {
          runErr = timeoutSignal?.aborted ? new RunTimeoutError(0, state) : new RunAbortedError(runSignal.reason, state);
          yield { type: EventType.Error, node: next, state, step, error: runErr };
          return;
        }
        if (next === END) {
          try {
            await this.#saveCheckpoint(opts, mkCheckpoint(runId, step, END, state, CheckpointReason.End));
          } catch (e) {
            runErr = e;
            yield { type: EventType.Error, node: END, state, step, error: e };
            return;
          }
          yield { type: EventType.RunEnd, node: END, state, step };
          return;
        }
        if (step >= maxSteps) {
          runErr = new MaxStepsError(maxSteps, state);
          yield { type: EventType.Error, node: next, state, step, error: runErr };
          return;
        }
        if (this.#g.interruptBefore.has(next)) {
          try {
            await this.#saveCheckpoint(opts, mkCheckpoint(runId, step + 1, next, state, CheckpointReason.Interrupt));
          } catch (e) {
            runErr = e;
            yield { type: EventType.Error, node: next, state, step, error: e };
            return;
          }
          runErr = new InterruptedError(next, state);
          yield { type: EventType.Error, node: next, state, step: step + 1, error: runErr };
          return;
        }
        step++;

        const node = this.#g.nodes.get(next);
        if (!node) {
          runErr = new UnknownNodeError(next, state);
          yield { type: EventType.Error, node: next, state, step, error: runErr };
          return;
        }

        try {
          await this.#saveCheckpoint(opts, mkCheckpoint(runId, step, next, state, CheckpointReason.Step));
        } catch (e) {
          runErr = e;
          yield { type: EventType.Error, node: next, state, step, error: e };
          return;
        }

        yield { type: EventType.NodeStart, node: next, state, step };

        let nodeCtx = nodeBefore(opts.hooks, ctx, opts.logger, runId, next, step, state);
        nodeCtx = applyNodeTimeout(nodeCtx, opts.nodeTimeoutMs);

        let out: S | undefined;
        let nodeErr: unknown;
        try {
          out = await node(state, nodeCtx);
        } catch (e) {
          nodeErr = e;
        }
        nodeAfter(opts.hooks, nodeCtx, opts.logger, runId, next, step, nodeErr === undefined ? out! : state, nodeErr);
        if (nodeErr !== undefined) {
          runErr = wrapNodeError(next, nodeErr, state, opts.logger, step, runId);
          yield { type: EventType.Error, node: next, state, step, error: runErr };
          return;
        }
        state = out!;

        yield { type: EventType.NodeEnd, node: next, state, step };

        let nxt: string;
        try {
          nxt = this.#resolveNext(next, state);
        } catch (e) {
          runErr = e;
          yield { type: EventType.Error, node: next, state, step, error: e };
          return;
        }
        yield { type: EventType.EdgeTraversed, node: nxt, state, step };
        next = nxt;
      }
    } catch (e) {
      // Backstop: a throw escaping the loop — for instance from a hook
      // callback or an edge/router resolver running outside the per-node
      // guard — would otherwise reject the generator with no terminal event.
      // Convert it into a final Error event so consumers always observe a
      // clean end. A non-Error value is wrapped as a NodePanicError.
      runErr = e instanceof Error ? e : new NodePanicError(e, "stream");
      yield { type: EventType.Error, node: "", state, step: 0, error: runErr };
    } finally {
      runAfter(opts.hooks, ctx, opts.logger, runId, state, runErr);
    }
  }
}

/** Build a checkpoint record stamped with the current time. */
function mkCheckpoint<S>(runId: string, step: number, node: string, state: S, reason: CheckpointReason): Checkpoint<S> {
  return { runId, step, node, state, reason, createdAt: new Date() };
}

/** Derive a per-node context whose signal also aborts after the node timeout. */
function applyNodeTimeout(ctx: RunContext, nodeTimeoutMs: number | undefined): RunContext {
  if (!nodeTimeoutMs || nodeTimeoutMs <= 0) return ctx;
  const signal = combineSignals(ctx.signal, AbortSignal.timeout(nodeTimeoutMs));
  return { ...ctx, ...(signal ? { signal } : {}) };
}

/** Wrap a thrown node value into a {@link NodeError}, logging non-Error throws. */
function wrapNodeError(node: string, err: unknown, state: unknown, logger: Logger | undefined, step: number, runId: string): NodeError {
  const cause = err instanceof Error ? err : new NodePanicError(err, `node ${node}`);
  if (cause instanceof NodePanicError) {
    logger?.warn("graph: recovered panic in node", { runId, node, step, panicValue: cause.value });
  }
  return new NodeError(node, cause, state);
}

/** Run a router under a guard, converting a thrown value into a {@link NodePanicError}. */
function safeRouter<S>(router: Router<S>, state: S, from: string): string {
  try {
    return router(state);
  } catch (e) {
    throw new NodePanicError(e, `router from ${from}`);
  }
}
