/**
 * Human-in-the-loop: pause a graph at an interrupt gate, then resume it.
 *
 * Run it:
 *
 *   bun packages/examples/graph-resume.ts
 *
 * The graph models a tiny order workflow: a `draft` node prepares an order,
 * then a `fulfill` node ships it. `fulfill` is marked with `interruptBefore`,
 * so the run halts the moment it is about to ship — handing control back to a
 * human for approval.
 *
 *   START -> draft -> (pause) -> fulfill -> END
 *
 * `invoke` throws `InterruptedError` at the gate. We inspect the paused state,
 * stamp it as approved, and `resume` from exactly that point using a
 * `MemoryCheckpointer` that holds the snapshot the runtime saved on its way in.
 */

import {
  Graph,
  InterruptedError,
  MemoryCheckpointer,
  START,
  END,
} from "@galdor/core/graph";

interface OrderState {
  item: string;
  quantity: number;
  approved: boolean;
  status: string;
}

const graph = new Graph<OrderState>()
  .addNode("draft", (s) => ({ ...s, status: "drafted" }))
  .addNode("fulfill", (s) => {
    // Reached only after a human approves and the run is resumed.
    if (!s.approved) throw new Error("fulfill reached without approval");
    return { ...s, status: "shipped" };
  })
  .addEdge(START, "draft")
  .addEdge("draft", "fulfill")
  .addEdge("fulfill", END)
  .interruptBefore("fulfill")
  .compile();

// A checkpointer + a stable runId are what make pause/resume possible: the
// runtime snapshots the state before the gated node, keyed by this id.
const checkpointer = new MemoryCheckpointer<OrderState>();
const runId = "order-1";

const initial: OrderState = {
  item: "ergonomic keyboard",
  quantity: 2,
  approved: false,
  status: "new",
};

let final: OrderState | undefined;

try {
  await graph.invoke(initial, { checkpointer, runId });
} catch (err) {
  if (!(err instanceof InterruptedError)) throw err;

  // The run paused before `fulfill`; the state at that point rides on the error.
  const paused = err.state as OrderState;
  console.log("=== paused at interrupt gate ===");
  console.log("gated node :", err.node);
  console.log("state      :", paused);
  console.log();

  // Simulate a human approving the order, then continue from the gate. The
  // overrideState replaces the saved snapshot for the resumed run.
  console.log("=== resuming with approval ===");
  final = await graph.resume({
    checkpointer,
    runId,
    overrideState: { ...paused, approved: true },
  });
}

if (!final) throw new Error("expected the run to pause and then resume");
console.log("final state:", final);
console.log("status     :", final.status);
