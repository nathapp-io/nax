/**
 * `src/step-graph` — the aggregate graph validator and `defineStepGraph`.
 *
 * Spec: docs/specs/SPEC-step-graph-g1-engine.md § US-001 (AC-1 … AC-14).
 */
import { describe, expect, test } from "bun:test";
import { assertNaxError } from "@test/helpers";
import { NaxError } from "@/errors";
import {
  type CostStop,
  defineStepGraph,
  ENGINE_KEYS,
  type GraphState,
  type StepGraph,
  type StepKind,
  type StepNode,
  type StepResult,
  type StepTransition,
  validateStepGraph,
} from "@/step-graph";

/**
 * Every id the fixtures mention, deliberately wider than any single graph's node set: a
 * `StepGraph`'s `N` is every id a graph *names*, and validation is what catches a name that
 * no declared node or end id backs (`"missing"`, `"nowhere"`).
 */
type Id = "a" | "b" | "done" | "missing" | "nowhere";

interface TestState extends GraphState<Id> {
  readonly seed?: string;
  readonly costLimited?: boolean;
}

interface TestEnv {
  readonly tag: string;
}

type TestNode = StepNode<TestState, TestEnv, Id>;
type TestGraph = StepGraph<TestState, TestEnv, Id>;

async function runNothing(): Promise<StepResult<TestState>> {
  return { patch: {} };
}

interface NodeOverrides {
  readonly kind?: StepKind;
  readonly commits?: boolean;
  readonly needs?: readonly string[];
  readonly produces?: readonly string[];
  readonly exits?: readonly string[];
  readonly transitions?: readonly StepTransition<TestState, TestEnv, Id>[];
}

/** A valid node: kind `pure`, no produced keys, and a transition straight to the end id `done`. */
function node(overrides: NodeOverrides = {}): TestNode {
  return { kind: "pure", produces: [], transitions: [{ to: "done" }], run: runNothing, ...overrides };
}

/**
 * The graph every case starts from: `a -> b -> done`, both nodes valid. A case replaces only
 * the one declaration it is about, so an error it sees is the rule it names.
 */
function graph(overrides: Partial<TestGraph> = {}): TestGraph {
  return {
    start: "a",
    end: ["done"],
    nodes: { a: node({ transitions: [{ to: "b" }] }), b: node() },
    ...overrides,
  };
}

/** A `costStop` hook that never stops; only its presence matters to validation. */
async function neverStop(): Promise<CostStop<TestState, Id> | undefined> {
  return undefined;
}

/** A graph whose start id is unknown and one of whose nodes declares no transitions. */
function twoErrors(): TestGraph {
  return graph({ start: "missing", nodes: { a: node({ transitions: [] }), b: node() } });
}

describe("the step-graph barrel (AC-1)", () => {
  test("exports the validator, the definer and the engine-owned keys", () => {
    expect(typeof validateStepGraph).toBe("function");
    expect(typeof defineStepGraph).toBe("function");
    expect(ENGINE_KEYS).toEqual(["step", "timings", "lastHead"]);
  });
});

describe("validateStepGraph: a consistent graph", () => {
  test("accepts `a -> b -> done` with start `a` and end `done` (AC-2)", () => {
    expect(validateStepGraph(graph())).toEqual({ errors: [] });
  });
});

describe("validateStepGraph: ids", () => {
  test("reports a start that is neither a node id nor an end id (AC-3)", () => {
    const { errors } = validateStepGraph(graph({ start: "missing" }));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('start "missing"');
  });

  test("reports a transition to an id that is neither a node id nor an end id (AC-4)", () => {
    const { errors } = validateStepGraph(
      graph({ nodes: { a: node({ transitions: [{ to: "nowhere" }] }), b: node() } }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('node "a"');
    expect(errors[0]).toContain('"nowhere"');
  });

  test("reports an end id that is also a node id (AC-6)", () => {
    const { errors } = validateStepGraph(graph({ end: ["done", "a"] }));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"a"');
    expect(errors[0]).toContain("end");
  });
});

describe("validateStepGraph: transitions", () => {
  test("reports a node with no transitions (AC-5)", () => {
    const { errors } = validateStepGraph(graph({ nodes: { a: node({ transitions: [] }), b: node() } }));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('node "a"');
  });

  test("reports a transition `on` the node does not declare as an exit (AC-7)", () => {
    const { errors } = validateStepGraph(
      graph({
        nodes: { a: node({ exits: ["ok"], transitions: [{ to: "b", on: "fail" }] }), b: node() },
      }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('node "a"');
    expect(errors[0]).toContain('"fail"');
  });
});

describe("validateStepGraph: needs", () => {
  /** `b` needs `key`; nothing else in the graph mentions it. */
  const needsKey = (key: string, inputs?: readonly string[]): TestGraph =>
    graph({
      ...(inputs ? { inputs } : {}),
      nodes: { a: node({ transitions: [{ to: "b" }] }), b: node({ needs: [key] }) },
    });

  test("reports a needed key that no input, producer or costStopProduces supplies (AC-8)", () => {
    const { errors } = validateStepGraph(needsKey("seed"));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('node "b"');
    expect(errors[0]).toContain('"seed"');
  });

  test("accepts that key when `graph.inputs` supplies it (AC-8)", () => {
    expect(validateStepGraph(needsKey("seed", ["seed"]))).toEqual({ errors: [] });
  });

  test("accepts a needed engine key with no input or producer for it (AC-8)", () => {
    expect(validateStepGraph(needsKey("lastHead"))).toEqual({ errors: [] });
  });
});

describe("validateStepGraph: engine-owned keys", () => {
  test.each(ENGINE_KEYS.map((key) => [key] as const))("reports `%s` in a node's produces (AC-9)", (key) => {
    const { errors } = validateStepGraph(
      graph({ nodes: { a: node({ produces: [key], transitions: [{ to: "b" }] }), b: node() } }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('node "a"');
    expect(errors[0]).toContain(`"${key}"`);
  });
});

describe("validateStepGraph: the cost stop", () => {
  test("reports an agent node in a graph that defines no costStop (AC-10)", () => {
    const { errors } = validateStepGraph(
      graph({ nodes: { a: node({ kind: "agent", transitions: [{ to: "b" }] }), b: node() } }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('node "a"');
    expect(errors[0]).toContain("costStop");
  });

  test("accepts that agent node once the graph defines costStop and costStopProduces (AC-10)", () => {
    const withCostStop = graph({
      nodes: { a: node({ kind: "agent", transitions: [{ to: "b" }] }), b: node() },
      costStop: neverStop,
      costStopProduces: ["costLimited"],
    });

    expect(validateStepGraph(withCostStop)).toEqual({ errors: [] });
  });

  test("reports costStop defined without costStopProduces (AC-11)", () => {
    const { errors } = validateStepGraph(graph({ costStop: neverStop }));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("costStopProduces");
  });

  test("accepts a node that needs a key costStopProduces declares (AC-11)", () => {
    const stoppable = graph({
      nodes: { a: node({ transitions: [{ to: "b" }] }), b: node({ needs: ["costLimited"] }) },
      costStop: neverStop,
      costStopProduces: ["costLimited"],
    });

    expect(validateStepGraph(stoppable)).toEqual({ errors: [] });
  });

  test("reports an engine key in costStopProduces (AC-11)", () => {
    const { errors } = validateStepGraph(graph({ costStop: neverStop, costStopProduces: ["step"] }));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"step"');
  });
});

describe("validateStepGraph: aggregation", () => {
  test("reports every violation, not only the first (AC-12)", () => {
    const { errors } = validateStepGraph(twoErrors());

    expect(errors).toHaveLength(2);
    expect(errors.some((error) => error.includes('start "missing"'))).toBe(true);
    expect(errors.some((error) => error.includes('node "a"') && error.includes("no transitions"))).toBe(true);
  });
});

describe("defineStepGraph", () => {
  test("returns the graph it was given when validation is clean (AC-13)", () => {
    const valid = graph();

    expect(defineStepGraph(valid)).toBe(valid);
  });

  test("throws STEP_GRAPH_INVALID naming every error when validation fails (AC-14)", () => {
    const invalid = twoErrors();
    const { errors } = validateStepGraph(invalid);
    expect(errors).toHaveLength(2);

    let caught: unknown = null;
    try {
      defineStepGraph(invalid);
    } catch (err) {
      caught = err;
    }

    assertNaxError(caught, "defineStepGraph rejection");
    expect(caught).toBeInstanceOf(NaxError);
    expect(caught.code).toBe("STEP_GRAPH_INVALID");
    expect(caught.context?.stage).toBe("step-graph");
    for (const message of errors) expect(caught.message).toContain(message);
  });
});
