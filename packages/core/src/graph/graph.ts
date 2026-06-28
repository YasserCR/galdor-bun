/**
 * The directed-graph builder over a state type S.
 *
 * Construct with `new Graph<S>()`, then chain {@link Graph.addNode},
 * {@link Graph.addEdge}, {@link Graph.addConditionalEdge} /
 * {@link Graph.addConditionalEdges}, and {@link Graph.interruptBefore}, and
 * finish with {@link Graph.compile}. Builder problems are accumulated rather
 * than thrown eagerly, so the fluent API stays chainable; they are reported
 * together as a {@link CompileError} when {@link Graph.compile} runs.
 */

import type { RunContext } from "../runtime/context.ts";
import { Runnable } from "./runnable.ts";
import { CompileError } from "./errors.ts";

/** Implicit entry marker; an edge START -> node names the first node. */
export const START = "__start__";
/** Terminal sentinel; an edge to END stops execution and returns the state. */
export const END = "__end__";

/**
 * The body of a node: it receives the current state plus the run context and
 * returns the next state (or throws to halt the run). Treat state as a value —
 * return a fresh `S` rather than mutating the argument. The signature is async
 * because nodes commonly await providers or tools.
 *
 * @typeParam S - the graph's state type.
 */
export type NodeFunc<S> = (state: S, ctx: RunContext) => S | Promise<S>;

/**
 * Resolves the next node's name (or a branch label) from the current state.
 *
 * @typeParam S - the graph's state type.
 * @returns the next node name, a branch label, or {@link END}.
 */
export type Router<S> = (state: S) => string;

/** Immutable, validated graph data handed to a {@link Runnable}. */
export interface CompiledGraph<S> {
  nodes: Map<string, NodeFunc<S>>;
  staticEdges: Map<string, string>;
  conditionalEdges: Map<string, Router<S>>;
  branchMaps: Map<string, Map<string, string>>;
  interruptBefore: Set<string>;
  entry: string;
}

/**
 * Fluent builder that accumulates nodes and edges, then validates and compiles
 * them into a {@link Runnable}.
 *
 * @typeParam S - the graph's state type.
 *
 * @example
 * ```ts
 * const runnable = new Graph<{ done: boolean }>()
 *   .addNode("work", (s) => ({ ...s, done: true }))
 *   .addEdge(START, "work")
 *   .addEdge("work", END)
 *   .compile();
 * ```
 */
export class Graph<S> {
  #nodes = new Map<string, NodeFunc<S>>();
  #staticEdges = new Map<string, string>();
  #conditionalEdges = new Map<string, Router<S>>();
  #branchMaps = new Map<string, Map<string, string>>();
  #interruptBefore = new Set<string>();
  #errs: string[] = [];

  /**
   * Mark one or more nodes as interrupt-gated: the run pauses just before
   * entering them. Names are validated at compile time.
   *
   * @param names - node names to gate; reserved names are rejected at compile.
   * @returns this builder, for chaining.
   */
  interruptBefore(...names: string[]): this {
    for (const name of names) {
      if (name === "") this.#errs.push("graph: interruptBefore: empty name");
      else if (name === START || name === END)
        this.#errs.push(`graph: interruptBefore: ${name} is a reserved name`);
      else this.#interruptBefore.add(name);
    }
    return this;
  }

  /**
   * Register a node body under a name.
   *
   * @param name - unique node name; must not be empty, reserved, or a duplicate.
   * @param fn - the node body; see {@link NodeFunc}.
   * @returns this builder, for chaining.
   */
  addNode(name: string, fn: NodeFunc<S>): this {
    if (name === "") this.#errs.push("graph: addNode: name is empty");
    else if (name === START || name === END)
      this.#errs.push(`graph: addNode: ${name} is a reserved name`);
    else if (this.#nodes.has(name)) this.#errs.push(`graph: addNode: duplicate node ${name}`);
    else this.#nodes.set(name, fn);
    return this;
  }

  /**
   * Install an unconditional transition from one node to another.
   *
   * @param from - source node name (or {@link START} to set the entry).
   * @param to - destination node name (or {@link END}).
   * @returns this builder, for chaining.
   */
  addEdge(from: string, to: string): this {
    if (from === "" || to === "") this.#errs.push("graph: addEdge: empty endpoint");
    else if (from === END) this.#errs.push("graph: addEdge: cannot have an edge OUT of END");
    else if (to === START) this.#errs.push("graph: addEdge: cannot have an edge INTO START");
    else if (this.#staticEdges.has(from))
      this.#errs.push(`graph: addEdge: ${from} already has static edge -> ${this.#staticEdges.get(from)}`);
    else if (this.#conditionalEdges.has(from))
      this.#errs.push(`graph: addEdge: ${from} already has a conditional edge`);
    else this.#staticEdges.set(from, to);
    return this;
  }

  /**
   * Install a router-driven transition where the router returns the next node
   * name directly.
   *
   * @param from - source node name.
   * @param router - resolves the next node name (or {@link END}) from state.
   * @returns this builder, for chaining.
   */
  addConditionalEdge(from: string, router: Router<S>): this {
    if (this.#checkConditional(from, "addConditionalEdge")) this.#conditionalEdges.set(from, router);
    return this;
  }

  /**
   * Install a router-driven transition where the router returns a semantic
   * label and `branchMap` resolves that label to the actual next node. This
   * decouples the routing decision from concrete node names.
   *
   * @param from - source node name.
   * @param router - resolves a branch label from state.
   * @param branchMap - maps each label to a destination node (or {@link END}); must be non-empty.
   * @returns this builder, for chaining.
   */
  addConditionalEdges(from: string, router: Router<S>, branchMap: Record<string, string>): this {
    const entries = Object.entries(branchMap);
    if (entries.length === 0) {
      this.#errs.push(`graph: addConditionalEdges(${from}): branchMap is empty`);
      return this;
    }
    if (this.#checkConditional(from, "addConditionalEdges")) {
      this.#conditionalEdges.set(from, router);
      this.#branchMaps.set(from, new Map(entries)); // defensive copy
    }
    return this;
  }

  #checkConditional(from: string, op: string): boolean {
    if (from === "") {
      this.#errs.push(`graph: ${op}: empty from`);
      return false;
    }
    if (from === END) {
      this.#errs.push(`graph: ${op}: cannot install router on END`);
      return false;
    }
    if (this.#staticEdges.has(from)) {
      this.#errs.push(`graph: ${op}: ${from} already has static edge -> ${this.#staticEdges.get(from)}`);
      return false;
    }
    if (this.#conditionalEdges.has(from)) {
      this.#errs.push(`graph: ${op}: ${from} already has a router`);
      return false;
    }
    return true;
  }

  /**
   * Validate the assembled graph and produce a {@link Runnable}.
   *
   * @returns a runnable compiled from the current nodes and edges.
   * @throws {CompileError} aggregating every detected problem (accumulated
   * builder errors plus structural checks such as missing entry, dangling
   * edges, or nodes without an outgoing transition).
   */
  compile(): Runnable<S> {
    const problems = [...this.#errs];

    // Entry point: the static edge out of START.
    const entry = this.#staticEdges.get(START);
    const hasEntry = entry !== undefined;
    if (!hasEntry) {
      if (this.#conditionalEdges.has(START))
        problems.push("graph: START must have a static edge, not a conditional one");
      else problems.push("graph: missing entry — add an edge from START to a node");
    }

    // Static edge endpoints must reference known nodes (or END as sink).
    for (const [from, to] of this.#staticEdges) {
      if (from === START) continue;
      if (!this.#nodes.has(from)) problems.push(`graph: edge from unknown node ${from}`);
      if (to !== END && !this.#nodes.has(to))
        problems.push(`graph: edge from ${from} to unknown node ${to}`);
    }
    for (const from of this.#conditionalEdges.keys()) {
      if (from === START) continue;
      if (!this.#nodes.has(from)) problems.push(`graph: conditional edge from unknown node ${from}`);
    }

    // Branch-map targets must reference known nodes (or END).
    for (const [from, bm] of this.#branchMaps) {
      for (const [label, target] of bm) {
        if (target === "") problems.push(`graph: addConditionalEdges(${from}): label ${label} has empty target`);
        else if (target !== END && !this.#nodes.has(target))
          problems.push(`graph: addConditionalEdges(${from}): label ${label} -> unknown node ${target}`);
      }
    }

    // Every node must have exactly one outgoing transition.
    for (const name of this.#nodes.keys()) {
      const hasStatic = this.#staticEdges.has(name);
      const hasCond = this.#conditionalEdges.has(name);
      if (hasStatic && hasCond) problems.push(`graph: node ${name} has both static and conditional edges`);
      else if (!hasStatic && !hasCond) problems.push(`graph: node ${name} has no outgoing edge`);
    }

    // Entry target must exist as a node (or be END).
    if (hasEntry && entry !== END && !this.#nodes.has(entry))
      problems.push(`graph: START -> ${entry} is not a registered node`);

    // Interrupt-gated nodes must reference real nodes.
    for (const name of this.#interruptBefore) {
      if (!this.#nodes.has(name)) problems.push(`graph: interruptBefore: unknown node ${name}`);
    }

    if (problems.length > 0) throw new CompileError(problems);

    const compiled: CompiledGraph<S> = {
      nodes: new Map(this.#nodes),
      staticEdges: new Map(this.#staticEdges),
      conditionalEdges: new Map(this.#conditionalEdges),
      branchMaps: new Map([...this.#branchMaps].map(([k, v]) => [k, new Map(v)])),
      interruptBefore: new Set(this.#interruptBefore),
      entry: entry!,
    };
    return new Runnable<S>(compiled);
  }
}
