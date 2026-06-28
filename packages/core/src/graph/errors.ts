/**
 * Typed errors thrown by the graph builder and runtime.
 *
 * Every error in this module extends {@link GraphError}, so a single
 * `instanceof GraphError` check separates graph failures from unrelated
 * exceptions. Discriminate specific cases with `instanceof` against the
 * concrete subclass. Errors raised mid-run carry the last observed state on
 * `.state`, so a caller can inspect or persist the partial result even though a
 * thrown value cannot otherwise return it.
 */

/** Base class for every error raised by the graph builder or runtime. */
export class GraphError extends Error {
  override name = "GraphError";
}

/** Aggregates every problem the builder found into one error at compile time. */
export class CompileError extends GraphError {
  override name = "CompileError";
  /** The full list of validation problems detected during compilation. */
  readonly problems: string[];
  /** @param problems - one human-readable message per detected problem. */
  constructor(problems: string[]) {
    const body =
      problems.length === 1
        ? `graph: compile error: ${problems[0]}`
        : `graph: compile error:\n  - ${problems.join("\n  - ")}`;
    super(body);
    this.problems = problems;
  }
}

/** Base for errors thrown mid-run; `.state` is the last observed state. */
export class GraphRunError extends GraphError {
  override name = "GraphRunError";
  readonly state: unknown;
  constructor(message: string, state: unknown, options?: { cause?: unknown }) {
    super(message, options);
    this.state = state;
  }
}

/** A run exceeded its step ceiling — usually a misrouted conditional cycle. */
export class MaxStepsError extends GraphRunError {
  override name = "MaxStepsError";
  constructor(limit: number, state: unknown) {
    super(`graph: max steps exceeded: limit ${limit}`, state);
  }
}

/** A static edge or router resolved to a name that wasn't registered. */
export class UnknownNodeError extends GraphRunError {
  override name = "UnknownNodeError";
  constructor(node: string, state: unknown) {
    super(`graph: unknown node: ${node}`, state);
  }
}

/** Execution reached a node with no outgoing edge (END is the canonical sink). */
export class NoOutgoingEdgeError extends GraphRunError {
  override name = "NoOutgoingEdgeError";
  constructor(node: string, state: unknown) {
    super(`graph: node has no outgoing edge: ${node}`, state);
  }
}

/** A conditional router returned "" (dead-ends should resolve to END). */
export class EmptyRouterResultError extends GraphRunError {
  override name = "EmptyRouterResultError";
  constructor(from: string, state: unknown) {
    super(`graph: router returned empty next-node name: from ${from}`, state);
  }
}

/** A branch-map router returned a label absent from the map. */
export class UnknownBranchLabelError extends GraphRunError {
  override name = "UnknownBranchLabelError";
  constructor(from: string, label: string, state: unknown) {
    super(`graph: router returned unknown branch label: from ${from} label ${label}`, state);
  }
}

/** Wraps the error a node threw, tagging it with the offending node name. */
export class NodeError extends GraphRunError {
  override name = "NodeError";
  /** Name of the node whose body threw. */
  readonly node: string;
  constructor(node: string, cause: unknown, state: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`node ${node}: ${msg}`, state, { cause });
    this.node = node;
  }
}

/**
 * Wraps a panic thrown by a conditional router, tagging it with the source node
 * and carrying the current state on `.state`. Without this, a router that throws
 * would surface a bare {@link NodePanicError} (a {@link GraphError} with no
 * `.state`), breaking the contract that every mid-run error exposes the last
 * observed state.
 */
export class RouterError extends GraphRunError {
  override name = "RouterError";
  /** Name of the node whose outgoing router threw. */
  readonly node: string;
  constructor(node: string, cause: unknown, state: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`router ${node}: ${msg}`, state, { cause });
    this.node = node;
  }
}

/**
 * Thrown by {@link Runnable.invoke} / {@link Runnable.resume} when a run pauses
 * at an interrupt-gated node. The state at the pause point rides on `.state`
 * and the gated node on `.node`. Detect it with `instanceof InterruptedError`,
 * inspect or override the state, then call {@link Runnable.resume} to continue.
 */
export class InterruptedError extends GraphRunError {
  override name = "InterruptedError";
  /** Name of the interrupt-gated node the run paused before. */
  readonly node: string;
  constructor(node: string, state: unknown) {
    super(`graph: run interrupted: at node ${node}`, state);
    this.node = node;
  }
}

/** The run-level timeout elapsed before the graph reached END. */
export class RunTimeoutError extends GraphRunError {
  override name = "RunTimeoutError";
  /** Approximate elapsed wall-clock time in milliseconds when the timeout fired. */
  readonly elapsedMs: number;
  constructor(elapsedMs: number, state: unknown) {
    super(`graph: run timed out after ${elapsedMs}ms`, state);
    this.elapsedMs = elapsedMs;
  }
}

/** The caller's {@link AbortSignal} aborted the run before completion. */
export class RunAbortedError extends GraphRunError {
  override name = "RunAbortedError";
  /** The abort reason carried by the triggering signal. */
  readonly reason: unknown;
  constructor(reason: unknown, state: unknown) {
    super("graph: run aborted", state);
    this.reason = reason;
  }
}

// ── Resume / option errors (no partial state) ─────────────────────────────────

/** {@link Runnable.resume} was called without a checkpointer. */
export class ResumeMissingCheckpointerError extends GraphError {
  override name = "ResumeMissingCheckpointerError";
  constructor() {
    super("graph: Resume requires a Checkpointer");
  }
}

/** {@link Runnable.resume} was called without a runId. */
export class ResumeMissingRunIDError extends GraphError {
  override name = "ResumeMissingRunIDError";
  constructor() {
    super("graph: Resume requires a RunID");
  }
}

/** A checkpointer was supplied to a run without the required runId. */
export class CheckpointerMissingRunIDError extends GraphError {
  override name = "CheckpointerMissingRunIDError";
  constructor() {
    super("graph: Checkpointer requires a RunID");
  }
}

/** No stored checkpoint was found for the requested runId. */
export class CheckpointNotFoundError extends GraphError {
  override name = "CheckpointNotFoundError";
  /** @param runId - the run identifier that had no checkpoint. */
  constructor(runId: string) {
    super(`graph: checkpoint not found: ${runId}`);
  }
}

/**
 * Wraps a non-Error value thrown from a node body or a router so callers always
 * receive an Error with a stack. When a node throws a real Error, that Error is
 * preserved as-is and surfaced through {@link NodeError} instead.
 */
export class NodePanicError extends GraphError {
  override name = "NodePanicError";
  /** The thrown value, exactly as raised. */
  readonly value: unknown;
  /** @param value - the thrown value. @param where - optional context label (e.g. the node or router). */
  constructor(value: unknown, where?: string) {
    super(`${where ? `${where}: ` : ""}panic recovered: ${String(value)}`);
    this.value = value;
  }
}

/** Thrown when a state value cannot be faithfully deep-copied for a checkpoint snapshot. */
export class CloneError extends GraphError {
  override name = "CloneError";
  /** @param cause - the underlying copy failure, when one was raised. */
  constructor(cause?: unknown) {
    super(
      "graph: checkpoint state cannot be faithfully deep-copied: a class instance (or any " +
        "value with a non-plain prototype) would silently lose its prototype and methods under " +
        "structuredClone, and values holding functions or symbols cannot be cloned at all; " +
        "implement a clone() method (Cloner) on the state",
      cause === undefined ? undefined : { cause },
    );
  }
}
