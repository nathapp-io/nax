/**
 * `src/step-graph/run.ts` — `runStepGraph`, the deterministic resumable runner.
 *
 * Spec: docs/specs/SPEC-step-graph-g1-engine.md § US-002 (AC-1 … AC-24).
 */
import { describe, expect, test } from "bun:test";
import { assertNaxError } from "@test/helpers";
import {
  type GraphState,
  runStepGraph,
  type StepGraph,
  type StepGraphHooks,
  type StepGraphRunOptions,
  type StepNode,
  type StepResult,
} from "@/step-graph";

/**
 * Every id these fixtures mention, deliberately wider than any single graph's node set:
 * `N` is every id a graph *names*, and the tests are what catch a name nothing backs.
 */
type Id = "a" | "b" | "c" | "done" | "x" | "y" | "zzz";

/**
 * The record keys the fixtures may patch. `dropped` and `b` exist so a patch can name them
 * — the tests assert the runner *removes* them rather than writing them.
 */
interface TestState extends GraphState<Id> {
  readonly flag?: boolean;
  readonly kept?: number;
  readonly dropped?: number;
  readonly other?: number;
  readonly b?: number;
}

interface TestEnv {
  readonly tag: string;
}

type TestNode = StepNode<TestState, TestEnv, Id>;
type TestGraph = StepGraph<TestState, TestEnv, Id>;
type TestHooks = StepGraphHooks<TestState, Id>;

const ENV: TestEnv = { tag: "env" };

/** One `run` call, with the state the node was handed. */
interface RunCall {
  readonly node: Id;
  readonly state: TestState;
}

/** Every callback the runner makes, recorded so a test can assert order *and* object identity. */
interface Harness {
  /** `onStep:a`, `run:a`, `persist:b` — in the order they happened. */
  readonly order: string[];
  readonly runs: RunCall[];
  readonly steps: RunCall[];
  readonly persisted: TestState[];
  readonly hooks: TestHooks;
}

/** A hooks pair that records everything; `persist` may be replaced to script a rejection. */
function makeHarness(persist?: TestHooks["persist"]): Harness {
  const order: string[] = [];
  const runs: RunCall[] = [];
  const steps: RunCall[] = [];
  const persisted: TestState[] = [];
  const hooks: TestHooks = {
    persist: async (next) => {
      persisted.push(next);
      order.push(`persist:${next.step}`);
    },
    onStep: (nodeId, next) => {
      steps.push({ node: nodeId, state: next });
      order.push(`onStep:${nodeId}`);
    },
  };
  return { order, runs, steps, persisted, hooks: persist ? { ...hooks, persist } : hooks };
}

type NodeOverrides = Partial<Omit<TestNode, "run">> & { readonly run?: TestNode["run"] };

const noPatch = async (): Promise<StepResult<TestState>> => ({ patch: {} });

/** A node that records its own call; `over` replaces any declaration the case is about. */
function node(h: Harness, id: Id, over: NodeOverrides = {}): TestNode {
  const run = over.run ?? noPatch;
  return {
    kind: "pure",
    produces: [],
    transitions: [{ to: "done" }],
    ...over,
    run: async (env, state) => {
      h.runs.push({ node: id, state });
      h.order.push(`run:${id}`);
      return run(env, state);
    },
  };
}

/** The graph most cases share: `a -> b -> c -> done`. */
function threeNodeGraph(h: Harness): TestGraph {
  return {
    start: "a",
    end: ["done"],
    nodes: {
      a: node(h, "a", { transitions: [{ to: "b" }] }),
      b: node(h, "b", { transitions: [{ to: "c" }] }),
      c: node(h, "c", { transitions: [{ to: "done" }] }),
    },
  };
}

/** A one-node graph: `a -> done`, for the cases that only care what `a` does. */
function oneNodeGraph(h: Harness, over: NodeOverrides = {}): TestGraph {
  return { start: "a", end: ["done"], nodes: { a: node(h, "a", over) } };
}

/** `a` patches `flag`, and its ordered transitions route on it: `x` when true, `y` otherwise. */
function guardGraph(h: Harness, flag: boolean): TestGraph {
  return {
    start: "a",
    end: ["x", "y"],
    nodes: {
      a: node(h, "a", {
        produces: ["flag"],
        transitions: [{ to: "x", when: (state) => state.flag === true }, { to: "y" }],
        run: async () => ({ patch: { flag } }),
      }),
    },
  };
}

/** The two-exit graph: `retry` loops back to `a`, `pass` ends the run. */
function labelledGraph(h: Harness, exit: () => "retry" | "pass"): TestGraph {
  return {
    start: "a",
    end: ["done"],
    nodes: {
      a: node(h, "a", {
        exits: ["retry", "pass"],
        transitions: [
          { on: "retry", to: "a" },
          { on: "pass", to: "done" },
        ],
        run: async () => ({ patch: {}, exit: exit() }),
      }),
    },
  };
}

/**
 * `a` declares only `retry`, which loops back to `a`; its second transition has no `on`, so it
 * is the unconditional way out. `guard`, when given, becomes the retry transition's `when`.
 */
function retryGraph(h: Harness, run: TestNode["run"], guard?: () => boolean): TestGraph {
  return {
    start: "a",
    end: ["done"],
    nodes: {
      a: node(h, "a", {
        exits: ["retry"],
        transitions: [{ on: "retry", ...(guard ? { when: guard } : {}), to: "a" }, { to: "done" }],
        run,
      }),
    },
  };
}

/** The run options a case does not script: nothing aborted, a clock stopped at 0. */
function options<N extends string = Id>(over: Partial<StepGraphRunOptions<N>> = {}): StepGraphRunOptions<N> {
  return { aborted: () => false, now: () => 0, ...over };
}

function graphState(step: Id, timings: Record<string, number> = {}): TestState {
  return { step, timings };
}

/**
 * A graph whose node ids are plain strings, not the fixture `Id` union: the shape a run has when
 * its cursor arrives from persisted state as untrusted runtime data.
 */
type WideGraph = StepGraph<GraphState<string>, TestEnv, string>;
type WideHooks = StepGraphHooks<GraphState<string>, string>;

/** One `pure` node for a wide graph; `onRun` records that it ran. */
function wideNode(onRun: () => void = () => {}): StepNode<GraphState<string>, TestEnv, string> {
  return {
    kind: "pure",
    produces: [],
    transitions: [{ to: "done" }],
    run: async () => {
      onRun();
      return { patch: {} };
    },
  };
}

/** Hooks for a wide graph: records the nodes it stepped and the records it persisted. */
function wideHooks(steps: string[], persisted: GraphState<string>[]): WideHooks {
  return {
    persist: async (next) => {
      persisted.push(next);
    },
    onStep: (id) => {
      steps.push(id);
    },
  };
}

/** A counter clock: `now()` returns 0, `step`, 2×`step` …, and counts how often it was read. */
function counterClock(step = 5): { now: () => number; reads: () => number } {
  let tick = 0;
  let count = 0;
  return {
    now: () => {
      const value = tick;
      tick += step;
      count += 1;
      return value;
    },
    reads: () => count,
  };
}

/** The rejection `promise` produced, so a case can assert it kept the object's identity. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the run to reject");
}

describe("the step-graph barrel (AC-1)", () => {
  test("exports runStepGraph as a function", () => {
    expect(typeof runStepGraph).toBe("function");
  });
});

describe("runStepGraph: a full run", () => {
  test("runs a, b, c in that order and resolves at `done` (AC-1)", async () => {
    const h = makeHarness();

    const result = await runStepGraph(threeNodeGraph(h), ENV, graphState("a"), h.hooks, options());

    expect(h.runs.map((call) => call.node)).toEqual(["a", "b", "c"]);
    expect(result.step).toBe("done");
  });

  test("persists once after each node, the cursor already moved on (AC-2)", async () => {
    const h = makeHarness();

    await runStepGraph(threeNodeGraph(h), ENV, graphState("a"), h.hooks, options());

    expect(h.persisted.map((record) => record.step)).toEqual(["b", "c", "done"]);
  });

  test("calls onStep before each node's run with the state it then receives, and once with `done` (AC-3)", async () => {
    const h = makeHarness();

    const result = await runStepGraph(threeNodeGraph(h), ENV, graphState("a"), h.hooks, options());

    expect(h.order).toEqual([
      "onStep:a",
      "run:a",
      "persist:b",
      "onStep:b",
      "run:b",
      "persist:c",
      "onStep:c",
      "run:c",
      "persist:done",
      "onStep:done",
    ]);
    for (const [index, step] of h.steps.slice(0, 3).entries()) {
      expect(step.state).toBe(h.runs[index].state);
    }
    const last = h.steps[h.steps.length - 1];
    expect(last.node).toBe("done");
    expect(last.state).toBe(result);
  });
});

describe("runStepGraph: resume", () => {
  test("starts at the recorded node, never at the graph's `start` (AC-4)", async () => {
    const h = makeHarness();

    const result = await runStepGraph(threeNodeGraph(h), ENV, graphState("b"), h.hooks, options());

    expect(h.runs.map((call) => call.node)).toEqual(["b", "c"]);
    expect(result.step).toBe("done");
  });

  test("returns an already-terminal record unchanged, without running or persisting (AC-5)", async () => {
    const h = makeHarness();
    const terminal = graphState("done");

    const result = await runStepGraph(threeNodeGraph(h), ENV, terminal, h.hooks, options());

    expect(h.runs).toEqual([]);
    expect(h.persisted).toEqual([]);
    expect(h.steps.map((call) => call.node)).toEqual(["done"]);
    expect(result).toBe(terminal);
  });
});

describe("runStepGraph: a graph that cannot run", () => {
  test("rejects STEP_GRAPH_INVALID before any hook, node or persist (AC-7)", async () => {
    const h = makeHarness();
    const invalid: TestGraph = {
      start: "a",
      end: ["done"],
      nodes: { a: node(h, "a", { transitions: [{ to: "x" }] }) },
    };

    const rejection = await caught(runStepGraph(invalid, ENV, graphState("a"), h.hooks, options()));

    assertNaxError(rejection, "runStepGraph rejection");
    expect(rejection.code).toBe("STEP_GRAPH_INVALID");
    expect(rejection.message).toContain('"x"');
    expect(h.steps).toEqual([]);
    expect(h.runs).toEqual([]);
    expect(h.persisted).toEqual([]);
  });
});

describe("runStepGraph: what a node may write", () => {
  test("rejects a patch key the node does not produce, naming the node and the key (AC-12)", async () => {
    const h = makeHarness();
    const graph = oneNodeGraph(h, { produces: ["a"], run: async () => ({ patch: { b: 1 } }) });

    const rejection = await caught(runStepGraph(graph, ENV, graphState("a"), h.hooks, options()));

    assertNaxError(rejection, "runStepGraph rejection");
    expect(rejection.code).toBe("STEP_GRAPH_UNDECLARED_OUTPUT");
    expect(rejection.message).toContain('node "a"');
    expect(rejection.message).toContain('"b"');
    expect(h.persisted).toEqual([]);
  });

  test("rejects that key when the patch states it as `undefined` (AC-12)", async () => {
    const h = makeHarness();
    const graph = oneNodeGraph(h, { produces: ["a"], run: async () => ({ patch: { b: undefined } }) });

    const rejection = await caught(runStepGraph(graph, ENV, graphState("a"), h.hooks, options()));

    assertNaxError(rejection, "runStepGraph rejection");
    expect(rejection.code).toBe("STEP_GRAPH_UNDECLARED_OUTPUT");
    expect(rejection.message).toContain('"b"');
    expect(h.persisted).toEqual([]);
  });

  test("rejects an exit the node does not declare (AC-13)", async () => {
    const h = makeHarness();
    const graph = oneNodeGraph(h, { exits: ["ok"], run: async () => ({ patch: {}, exit: "other" }) });

    const rejection = await caught(runStepGraph(graph, ENV, graphState("a"), h.hooks, options()));

    assertNaxError(rejection, "runStepGraph rejection");
    expect(rejection.code).toBe("STEP_GRAPH_UNDECLARED_EXIT");
    expect(rejection.message).toContain('"other"');
    expect(h.persisted).toEqual([]);
  });

  test("rejects any exit from a node that declares none (AC-14)", async () => {
    const h = makeHarness();
    const graph = oneNodeGraph(h, { run: async () => ({ patch: {}, exit: "ok" }) });

    const rejection = await caught(runStepGraph(graph, ENV, graphState("a"), h.hooks, options()));

    assertNaxError(rejection, "runStepGraph rejection");
    expect(rejection.code).toBe("STEP_GRAPH_UNDECLARED_EXIT");
    expect(h.persisted).toEqual([]);
  });
});

describe("runStepGraph: the patch", () => {
  test("applies the patch key by key, dropping a key it states as `undefined` (AC-8)", async () => {
    const h = makeHarness();
    const graph = oneNodeGraph(h, {
      produces: ["kept", "dropped"],
      run: async () => ({ patch: { kept: 2, dropped: undefined } }),
    });

    await runStepGraph(graph, ENV, { ...graphState("a"), dropped: 1, other: 3 }, h.hooks, options());

    const persisted = h.persisted[0];
    expect(persisted.kept).toBe(2);
    expect(persisted.other).toBe(3);
    expect("dropped" in persisted).toBe(false);
  });

  test("a guard reads the post-patch state, so the patch itself decides the route (AC-9)", async () => {
    const h = makeHarness();

    const result = await runStepGraph(guardGraph(h, true), ENV, graphState("a"), h.hooks, options());

    expect(result.step).toBe("x");
    expect(h.persisted.map((record) => record.step)).toEqual(["x"]);
  });

  test("the same graph routes the other way when the patch sets the flag false (AC-9)", async () => {
    const h = makeHarness();

    const result = await runStepGraph(guardGraph(h, false), ENV, graphState("a"), h.hooks, options());

    expect(result.step).toBe("y");
    expect(h.persisted.map((record) => record.step)).toEqual(["y"]);
  });
});

describe("runStepGraph: routing on the result's exit", () => {
  test("follows the transition whose `on` matches the exit, and keeps the label out of the record (AC-10)", async () => {
    const h = makeHarness();
    let calls = 0;
    const graph = labelledGraph(h, () => (calls++ === 0 ? "retry" : "pass"));

    const result = await runStepGraph(graph, ENV, graphState("a"), h.hooks, options());

    expect(h.persisted.map((record) => record.step)).toEqual(["a", "done"]);
    expect(result.step).toBe("done");
    expect(Object.keys(h.persisted[0]).sort()).toEqual(["step", "timings"]);
  });

  test("routes straight to `done` when the first result exits `pass` (AC-10)", async () => {
    const h = makeHarness();

    const result = await runStepGraph(
      labelledGraph(h, () => "pass"),
      ENV,
      graphState("a"),
      h.hooks,
      options(),
    );

    expect(result.step).toBe("done");
    expect(h.persisted.map((record) => record.step)).toEqual(["done"]);
  });

  test("skips a transition whose `on` the result did not exit (AC-15)", async () => {
    const h = makeHarness();
    const graph = retryGraph(h, noPatch);

    const result = await runStepGraph(graph, ENV, graphState("a"), h.hooks, options());

    expect(result.step).toBe("done");
    expect(h.persisted.map((record) => record.step)).toEqual(["done"]);
  });

  test("skips a matching `on` whose `when` is false, because a transition needs both (AC-16)", async () => {
    const h = makeHarness();
    const graph = retryGraph(
      h,
      async () => ({ patch: {}, exit: "retry" }),
      () => false,
    );

    const result = await runStepGraph(graph, ENV, graphState("a"), h.hooks, options());

    expect(result.step).toBe("done");
  });
});

describe("runStepGraph: no way out of a node", () => {
  test("rejects STEP_GRAPH_NO_TRANSITION naming the node, without persisting it (AC-11)", async () => {
    const h = makeHarness();
    const graph: TestGraph = {
      start: "a",
      end: ["x"],
      nodes: { a: node(h, "a", { transitions: [{ to: "x", when: () => false }] }) },
    };

    const rejection = await caught(runStepGraph(graph, ENV, graphState("a"), h.hooks, options()));

    assertNaxError(rejection, "runStepGraph rejection");
    expect(rejection.code).toBe("STEP_GRAPH_NO_TRANSITION");
    expect(rejection.message).toContain('node "a"');
    expect(h.runs.map((call) => call.node)).toEqual(["a"]);
    expect(h.persisted).toEqual([]);
  });

  test("a guard's rejection propagates unchanged, without persisting that node (AC-17)", async () => {
    const h = makeHarness();
    const guard = new Error("guard");
    const graph = oneNodeGraph(h, {
      transitions: [
        {
          to: "done",
          when: () => {
            throw guard;
          },
        },
      ],
    });

    const rejection = await caught(runStepGraph(graph, ENV, graphState("a"), h.hooks, options()));

    expect(rejection).toBe(guard);
    expect(h.persisted).toEqual([]);
  });
});

describe("runStepGraph: accumulated timing", () => {
  test("records each node's elapsed time and reads the clock exactly twice per node (AC-21)", async () => {
    const h = makeHarness();
    const clock = counterClock();
    const graph: TestGraph = {
      start: "a",
      end: ["done"],
      nodes: { a: node(h, "a", { transitions: [{ to: "b" }] }), b: node(h, "b") },
    };

    await runStepGraph(graph, ENV, graphState("a"), h.hooks, options({ now: clock.now }));

    expect(h.persisted.map((record) => record.timings)).toEqual([{ a: 5 }, { a: 5, b: 5 }]);
    expect(clock.reads()).toBe(4);
  });

  test("sums every visit to one node and keeps the entries the record already had (AC-22)", async () => {
    const h = makeHarness();
    const clock = counterClock();
    let back = false;
    const graph: TestGraph = {
      start: "a",
      end: ["done"],
      nodes: {
        a: node(h, "a", { transitions: [{ to: "b" }] }),
        b: node(h, "b", {
          transitions: [
            {
              to: "a",
              when: () => {
                const sendBack = !back;
                back = true;
                return sendBack;
              },
            },
            { to: "done" },
          ],
        }),
      },
    };

    const result = await runStepGraph(graph, ENV, graphState("a", { zzz: 7 }), h.hooks, options({ now: clock.now }));

    expect(h.runs.map((call) => call.node)).toEqual(["a", "b", "a", "b"]);
    expect(result.timings).toEqual({ zzz: 7, a: 10, b: 10 });
  });
});

describe("runStepGraph: a node id that shadows a prototype key (F1)", () => {
  test("records its timing as its own number, not as an inherited value", async () => {
    const clock = counterClock();
    const steps: string[] = [];
    const persisted: GraphState<string>[] = [];
    const graph: WideGraph = {
      start: "constructor",
      end: ["done"],
      nodes: { ["constructor"]: wideNode() },
    };

    const result = await runStepGraph(
      graph,
      ENV,
      { step: "constructor", timings: {} },
      wideHooks(steps, persisted),
      options({ now: clock.now }),
    );

    expect(result.timings["constructor"]).toBe(5);
    expect(Object.keys(result.timings)).toEqual(["constructor"]);
  });
});

describe("runStepGraph: an unrecordable cursor", () => {
  test("rejects STEP_GRAPH_UNKNOWN_NODE without running or persisting (AC-6)", async () => {
    const h = makeHarness();

    const rejection = await caught(runStepGraph(threeNodeGraph(h), ENV, graphState("zzz"), h.hooks, options()));

    assertNaxError(rejection, "runStepGraph rejection");
    expect(rejection.code).toBe("STEP_GRAPH_UNKNOWN_NODE");
    expect(rejection.context?.stage).toBe("step-graph");
    expect(rejection.context?.node).toBe("zzz");
    expect(h.runs).toEqual([]);
    expect(h.persisted).toEqual([]);
  });

  test("prefers that code over an abort, which would otherwise mask the bad cursor (AC-6)", async () => {
    const h = makeHarness();

    const rejection = await caught(
      runStepGraph(threeNodeGraph(h), ENV, graphState("zzz"), h.hooks, options({ aborted: () => true })),
    );

    assertNaxError(rejection, "runStepGraph rejection");
    expect(rejection.code).toBe("STEP_GRAPH_UNKNOWN_NODE");
    expect(h.runs).toEqual([]);
  });

  test.each(["constructor", "__proto__", "toString", "hasOwnProperty"] as const)(
    "rejects the inherited object key `%s` as an unknown node (AC-6, F1)",
    async (cursor) => {
      const steps: string[] = [];
      const persisted: GraphState<string>[] = [];
      let ran = 0;
      const graph: WideGraph = { start: "a", end: ["done"], nodes: { a: wideNode(() => (ran += 1)) } };

      const rejection = await caught(
        runStepGraph(graph, ENV, { step: cursor, timings: {} }, wideHooks(steps, persisted), options()),
      );

      assertNaxError(rejection, "runStepGraph rejection");
      expect(rejection.code).toBe("STEP_GRAPH_UNKNOWN_NODE");
      expect(rejection.context?.node).toBe(cursor);
      expect(steps).toEqual([]);
      expect(ran).toBe(0);
      expect(persisted).toEqual([]);
    },
  );
});

describe("runStepGraph: abort", () => {
  test("rejects with the error onAbort returns, before that node's onStep and run (AC-19)", async () => {
    const h = makeHarness();
    const stop = new Error("stopped");
    let polls = 0;
    let abortedNode: Id | undefined;
    const opts = options({
      aborted: () => {
        polls += 1;
        return polls > 1;
      },
      onAbort: (about) => {
        abortedNode = about;
        return stop;
      },
    });

    const rejection = await caught(runStepGraph(threeNodeGraph(h), ENV, graphState("a"), h.hooks, opts));

    expect(rejection).toBe(stop);
    expect(abortedNode).toBe("b");
    expect(h.runs.map((call) => call.node)).toEqual(["a"]);
    expect(h.steps.map((call) => call.node)).toEqual(["a"]);
  });

  test("rejects STEP_GRAPH_ABORTED naming the node about to run when onAbort is absent (AC-20)", async () => {
    const h = makeHarness();

    const rejection = await caught(
      runStepGraph(threeNodeGraph(h), ENV, graphState("b"), h.hooks, options({ aborted: () => true })),
    );

    assertNaxError(rejection, "runStepGraph rejection");
    expect(rejection.code).toBe("STEP_GRAPH_ABORTED");
    expect(rejection.context?.stage).toBe("step-graph");
    expect(rejection.context?.node).toBe("b");
    expect(h.runs).toEqual([]);
    expect(h.steps).toEqual([]);
  });
});

describe("runStepGraph: failures propagate and leave the cursor on the failed node", () => {
  test("a node's rejection propagates unchanged and the last persisted record names it (AC-18)", async () => {
    const h = makeHarness();
    const boom = new Error("boom");
    const graph: TestGraph = {
      start: "a",
      end: ["done"],
      nodes: {
        a: node(h, "a", { transitions: [{ to: "b" }] }),
        b: node(h, "b", {
          transitions: [{ to: "c" }],
          run: async () => {
            throw boom;
          },
        }),
        c: node(h, "c"),
      },
    };

    const rejection = await caught(runStepGraph(graph, ENV, graphState("a"), h.hooks, options()));

    expect(rejection).toBe(boom);
    expect(h.persisted.map((record) => record.step)).toEqual(["b"]);
  });

  test("a persist rejection propagates unchanged and the next node never runs (AC-23)", async () => {
    const disk = new Error("disk");
    const h = makeHarness(async () => {
      throw disk;
    });

    const rejection = await caught(runStepGraph(threeNodeGraph(h), ENV, graphState("a"), h.hooks, options()));

    expect(rejection).toBe(disk);
    expect(h.runs.map((call) => call.node)).toEqual(["a"]);
  });

  test("never mutates the record it was given, timings included (AC-24)", async () => {
    const h = makeHarness();
    const initial = graphState("a", { zzz: 7 });
    const before = structuredClone(initial);

    await runStepGraph(threeNodeGraph(h), ENV, initial, h.hooks, options());

    expect(initial).toEqual(before);
    expect(initial.timings).toEqual({ zzz: 7 });
  });
});
