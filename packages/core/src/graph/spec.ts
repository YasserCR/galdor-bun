/**
 * Topology serializer for a compiled graph.
 *
 * A {@link GraphSpec} is a plain, JSON-able snapshot of a compiled graph's
 * shape — its entry node, registered nodes, static edges and router-driven
 * (conditional) edges — with the state type erased. It describes structure, not
 * behavior, so it can be persisted, diffed across versions, shipped to the
 * dashboard for visualization, or printed by the CLI without ever running the
 * graph.
 *
 * The output is deterministic: nodes, edges and conditional sources are sorted,
 * and branch labels are emitted in sorted key order, so two inspections of the
 * same graph serialize byte-for-byte identically.
 */

import type { CompiledGraph } from "./graph.ts";

/** One static (unconditional) transition from one node to another. */
export interface EdgeSpec {
  /** Source node name (or the START sentinel for the entry edge). */
  from: string;
  /** Destination node name (or the END sentinel). */
  to: string;
}

/**
 * One router-driven transition. The destination is chosen at run time, so only
 * the source is recorded — unless the edge was installed with a branch map, in
 * which case {@link ConditionalEdgeSpec.labels} records each label's fixed
 * target.
 */
export interface ConditionalEdgeSpec {
  /** Source node name the router fans out of. */
  from: string;
  /** Label → destination map, present only for branch-map conditional edges. */
  labels?: Record<string, string>;
}

/**
 * The introspected, JSON-able description of a compiled graph's topology.
 *
 * @see {@link inspectGraph} for the serializer that produces it.
 */
export interface GraphSpec {
  /** Name of the first node executed after START. */
  entry: string;
  /** Every registered node, sorted for stable output. */
  nodes: string[];
  /** Static edges, including the START → entry edge, sorted by source. */
  edges: EdgeSpec[];
  /** Router-driven edges, sorted by source. */
  conditional: ConditionalEdgeSpec[];
}

/**
 * Derive a {@link GraphSpec} from a compiled graph's internal maps.
 *
 * The returned object owns its own arrays and is safe to mutate or serialize
 * independently of the graph. Output is deterministic (everything is sorted).
 *
 * @param g - the compiled graph to inspect.
 * @returns the graph's topology as a plain JSON-able object.
 */
export function inspectGraph<S>(g: CompiledGraph<S>): GraphSpec {
  const nodes = [...g.nodes.keys()].sort();

  const edges: EdgeSpec[] = [...g.staticEdges.entries()]
    .map(([from, to]) => ({ from, to }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  const conditional: ConditionalEdgeSpec[] = [...g.conditionalEdges.keys()]
    .sort()
    .map((from) => {
      const bm = g.branchMaps.get(from);
      if (!bm) return { from };
      const labels: Record<string, string> = {};
      for (const label of [...bm.keys()].sort()) labels[label] = bm.get(label)!;
      return { from, labels };
    });

  return { entry: g.entry, nodes, edges, conditional };
}
