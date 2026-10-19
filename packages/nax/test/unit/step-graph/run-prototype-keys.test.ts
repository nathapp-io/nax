/**
 * `src/step-graph/run.ts` — the runner's prototype-key hardening: a cursor, a node id and a patch
 * key that name a key the object prototype already carries.
 *
 * Split from `run.test.ts` by concern (`<module>-<concern>.test.ts`): `run.test.ts` owns the core
 * loop, `run-policies.test.ts` owns the cost stop and the HEAD/log policies, and this file owns what
 * happens when an id or a record key names an inherited key. `__proto__` is not an engine key, so a
 * graph may legitimately declare one; the record's own fields must survive and its prototype must
 * not become a channel for state a guard can read.
 *
 * Spec: docs/specs/SPEC-step-graph-g1-engine.md § Types (a declared record key), § Runner order
 * steps 2 and 8.
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
} from "@/step-graph";

interface TestEnv {
  readonly tag: string;
}

const ENV: TestEnv = { tag: "env" };

/** The run options a case does not script: nothing aborted, a clock stopped at 0. */
function options<N extends string = string>(over: Partial<StepGraphRunOptions<N>> = {}): StepGraphRunOptions<N> {
  return { aborted: () => false, now: () => 0, ...over };
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

/**
 * A graph whose node ids are plain strings, not a fixture union: the shape a run has when its
 * cursor arrives from persisted state as untrusted runtime data.
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

/** The cursor the inherited-accessor cases name; no graph declares it. */
const INHERITED_CURSOR = "inherited";

/**
 * A graph whose `nodes` table carries an accessor for {@link INHERITED_CURSOR} on its *prototype*,
 * so a lookup of that cursor runs the accessor — or its throw — unless the runner checks ownership
 * before it reads. A graph declaring one ordinary node `a` keeps the graph valid.
 */
function protoAccessorGraph(getter: () => StepNode<GraphState<string>, TestEnv, string>): WideGraph {
  const proto = Object.defineProperty({}, INHERITED_CURSOR, { configurable: true, get: getter });
  const nodes: Record<string, StepNode<GraphState<string>, TestEnv, string>> = Object.assign(Object.create(proto), {
    a: wideNode(),
  });
  return { start: "a", end: ["done"], nodes };
}

/**
 * A record open to any key, so a patch literal can name one no interface declares. `__proto__` is
 * such a key: a graph may legitimately put it in its record, and a patch that writes it must store
 * it as an ordinary field rather than run the inherited setter.
 */
type OpenState = GraphState<string> & { readonly [key: string]: unknown };

/** The value a `__proto__` patch carries: an object whose own fields would become *inherited*. */
const INJECTED = { flag: true };

/** Hooks for an open record: records the record each node persisted. */
function openHooks(persisted: OpenState[]): StepGraphHooks<OpenState, string> {
  return {
    persist: async (next) => {
      persisted.push(next);
    },
  };
}

/**
 * `a` declares `__proto__` and patches it with {@link INJECTED}; its guard goes to `x` only if it
 * can *read* `flag`, which is the inheritance a prototype write would inject.
 */
function protoPatchGraph(): StepGraph<OpenState, TestEnv, string> {
  return {
    start: "a",
    end: ["x", "y"],
    nodes: {
      a: {
        kind: "pure",
        produces: ["__proto__"],
        transitions: [{ to: "x", when: (state) => state.flag === true }, { to: "y" }],
        run: async () => ({ patch: { ["__proto__"]: INJECTED } }),
      },
    },
  };
}

describe("runStepGraph: an unrecordable inherited cursor (AC-6, F1)", () => {
  test.each(["constructor", "__proto__", "toString", "hasOwnProperty"] as const)(
    "rejects the inherited object key `%s` as an unknown node",
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

describe("runStepGraph: a node id that shadows a prototype key (F1)", () => {
  test("records its timing as its own number, not as an inherited value", async () => {
    let tick = 0;
    const now = () => {
      const value = tick;
      tick += 5;
      return value;
    };
    const graph: WideGraph = {
      start: "constructor",
      end: ["done"],
      nodes: { ["constructor"]: wideNode() },
    };

    const result = await runStepGraph(
      graph,
      ENV,
      { step: "constructor", timings: {} },
      wideHooks([], []),
      options({ now }),
    );

    expect(result.timings["constructor"]).toBe(5);
    expect(Object.keys(result.timings)).toEqual(["constructor"]);
  });
});

describe("runStepGraph: an inherited accessor on the node table (F1)", () => {
  test("rejects the cursor without ever reading the accessor", async () => {
    const runs: string[] = [];
    const graph = protoAccessorGraph(() => {
      runs.push("getter");
      return wideNode();
    });

    const rejection = await caught(
      runStepGraph(graph, ENV, { step: INHERITED_CURSOR, timings: {} }, wideHooks([], []), options()),
    );

    assertNaxError(rejection, "runStepGraph rejection");
    expect(rejection.code).toBe("STEP_GRAPH_UNKNOWN_NODE");
    expect(rejection.context?.node).toBe(INHERITED_CURSOR);
    expect(runs).toEqual([]);
  });

  test("rejects the cursor with its own error rather than the accessor's", async () => {
    const inherited = new Error("inherited getter ran");
    const graph = protoAccessorGraph(() => {
      throw inherited;
    });

    const rejection = await caught(
      runStepGraph(graph, ENV, { step: INHERITED_CURSOR, timings: {} }, wideHooks([], []), options()),
    );

    assertNaxError(rejection, "runStepGraph rejection");
    expect(rejection.code).toBe("STEP_GRAPH_UNKNOWN_NODE");
    expect(rejection).not.toBe(inherited);
  });
});

describe("runStepGraph: a patch key that names the prototype (AC-8, B1)", () => {
  test("keeps a declared `__proto__` patch as the record's own field", async () => {
    const persisted: OpenState[] = [];

    await runStepGraph(protoPatchGraph(), ENV, { step: "a", timings: {} }, openHooks(persisted), options());

    const record = persisted[0];
    expect(Object.hasOwn(record, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(record, "__proto__")?.value).toBe(INJECTED);
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
  });

  test("does not let a `__proto__` patch inject a field the guard can read", async () => {
    const persisted: OpenState[] = [];

    const result = await runStepGraph(
      protoPatchGraph(),
      ENV,
      { step: "a", timings: {} },
      openHooks(persisted),
      options(),
    );

    expect(result.flag).toBeUndefined();
    expect(result.step).toBe("y");
  });
});
