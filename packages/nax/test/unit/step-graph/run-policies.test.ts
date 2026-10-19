/**
 * `src/step-graph/run.ts` — the runner's policies: the cost stop, `lastHead` after a committing
 * node, and the opt-in step lines (spec § Runner order steps 6 and 9, § Step log lines).
 *
 * Split from `run.test.ts` by concern (`<module>-<concern>.test.ts`): US-002 owns the core loop,
 * this file owns what the runner does around it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertNaxError } from "@test/helpers";
import { formatDuration } from "@/log-format";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import {
  type CostStop,
  type GraphState,
  runStepGraph,
  type StepGraph,
  type StepGraphHooks,
  type StepGraphRunOptions,
  type StepKind,
  type StepNode,
  type StepResult,
  type StepTransition,
} from "@/step-graph";

/**
 * Every id these fixtures name. `nowhere` is deliberately backed by nothing — a node id no graph
 * declares and no end id either — because the cost-stop cases need an unknown destination.
 */
type Id = "a" | "b" | "c" | "gate" | "done" | "final" | "nowhere";

/** The record keys these fixtures may patch. */
interface TestState extends GraphState<Id> {
  readonly costLimited?: boolean;
  readonly other?: number;
}

interface TestEnv {
  readonly tag: string;
}

const ENV: TestEnv = { tag: "env" };

type TestNode = StepNode<TestState, TestEnv, Id>;
type TestGraph = StepGraph<TestState, TestEnv, Id>;
type TestHooks = StepGraphHooks<TestState, Id>;
type TestOptions = StepGraphRunOptions<Id>;
type TestStop = CostStop<TestState, Id>;

/** Every callback the runner makes, recorded so a case can assert order as well as occurrence. */
interface Harness {
  /** `onStep:a`, `run:a`, `head`, `now:1`, `persist:done` — whatever the case needs to order. */
  readonly order: string[];
  readonly runs: Id[];
  readonly persisted: TestState[];
  readonly hooks: TestHooks;
}

function makeHarness(): Harness {
  const order: string[] = [];
  const runs: Id[] = [];
  const persisted: TestState[] = [];
  const hooks: TestHooks = {
    persist: async (next) => {
      persisted.push(next);
      order.push(`persist:${next.step}`);
    },
    onStep: (id) => {
      order.push(`onStep:${id}`);
    },
  };
  return { order, runs, persisted, hooks };
}

const noPatch = async (): Promise<StepResult<TestState>> => ({ patch: {} });

interface NodeSpec {
  readonly kind?: StepKind;
  readonly commits?: boolean;
  readonly produces?: readonly string[];
  readonly transitions?: readonly StepTransition<TestState, TestEnv, Id>[];
  readonly run?: TestNode["run"];
}

/** A node that records its own call; `spec` replaces any declaration the case is about. */
function node(h: Harness, id: Id, spec: NodeSpec = {}): TestNode {
  const run = spec.run ?? noPatch;
  return {
    kind: spec.kind ?? "pure",
    produces: spec.produces ?? [],
    transitions: spec.transitions ?? [{ to: "done" }],
    ...(spec.commits === undefined ? {} : { commits: spec.commits }),
    run: async (env, state) => {
      h.runs.push(id);
      h.order.push(`run:${id}`);
      return run(env, state);
    },
  };
}

/** One recorded `graph.costStop` call. */
interface StopCall {
  readonly node: Id;
  readonly state: TestState;
  readonly env: TestEnv;
}

interface StopSpy {
  readonly calls: StopCall[];
  costStop(node: Id, state: TestState, env: TestEnv): Promise<TestStop | undefined>;
}

/** A `graph.costStop` that records every call and answers from `answer`. */
function costStopSpy(answer: (node: Id, state: TestState) => TestStop | undefined): StopSpy {
  const calls: StopCall[] = [];
  return {
    calls,
    costStop: async (node, state, env) => {
      calls.push({ node, state, env });
      return answer(node, state);
    },
  };
}

/**
 * One `agent` node `a` whose single transition ends the run at `final`, so the cost stop is the
 * only thing that can decide the cursor.
 */
function agentGraph(h: Harness, spy: StopSpy, produces: readonly string[] = ["costLimited"]): TestGraph {
  return {
    start: "a",
    end: ["final"],
    costStopProduces: produces,
    costStop: spy.costStop,
    nodes: { a: node(h, "a", { kind: "agent", transitions: [{ to: "final" }] }) },
  };
}

/** A clock that hands out `0, step, 2*step …`, records each read on `h.order`, and counts them. */
function clock(h: Harness, step = 5): { now: () => number; reads: () => number } {
  let tick = 0;
  let count = 0;
  return {
    now: () => {
      const value = tick;
      h.order.push(`now:${count}`);
      tick += step;
      count += 1;
      return value;
    },
    reads: () => count,
  };
}

/** A `readHead` that records the call, answers `head`, and counts. */
function readHeadOf(
  h: Harness,
  head: string | undefined | Error,
): { readHead: () => Promise<string | undefined>; calls: () => number } {
  let count = 0;
  return {
    readHead: async () => {
      count += 1;
      h.order.push("head");
      if (head instanceof Error) throw head;
      return head;
    },
    calls: () => count,
  };
}

/** The run options a case does not script: nothing aborted, a clock stopped at 0. */
function options(over: Partial<TestOptions> = {}): TestOptions {
  return { aborted: () => false, now: () => 0, ...over };
}

function state(step: Id, over: Partial<TestState> = {}): TestState {
  return { step, timings: {}, ...over };
}

/**
 * A record open to any key, so a cost-stop patch can name one no interface declares. `__proto__`
 * is such a key: writing it must store an ordinary field, not run the inherited setter.
 */
type OpenState = GraphState<string> & { readonly [key: string]: unknown };

/** The value a `__proto__` cost-stop patch carries: fields that would become *inherited*. */
const INJECTED = { flag: true };

/**
 * `a` is an `agent` node whose cost stop patches `__proto__` and sends the run to `b`. `b`'s guard
 * goes to `x` only if it can *read* `flag` — the inheritance a prototype write would inject into
 * the record `a` persisted.
 */
function protoStopGraph(ran: string[]): StepGraph<OpenState, TestEnv, string> {
  return {
    start: "a",
    end: ["x", "y"],
    costStopProduces: ["__proto__"],
    costStop: async () => ({ patch: { ["__proto__"]: INJECTED }, to: "b" }),
    nodes: {
      a: {
        kind: "agent",
        produces: [],
        transitions: [{ to: "b" }],
        run: async () => {
          ran.push("a");
          return { patch: {} };
        },
      },
      b: {
        kind: "pure",
        produces: [],
        transitions: [{ to: "x", when: (state) => state.flag === true }, { to: "y" }],
        run: async () => ({ patch: {} }),
      },
    },
  };
}

/** The rejection `promise` produced, so a case can assert the run rejected at all. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the run to reject");
}

let logs: LogEntry[] = [];
beforeEach(() => {
  resetLogger();
  logs = [];
  initLogger({ level: "silent" });
  addSink((entry) => logs.push(entry));
});
afterEach(() => resetLogger());

/** The entries the engine wrote, on its own stage and no other. */
const engineLines = (level?: LogEntry["level"]): LogEntry[] =>
  logs.filter((entry) => entry.stage === "step-graph" && (level === undefined || entry.level === level));

describe("runStepGraph: the cost stop (spec step 6)", () => {
  test("an agent node past the limit is not run; its cost patch is persisted and the cursor is `to` (AC-1)", async () => {
    const h = makeHarness();
    const spy = costStopSpy(() => ({ patch: { costLimited: true }, to: "final" }));
    const initial = state("a");

    const result = await runStepGraph(agentGraph(h, spy), ENV, initial, h.hooks, options({ costExceeded: () => true }));

    expect(h.runs).toEqual([]);
    expect(h.persisted.map((record) => record.step)).toEqual(["final"]);
    expect(h.persisted[0].costLimited).toBe(true);
    expect(result.step).toBe("final");
    expect(spy.calls.map((call) => call.node)).toEqual(["a"]);
    expect(spy.calls[0].state).toBe(initial);
    expect(spy.calls[0].env).toBe(ENV);
  });

  test("a cost stop that answers undefined runs the node and lets its transitions decide (AC-2)", async () => {
    const h = makeHarness();
    const spy = costStopSpy(() => undefined);
    const graph: TestGraph = {
      start: "a",
      end: ["done"],
      costStopProduces: [],
      costStop: spy.costStop,
      nodes: {
        a: node(h, "a", { kind: "agent", transitions: [{ to: "b" }] }),
        b: node(h, "b", { transitions: [{ to: "done" }] }),
      },
    };

    const result = await runStepGraph(graph, ENV, state("a"), h.hooks, options({ costExceeded: () => true }));

    expect(spy.calls.map((call) => call.node)).toEqual(["a"]);
    expect(h.runs).toEqual(["a", "b"]);
    expect(h.persisted.map((record) => record.step)).toEqual(["b", "done"]);
    expect(result.step).toBe("done");
  });

  test("a gate node runs past the limit, and the cost stop is never asked about it (AC-3)", async () => {
    const h = makeHarness();
    const spy = costStopSpy(() => ({ patch: { costLimited: true }, to: "final" }));
    const graph: TestGraph = {
      start: "gate",
      end: ["final"],
      costStopProduces: ["costLimited"],
      costStop: spy.costStop,
      nodes: {
        gate: node(h, "gate", { kind: "gate", transitions: [{ to: "a" }] }),
        a: node(h, "a", { kind: "agent", transitions: [{ to: "final" }] }),
      },
    };

    await runStepGraph(graph, ENV, state("gate"), h.hooks, options({ costExceeded: () => true }));

    expect(h.runs).toContain("gate");
    expect(spy.calls.map((call) => call.node)).toEqual(["a"]);
    expect(h.persisted.map((record) => record.step)).toEqual(["a", "final"]);
  });

  test("without options.costExceeded the graph never asks its cost stop and every agent node runs (AC-4)", async () => {
    const h = makeHarness();
    const spy = costStopSpy(() => ({ patch: { costLimited: true }, to: "done" }));
    const graph: TestGraph = {
      start: "a",
      end: ["done"],
      costStop: spy.costStop,
      costStopProduces: ["costLimited"],
      nodes: {
        a: node(h, "a", { kind: "agent", transitions: [{ to: "b" }] }),
        b: node(h, "b", { kind: "agent", transitions: [{ to: "done" }] }),
      },
    };

    const result = await runStepGraph(graph, ENV, state("a"), h.hooks, options());

    expect(spy.calls).toEqual([]);
    expect(h.runs).toEqual(["a", "b"]);
    expect(h.persisted.map((record) => record.step)).toEqual(["b", "done"]);
    expect(result.costLimited).toBeUndefined();

    // The control run: the same graph, the same spy, and the only difference is `costExceeded`
    // answering true. Without it the assertion above cannot fail — an absence holds for a runner
    // that never consults the hook at all — so the pair is what pins the gate (dropped → the first
    // half sees a call; inverted → the second half sees none).
    const control = makeHarness();
    await runStepGraph(graph, ENV, state("a"), control.hooks, options({ costExceeded: () => true }));

    expect(spy.calls.map((call) => call.node)).toEqual(["a"]);
    expect(control.runs).toEqual([]);
    expect(control.persisted.map((record) => record.step)).toEqual(["done"]);
  });

  test("a destination that is neither a node id nor an end id rejects STEP_GRAPH_UNKNOWN_NODE (AC-5)", async () => {
    const h = makeHarness();
    const spy = costStopSpy(() => ({ patch: {}, to: "nowhere" }));

    const rejection = await caught(
      runStepGraph(agentGraph(h, spy), ENV, state("a"), h.hooks, options({ costExceeded: () => true })),
    );

    assertNaxError(rejection, "runStepGraph rejection");
    expect(rejection.code).toBe("STEP_GRAPH_UNKNOWN_NODE");
    expect(rejection.context?.stage).toBe("step-graph");
    expect(rejection.context?.node).toBe("nowhere");
    expect(h.persisted).toEqual([]);
  });

  test("a destination that is an end id ends the run at the next iteration (AC-6)", async () => {
    const h = makeHarness();
    const spy = costStopSpy(() => ({ patch: {}, to: "done" }));
    const graph: TestGraph = {
      start: "a",
      end: ["done"],
      costStopProduces: [],
      costStop: spy.costStop,
      nodes: {
        a: node(h, "a", { kind: "agent", transitions: [{ to: "b" }] }),
        b: node(h, "b"),
      },
    };

    const result = await runStepGraph(graph, ENV, state("a"), h.hooks, options({ costExceeded: () => true }));

    expect(h.persisted.map((record) => record.step)).toEqual(["done"]);
    expect(h.runs).toEqual([]);
    expect(result.step).toBe("done");
  });

  test("a patch key outside costStopProduces rejects STEP_GRAPH_UNDECLARED_OUTPUT, naming it (AC-7)", async () => {
    const h = makeHarness();
    const spy = costStopSpy(() => ({ patch: { other: 1 }, to: "final" }));

    const rejection = await caught(
      runStepGraph(agentGraph(h, spy), ENV, state("a"), h.hooks, options({ costExceeded: () => true })),
    );

    assertNaxError(rejection, "runStepGraph rejection");
    expect(rejection.code).toBe("STEP_GRAPH_UNDECLARED_OUTPUT");
    expect(rejection.message).toContain('"other"');
    expect(h.persisted).toEqual([]);
  });

  test("a cost-stopped node still records its elapsed time under its own id (AC-8)", async () => {
    const h = makeHarness();
    const spy = costStopSpy(() => ({ patch: { costLimited: true }, to: "final" }));
    const tick = clock(h);

    const result = await runStepGraph(
      agentGraph(h, spy),
      ENV,
      state("a"),
      h.hooks,
      options({ now: tick.now, costExceeded: () => true }),
    );

    expect(h.runs).toEqual([]);
    expect(h.persisted[0].timings).toEqual({ a: 5 });
    expect(result.timings).toEqual({ a: 5 });
    expect(tick.reads()).toBe(2);
  });
});

describe("runStepGraph: a cost-stop patch that names the prototype (B1)", () => {
  /** The record the reference run persists, ready for the shared assertions. */
  async function runProtoStop(): Promise<{ persisted: OpenState[]; ran: string[]; result: OpenState }> {
    const persisted: OpenState[] = [];
    const ran: string[] = [];
    const hooks: StepGraphHooks<OpenState, string> = {
      persist: async (next) => {
        persisted.push(next);
      },
    };

    const result = await runStepGraph(
      protoStopGraph(ran),
      ENV,
      { step: "a", timings: {} },
      hooks,
      options({ costExceeded: () => true }),
    );
    return { persisted, ran, result };
  }

  test("keeps a declared `__proto__` patch as the record's own field", async () => {
    const { persisted, ran } = await runProtoStop();

    expect(ran).toEqual([]);
    const record = persisted[0];
    expect(record.step).toBe("b");
    expect(Object.hasOwn(record, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(record, "__proto__")?.value).toBe(INJECTED);
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    // The fields of the patched value stay behind the field itself: nothing is inherited.
    expect(record.flag).toBeUndefined();
  });

  test("does not let it inject a field the next node's guard can read", async () => {
    const { result } = await runProtoStop();

    expect(result.flag).toBeUndefined();
    expect(result.step).toBe("y");
  });
});

describe("runStepGraph: lastHead after a committing node (spec step 9)", () => {
  test("reads HEAD once, after the run and before the second clock read, and records it (AC-9)", async () => {
    const h = makeHarness();
    const tick = clock(h);
    const head = readHeadOf(h, "h1");
    const graph: TestGraph = {
      start: "a",
      end: ["done"],
      nodes: { a: node(h, "a", { commits: true }) },
    };

    const result = await runStepGraph(
      graph,
      ENV,
      state("a"),
      h.hooks,
      options({ now: tick.now, readHead: head.readHead }),
    );

    expect(head.calls()).toBe(1);
    expect(h.order.indexOf("run:a")).toBeLessThan(h.order.indexOf("head"));
    expect(h.order.indexOf("head")).toBeLessThan(h.order.indexOf("now:1"));
    expect(h.persisted[0].lastHead).toBe("h1");
    expect(result.lastHead).toBe("h1");
  });

  test.each([
    ["undefined", undefined],
    ["the empty string", ""],
  ])("a read that resolves to %s keeps the lastHead the record already had (AC-10)", async (_label, answer) => {
    const h = makeHarness();
    const head = readHeadOf(h, answer);
    const graph: TestGraph = {
      start: "a",
      end: ["done"],
      nodes: { a: node(h, "a", { commits: true }) },
    };

    const result = await runStepGraph(
      graph,
      ENV,
      state("a", { lastHead: "h0" }),
      h.hooks,
      options({ readHead: head.readHead }),
    );

    expect(head.calls()).toBe(1);
    expect(h.persisted[0].lastHead).toBe("h0");
    expect(result.lastHead).toBe("h0");
  });

  test("a rejecting read keeps the previous lastHead, warns once and lets the run continue (AC-11)", async () => {
    const h = makeHarness();
    const head = readHeadOf(h, new Error("no head"));
    const graph: TestGraph = {
      start: "a",
      end: ["done"],
      nodes: {
        a: node(h, "a", { commits: true, transitions: [{ to: "b" }] }),
        b: node(h, "b", { transitions: [{ to: "done" }] }),
      },
    };

    const result = await runStepGraph(
      graph,
      ENV,
      state("a", { lastHead: "h0" }),
      h.hooks,
      options({ readHead: head.readHead }),
    );

    expect(h.runs).toEqual(["a", "b"]);
    expect(h.persisted.map((record) => record.step)).toEqual(["b", "done"]);
    expect(result.lastHead).toBe("h0");
    const warns = engineLines("warn");
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toBe("Could not read HEAD after committing node a; the record keeps the last one");
    expect(warns[0].data).toEqual({ storyId: "_run", node: "a", error: "no head" });
  });

  test("is not read after a node without commits, only after the committing one (AC-12)", async () => {
    const h = makeHarness();
    const head = readHeadOf(h, "h1");
    const graph: TestGraph = {
      start: "a",
      end: ["done"],
      nodes: {
        a: node(h, "a", { transitions: [{ to: "b" }] }),
        b: node(h, "b", { commits: true, transitions: [{ to: "done" }] }),
      },
    };

    await runStepGraph(graph, ENV, state("a"), h.hooks, options({ readHead: head.readHead }));

    expect(head.calls()).toBe(1);
    expect(h.order.indexOf("run:b")).toBeLessThan(h.order.indexOf("head"));
    expect(h.persisted.map((record) => record.lastHead)).toEqual([undefined, "h1"]);
  });

  test("is not read after a committing agent node the cost stop substituted for (AC-12)", async () => {
    const h = makeHarness();
    const head = readHeadOf(h, "h1");
    const spy = costStopSpy(() => ({ patch: { costLimited: true }, to: "final" }));
    const graph: TestGraph = {
      ...agentGraph(h, spy),
      nodes: { a: node(h, "a", { kind: "agent", commits: true, transitions: [{ to: "final" }] }) },
    };

    const result = await runStepGraph(
      graph,
      ENV,
      state("a", { lastHead: "h0" }),
      h.hooks,
      options({ readHead: head.readHead, costExceeded: () => true }),
    );

    expect(h.runs).toEqual([]);
    expect(h.persisted[0].costLimited).toBe(true);
    expect(head.calls()).toBe(0);
    expect(result.lastHead).toBe("h0");
  });
});

describe("runStepGraph: step log lines (spec § Step log lines)", () => {
  test("a node that runs logs `start` before it and `done` with its duration after (AC-13)", async () => {
    const h = makeHarness();
    const tick = clock(h);
    let linesAtRun: string[] = [];
    const graph: TestGraph = {
      start: "a",
      end: ["done"],
      nodes: {
        a: node(h, "a", {
          run: async () => {
            linesAtRun = engineLines().map((entry) => entry.message);
            return { patch: {} };
          },
        }),
      },
    };

    const result = await runStepGraph(graph, ENV, state("a"), h.hooks, options({ now: tick.now, logScope: "_run" }));

    const elapsed = result.timings.a;
    expect(linesAtRun).toEqual(["a start"]);
    const lines = engineLines("info");
    expect(lines.map((entry) => entry.message)).toEqual(["a start", `a: done  ${formatDuration(elapsed)}`]);
    expect(lines[0].data).toEqual({ storyId: "_run", step: "a" });
    expect(lines[1].data).toEqual({ storyId: "_run", step: "a", durationMs: elapsed });
    expect(lines[1].data?.durationMs).toBe(5);
  });

  test("a cost-stopped node logs one skipped line and no start line (AC-14)", async () => {
    const h = makeHarness();
    const tick = clock(h);
    const spy = costStopSpy(() => ({ patch: { costLimited: true }, to: "final" }));

    await runStepGraph(
      agentGraph(h, spy),
      ENV,
      state("a"),
      h.hooks,
      options({ now: tick.now, costExceeded: () => true, logScope: "US-9" }),
    );

    const lines = engineLines();
    expect(lines.map((entry) => entry.message)).toEqual(["a: skipped (cost limit reached)  5ms"]);
    expect(lines[0].level).toBe("info");
    expect(lines[0].data).toEqual({ storyId: "US-9", step: "a", durationMs: 5 });
  });

  test("with no logScope a run that runs, commits and cost-stops writes no line at all (AC-15)", async () => {
    const h = makeHarness();
    const tick = clock(h);
    const head = readHeadOf(h, "h1");
    const spy = costStopSpy((id) => (id === "c" ? { patch: { costLimited: true }, to: "done" } : undefined));
    const graph: TestGraph = {
      start: "a",
      end: ["done"],
      costStopProduces: ["costLimited"],
      costStop: spy.costStop,
      nodes: {
        a: node(h, "a", { kind: "agent", transitions: [{ to: "b" }] }),
        b: node(h, "b", { commits: true, transitions: [{ to: "c" }] }),
        c: node(h, "c", { kind: "agent" }),
      },
    };

    const result = await runStepGraph(
      graph,
      ENV,
      state("a"),
      h.hooks,
      options({ now: tick.now, readHead: head.readHead, costExceeded: () => true }),
    );

    expect(engineLines()).toEqual([]);
    expect(h.runs).toEqual(["a", "b"]);
    expect(h.persisted.map((record) => record.step)).toEqual(["b", "c", "done"]);
    expect(h.persisted[1].lastHead).toBe("h1");
    expect(tick.reads()).toBe(6);
    expect(result.step).toBe("done");
  });
});
