import { describe, expect, test } from "bun:test";
import {
  CheckpointReason,
  CloneError,
  CompileError,
  END,
  type Event,
  EventType,
  Graph,
  GraphRunError,
  type Hooks,
  type GraphSpec,
  InterruptedError,
  MaxStepsError,
  MemoryCheckpointer,
  mergeHooks,
  NodeError,
  RouterError,
  START,
} from "./index.ts";
import { cloneState } from "./checkpoint.ts";

interface Counter {
  n: number;
  trail: string[];
}

const fresh = (): Counter => ({ n: 0, trail: [] });

describe("Graph build + compile", () => {
  test("a linear graph runs nodes in order", async () => {
    const r = new Graph<Counter>()
      .addNode("a", (s) => ({ n: s.n + 1, trail: [...s.trail, "a"] }))
      .addNode("b", (s) => ({ n: s.n + 1, trail: [...s.trail, "b"] }))
      .addEdge(START, "a")
      .addEdge("a", "b")
      .addEdge("b", END)
      .compile();

    const out = await r.invoke(fresh());
    expect(out.n).toBe(2);
    expect(out.trail).toEqual(["a", "b"]);
  });

  test("compile aggregates problems into a CompileError", () => {
    const build = () =>
      new Graph<Counter>()
        .addNode("a", (s) => s) // no outgoing edge
        .compile(); // also: missing entry
    expect(build).toThrow(CompileError);
    try {
      build();
    } catch (e) {
      expect((e as CompileError).problems.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("reserved names and duplicate edges are rejected", () => {
    expect(() =>
      new Graph<Counter>().addNode(START, (s) => s),
    ).toThrow; // captured at compile; ensure no throw at build time
    expect(() =>
      new Graph<Counter>()
        .addNode("a", (s) => s)
        .addEdge(START, "a")
        .addEdge("a", END)
        .addEdge("a", "a") // duplicate static edge
        .compile(),
    ).toThrow(CompileError);
  });
});

describe("conditional + branch-map edges", () => {
  test("plain conditional edge routes by router result", async () => {
    const r = new Graph<Counter>()
      .addNode("inc", (s) => ({ ...s, n: s.n + 1 }))
      .addEdge(START, "inc")
      .addConditionalEdge("inc", (s) => (s.n < 3 ? "inc" : END))
      .compile();
    expect((await r.invoke(fresh())).n).toBe(3);
  });

  test("branch-map decouples labels from node names", async () => {
    const r = new Graph<Counter>()
      .addNode("check", (s) => ({ ...s, trail: [...s.trail, "check"] }))
      .addNode("approve", (s) => ({ ...s, trail: [...s.trail, "approve"] }))
      .addEdge(START, "check")
      .addConditionalEdges("check", (s) => (s.n > 0 ? "ok" : "deny"), {
        ok: "approve",
        deny: END,
      })
      .addEdge("approve", END)
      .compile();

    expect((await r.invoke({ n: 1, trail: [] })).trail).toEqual(["check", "approve"]);
    expect((await r.invoke({ n: 0, trail: [] })).trail).toEqual(["check"]);
  });

  test("unknown branch label surfaces at run time", async () => {
    const r = new Graph<Counter>()
      .addNode("x", (s) => s)
      .addEdge(START, "x")
      .addConditionalEdges("x", () => "typo", { ok: END })
      .compile();
    await expect(r.invoke(fresh())).rejects.toThrow(/unknown branch label/);
  });
});

describe("max steps", () => {
  test("an infinite cycle is caught by MaxStepsError", async () => {
    const r = new Graph<Counter>()
      .addNode("loop", (s) => ({ ...s, n: s.n + 1 }))
      .addEdge(START, "loop")
      .addConditionalEdge("loop", () => "loop")
      .compile();
    await expect(r.invoke(fresh(), { maxSteps: 5 })).rejects.toBeInstanceOf(MaxStepsError);
  });
});

describe("node errors and panics", () => {
  test("a thrown node error is wrapped in NodeError carrying state", async () => {
    const r = new Graph<Counter>()
      .addNode("bad", () => {
        throw new Error("boom");
      })
      .addEdge(START, "bad")
      .addEdge("bad", END)
      .compile();
    try {
      await r.invoke({ n: 7, trail: [] });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(NodeError);
      expect((e as NodeError).node).toBe("bad");
      expect((e as NodeError).state).toEqual({ n: 7, trail: [] });
    }
  });

  test("invoke: a router that throws surfaces an error carrying .state", async () => {
    const r = new Graph<Counter>()
      .addNode("x", (s) => ({ ...s, n: s.n + 1 }))
      .addEdge(START, "x")
      .addConditionalEdge("x", () => {
        throw new Error("router boom");
      })
      .compile();
    try {
      await r.invoke({ n: 4, trail: ["seed"] });
      throw new Error("should have thrown");
    } catch (e) {
      // The contract: every mid-run error exposes the last observed state.
      expect(e).toBeInstanceOf(GraphRunError);
      expect(e).toBeInstanceOf(RouterError);
      expect((e as RouterError).node).toBe("x");
      expect((e as RouterError).state).toEqual({ n: 5, trail: ["seed"] });
    }
  });

  test("stream: a router that throws ends with an Error event carrying .state", async () => {
    const r = new Graph<Counter>()
      .addNode("x", (s) => ({ ...s, n: s.n + 1 }))
      .addEdge(START, "x")
      .addConditionalEdge("x", () => {
        throw new Error("router boom");
      })
      .compile();
    const events: Event<Counter>[] = [];
    for await (const ev of r.stream({ n: 0, trail: [] })) events.push(ev);
    const last = events.at(-1)!;
    expect(last.type).toBe(EventType.Error);
    expect(last.error).toBeInstanceOf(RouterError);
    expect((last.error as RouterError).state).toEqual({ n: 1, trail: [] });
  });
});

describe("interrupt + resume", () => {
  test("invoke pauses at a gated node; resume continues from it", async () => {
    const cp = new MemoryCheckpointer<Counter>();
    const r = new Graph<Counter>()
      .addNode("first", (s) => ({ ...s, n: s.n + 1, trail: [...s.trail, "first"] }))
      .addNode("second", (s) => ({ ...s, n: s.n + 10, trail: [...s.trail, "second"] }))
      .addEdge(START, "first")
      .addEdge("first", "second")
      .addEdge("second", END)
      .interruptBefore("second")
      .compile();

    const opts = { checkpointer: cp, runId: "run-1" };

    let interrupted: InterruptedError | undefined;
    try {
      await r.invoke(fresh(), opts);
    } catch (e) {
      interrupted = e as InterruptedError;
    }
    expect(interrupted).toBeInstanceOf(InterruptedError);
    expect(interrupted!.node).toBe("second");
    expect((interrupted!.state as Counter).trail).toEqual(["first"]);

    const final = await r.resume(opts);
    expect(final.trail).toEqual(["first", "second"]);
    expect(final.n).toBe(11);
  });

  test("resume can override the paused state", async () => {
    const cp = new MemoryCheckpointer<Counter>();
    const r = new Graph<Counter>()
      .addNode("first", (s) => ({ ...s, trail: [...s.trail, "first"] }))
      .addNode("second", (s) => ({ ...s, n: s.n + 100 }))
      .addEdge(START, "first")
      .addEdge("first", "second")
      .addEdge("second", END)
      .interruptBefore("second")
      .compile();
    const opts = { checkpointer: cp, runId: "r2" };
    await r.invoke(fresh(), opts).catch(() => {});
    const final = await r.resume({ ...opts, overrideState: { n: 5, trail: ["edited"] } });
    expect(final).toEqual({ n: 105, trail: ["edited"] });
  });
});

describe("checkpoints", () => {
  test("memory checkpointer records per-step history and deep-copies state", async () => {
    const cp = new MemoryCheckpointer<Counter>();
    const r = new Graph<Counter>()
      .addNode("a", (s) => ({ ...s, n: s.n + 1 }))
      .addNode("b", (s) => ({ ...s, n: s.n + 1 }))
      .addEdge(START, "a")
      .addEdge("a", "b")
      .addEdge("b", END)
      .compile();

    await r.invoke(fresh(), { checkpointer: cp, runId: "h" });
    const hist = cp.history("h");
    // step checkpoints for a and b, plus the end checkpoint
    expect(hist.map((c) => c.node)).toEqual(["a", "b", END]);
    expect(hist.at(-1)?.reason).toBe(CheckpointReason.End);
    // deep copy: the first snapshot is unaffected by later mutation
    expect(hist[0]?.state.n).toBe(0);
  });

  test("a class-instance state without clone() is rejected with CloneError", async () => {
    // A class instance is not a plain object: structuredClone would silently
    // strip its prototype and methods, so cloneState must reject it instead.
    class Wallet {
      constructor(public balance: number) {}
      debit(amount: number): void {
        this.balance -= amount;
      }
    }
    const cp = new MemoryCheckpointer<Wallet>();
    await expect(
      cp.save({
        runId: "w",
        step: 1,
        node: "n",
        state: new Wallet(100),
        reason: CheckpointReason.Step,
        createdAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(CloneError);

    // Direct cloneState contract: instance rejected, but the same shape as a
    // plain object is cloned faithfully.
    expect(() => cloneState(new Wallet(5))).toThrow(CloneError);
    expect(cloneState({ balance: 5 })).toEqual({ balance: 5 });
  });

  test("a state implementing Cloner is accepted and clone() is honored", async () => {
    class Wallet {
      constructor(public balance: number) {}
      clone(): Wallet {
        return new Wallet(this.balance);
      }
    }
    const cp = new MemoryCheckpointer<Wallet>();
    await cp.save({
      runId: "w2",
      step: 1,
      node: "n",
      state: new Wallet(42),
      reason: CheckpointReason.Step,
      createdAt: new Date(),
    });
    const saved = (await cp.load("w2"))!.state;
    expect(saved).toBeInstanceOf(Wallet);
    expect(saved.balance).toBe(42);
  });

  test("supplying a checkpointer without a runId is rejected", () => {
    const r = new Graph<Counter>()
      .addNode("a", (s) => s)
      .addEdge(START, "a")
      .addEdge("a", END)
      .compile();
    expect(() => r.invoke(fresh(), { checkpointer: new MemoryCheckpointer<Counter>() })).toThrow(
      /requires a RunID/,
    );
  });
});

describe("stream", () => {
  test("emits the full event sequence for a two-node run", async () => {
    const r = new Graph<Counter>()
      .addNode("a", (s) => ({ ...s, n: s.n + 1 }))
      .addNode("b", (s) => ({ ...s, n: s.n + 1 }))
      .addEdge(START, "a")
      .addEdge("a", "b")
      .addEdge("b", END)
      .compile();

    const types: EventType[] = [];
    let final: Counter | undefined;
    for await (const ev of r.stream(fresh())) {
      types.push(ev.type);
      if (ev.type === EventType.RunEnd) final = ev.state;
    }
    expect(types[0]).toBe(EventType.RunStart);
    expect(types.at(-1)).toBe(EventType.RunEnd);
    expect(types.filter((t) => t === EventType.NodeStart)).toHaveLength(2);
    expect(final?.n).toBe(2);
  });

  test("a node error ends the stream with an Error event", async () => {
    const r = new Graph<Counter>()
      .addNode("bad", () => {
        throw new Error("nope");
      })
      .addEdge(START, "bad")
      .addEdge("bad", END)
      .compile();

    const events: Event<Counter>[] = [];
    for await (const ev of r.stream(fresh())) events.push(ev);
    const last = events.at(-1)!;
    expect(last.type).toBe(EventType.Error);
    expect(last.error).toBeInstanceOf(NodeError);
  });
});

describe("hooks", () => {
  test("lifecycle hooks fire around run and nodes; mergeHooks composes", async () => {
    const calls: string[] = [];
    const h1: Hooks<Counter> = {
      beforeRun: () => void calls.push("run:before"),
      afterRun: () => void calls.push("run:after"),
      beforeNode: (_c, _id, node) => void calls.push(`node:before:${node}`),
      afterNode: (_c, _id, node) => void calls.push(`node:after:${node}`),
    };
    const h2: Hooks<Counter> = { beforeNode: (_c, _id, node) => void calls.push(`h2:${node}`) };

    const r = new Graph<Counter>()
      .addNode("a", (s) => s)
      .addEdge(START, "a")
      .addEdge("a", END)
      .compile();

    await r.invoke(fresh(), { hooks: mergeHooks(h1, h2), runId: "x" });
    expect(calls).toEqual([
      "run:before",
      "node:before:a",
      "h2:a",
      "node:after:a",
      "run:after",
    ]);
  });

  test("a panicking hook does not break the run", async () => {
    const r = new Graph<Counter>()
      .addNode("a", (s) => ({ ...s, n: s.n + 1 }))
      .addEdge(START, "a")
      .addEdge("a", END)
      .compile();
    const out = await r.invoke(fresh(), {
      hooks: {
        beforeNode: () => {
          throw new Error("instrumentation boom");
        },
      },
    });
    expect(out.n).toBe(1);
  });

  test("an uncaught throw escaping the loop ends the stream with an Error event", async () => {
    const r = new Graph<Counter>()
      .addNode("a", (s) => ({ ...s, n: s.n + 1 }))
      .addEdge(START, "a")
      .addEdge("a", END)
      .compile();

    // A hooks object whose `beforeNode` access itself throws bypasses the
    // per-hook recover (which only guards the call, not the lookup), so the
    // throw escapes the run loop and must hit the stream's terminal backstop.
    const hooks = {} as Hooks<Counter>;
    Object.defineProperty(hooks, "beforeNode", {
      configurable: true,
      get() {
        throw new Error("hook lookup boom");
      },
    });

    const events: Event<Counter>[] = [];
    for await (const ev of r.stream(fresh(), { hooks })) events.push(ev);

    const last = events.at(-1);
    expect(last?.type).toBe(EventType.Error);
    expect((last?.error as Error).message).toBe("hook lookup boom");
  });
});

describe("inspect (topology)", () => {
  test("reports entry, sorted nodes, static edges (incl. START) and branch labels", () => {
    const r = new Graph<Counter>()
      .addNode("check", (s) => ({ ...s, trail: [...s.trail, "check"] }))
      .addNode("approve", (s) => ({ ...s, trail: [...s.trail, "approve"] }))
      .addEdge(START, "check")
      .addConditionalEdges("check", (s) => (s.n > 0 ? "ok" : "deny"), { ok: "approve", deny: END })
      .addEdge("approve", END)
      .interruptBefore("approve")
      .compile();

    const spec: GraphSpec = r.inspect();
    expect(spec.entry).toBe("check");
    // Nodes are sorted for stable output and exclude START/END.
    expect(spec.nodes).toEqual(["approve", "check"]);
    // Static edges include the synthetic START -> entry edge, sorted by source.
    expect(spec.edges).toEqual([
      { from: START, to: "check" },
      { from: "approve", to: END },
    ]);
    // The branch-map conditional edge records its label -> target map (sorted).
    expect(spec.conditional).toEqual([{ from: "check", labels: { deny: END, ok: "approve" } }]);
  });

  test("a plain conditional edge (no branch map) records only its source", () => {
    const r = new Graph<Counter>()
      .addNode("inc", (s) => ({ ...s, n: s.n + 1 }))
      .addEdge(START, "inc")
      .addConditionalEdge("inc", (s) => (s.n < 3 ? "inc" : END))
      .compile();

    const spec = r.inspect();
    expect(spec.conditional).toEqual([{ from: "inc" }]);
    // No `labels` key at all (not `labels: undefined`) under exactOptionalPropertyTypes.
    expect(Object.hasOwn(spec.conditional[0]!, "labels")).toBe(false);
    // inspect() is JSON-able and stable across calls.
    expect(JSON.stringify(r.inspect())).toBe(JSON.stringify(spec));
  });
});
