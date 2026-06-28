/**
 * Streaming run events.
 *
 * {@link Runnable.stream} yields these as an async iterable. Consumers switch on
 * {@link Event.type} and read the fields relevant to that event.
 */

/** Discriminator for the events yielded by {@link Runnable.stream}. */
export const EventType = {
  /** Once, before any node executes; carries the entry node + initial state. */
  RunStart: "run_start",
  /** Execution enters a node; `node`/`state` are the inputs it will receive. */
  NodeStart: "node_start",
  /** A node returned successfully; `state` is the new state it produced. */
  NodeEnd: "node_end",
  /** After NodeEnd: announces the next node about to be entered (or END). */
  EdgeTraversed: "edge_traversed",
  /** Once, at successful termination; `state` is final, `node` is END. */
  RunEnd: "run_end",
  /** Once, when a run fails; `error` carries the cause. Terminal. */
  Error: "error",
} as const;
/** Union of the {@link EventType} string values. */
export type EventType = (typeof EventType)[keyof typeof EventType];

/**
 * A single event yielded during a streamed run.
 *
 * @typeParam S - the graph's state type.
 */
export interface Event<S> {
  /** Which kind of event this is; see {@link EventType}. */
  type: EventType;
  /** Node the event refers to; for EdgeTraversed it is the edge destination. */
  node: string;
  /** State snapshot at the moment of the event. */
  state: S;
  /** 1-based ordinal of the current step. */
  step: number;
  /** Set only on Error events. */
  error?: unknown;
}
