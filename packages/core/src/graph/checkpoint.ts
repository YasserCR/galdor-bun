/**
 * Durable run snapshots that enable interrupt-and-resume.
 *
 * The runtime saves a {@link Checkpoint} *before* executing each node, so
 * `state` is exactly what that node will receive and `node` is the node about
 * to run. Resuming re-enters at precisely that node with precisely that state.
 *
 * Immutability contract: a {@link Checkpointer} MUST capture an independent
 * snapshot of the state, because a later node mutating shared references would
 * otherwise corrupt an already-saved checkpoint. The default
 * {@link MemoryCheckpointer} achieves this with {@link cloneState}, which
 * prefers a {@link Cloner}'s `clone()` method and otherwise uses
 * `structuredClone`.
 */

import { CloneError } from "./errors.ts";

/** Why a checkpoint was written; recorded on every {@link Checkpoint}. */
export const CheckpointReason = {
  /** Ordinary per-step save before a node executes. */
  Step: "step",
  /** The save written just before an interrupt-gated node. */
  Interrupt: "interrupt",
  /** The terminal save written after a run reaches END. */
  End: "end",
} as const;
/** Union of the {@link CheckpointReason} string values. */
export type CheckpointReason = (typeof CheckpointReason)[keyof typeof CheckpointReason];

/** A single saved snapshot of a run at a point just before a node executes. */
export interface Checkpoint<S> {
  /** Stable across resumes; what callers pass to load/resume. */
  runId: string;
  /** 1-based ordinal of the node about to run (0 = initial state). */
  step: number;
  /** The next node to execute (can be END or an interrupt-gated node). */
  node: string;
  /** Snapshot the next node will receive. */
  state: S;
  /** Why this checkpoint was written; see {@link CheckpointReason}. */
  reason: CheckpointReason;
  /** Timestamp the checkpoint was created. */
  createdAt: Date;
}

/**
 * Storage backend for run checkpoints.
 *
 * @typeParam S - the graph's state type.
 */
export interface Checkpointer<S> {
  /**
   * Persist a checkpoint, capturing an independent snapshot of `ck.state`.
   *
   * @param ck - the checkpoint to store.
   */
  save(ck: Checkpoint<S>): Promise<void>;
  /**
   * Load the most recent checkpoint for a run.
   *
   * @param runId - the run identifier to look up.
   * @returns the latest checkpoint, or `undefined` when none exists.
   */
  load(runId: string): Promise<Checkpoint<S> | undefined>;
}

/**
 * Opt-in interface for state types that know how to deep-copy themselves,
 * letting {@link cloneState} bypass `structuredClone`.
 *
 * @typeParam S - the type returned by `clone()`.
 */
export interface Cloner<S> {
  /** @returns an independent deep copy of this value. */
  clone(): S;
}

/** Type guard: does the value expose a callable `clone()` method? */
function hasClone<S>(s: unknown): s is Cloner<S> {
  return typeof s === "object" && s !== null && typeof (s as { clone?: unknown }).clone === "function";
}

/**
 * Is the value safe to hand to `structuredClone` without silent data loss?
 *
 * Only primitives, arrays, and plain objects (prototype is `Object.prototype`
 * or `null`) qualify. A prototype-bearing value such as a class instance is
 * rejected: `structuredClone` does not throw on it but instead returns a plain
 * object, quietly dropping the prototype and its methods. Such state must
 * implement {@link Cloner} to be copied faithfully.
 */
function isPlainCloneable(s: unknown): boolean {
  if (s === null || typeof s !== "object") return true;
  if (Array.isArray(s)) return true;
  const proto = Object.getPrototypeOf(s);
  return proto === Object.prototype || proto === null;
}

/**
 * Produce an independent deep copy of state for safe checkpoint storage. Uses
 * an explicit `clone()` when the state implements {@link Cloner}; otherwise the
 * state must be a primitive, array, or plain object, which is copied with
 * `structuredClone`.
 *
 * A prototype-bearing value (for example a class instance) that does not
 * implement {@link Cloner} is rejected up front: `structuredClone` would
 * silently degrade it to a plain object, dropping its prototype and methods and
 * corrupting the snapshot without warning.
 *
 * @param s - the state value to copy.
 * @returns a deep, independent copy of `s`.
 * @throws {CloneError} when the state cannot be faithfully copied — a class
 * instance (or other non-plain value) without a `clone()` method, or a value
 * holding functions or symbols. Implement {@link Cloner} on the state to
 * resolve this.
 */
export function cloneState<S>(s: S): S {
  if (hasClone<S>(s)) return s.clone();
  if (!isPlainCloneable(s)) throw new CloneError();
  try {
    return structuredClone(s);
  } catch (err) {
    throw new CloneError(err);
  }
}

/**
 * In-process {@link Checkpointer} that keeps each run's checkpoint history in
 * memory. State is deep-copied on save via {@link cloneState}. History is
 * unbounded unless a `limit` is supplied, in which case only the most recent
 * `limit` checkpoints per run are retained.
 *
 * @typeParam S - the graph's state type.
 *
 * @example
 * ```ts
 * const cp = new MemoryCheckpointer<MyState>();
 * await runnable.invoke(initial, { checkpointer: cp, runId: "run-1" });
 * ```
 */
export class MemoryCheckpointer<S> implements Checkpointer<S> {
  #history = new Map<string, Checkpoint<S>[]>();
  readonly #limit: number;

  /** @param limit - per-run retention cap; `<= 0` means unbounded. */
  constructor(limit = 0) {
    this.#limit = limit < 0 ? 0 : limit;
  }

  /**
   * Append a deep-copied checkpoint to the run's history, trimming to the
   * configured retention cap.
   *
   * @param ck - the checkpoint to store.
   * @throws {CloneError} when `ck.state` cannot be deep-copied.
   */
  async save(ck: Checkpoint<S>): Promise<void> {
    const cloned: Checkpoint<S> = { ...ck, state: cloneState(ck.state) };
    const list = this.#history.get(ck.runId) ?? [];
    list.push(cloned);
    if (this.#limit > 0 && list.length > this.#limit) {
      this.#history.set(ck.runId, list.slice(list.length - this.#limit));
    } else {
      this.#history.set(ck.runId, list);
    }
  }

  /**
   * Return the latest stored checkpoint for a run.
   *
   * @param runId - the run identifier to look up.
   * @returns the most recent checkpoint, or `undefined` when none exists.
   */
  async load(runId: string): Promise<Checkpoint<S> | undefined> {
    const list = this.#history.get(runId);
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  }

  /**
   * Return a copy of the full ordered checkpoint history for a run, useful for
   * inspection and time-travel.
   *
   * @param runId - the run identifier to look up.
   * @returns a shallow copy of the run's checkpoint list (empty if unknown).
   */
  history(runId: string): Checkpoint<S>[] {
    return [...(this.#history.get(runId) ?? [])];
  }

  /**
   * Discard all stored checkpoints for a run.
   *
   * @param runId - the run identifier to clear.
   */
  reset(runId: string): void {
    this.#history.delete(runId);
  }
}
