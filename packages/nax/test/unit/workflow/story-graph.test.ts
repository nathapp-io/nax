/**
 * G3 (step-graph): the story workflow's graph data, its cost stop and its nodes.
 *
 * The declarations are the port's contract with the G0 goldens: the same seam calls in the same
 * order, so the node table, the transitions and the two-point cost rule are pinned here. The nodes
 * are exercised directly, with the arguments in the engine's order (`run(env, state)`), while the
 * cost hook keeps its own (`costStop(node, state, env)`).
 */
import { describe, expect, mock, test } from "bun:test";
import { failingReview, makeStoryLoopAdvisor, makeStoryLoopHarness, storyLoopFixtures } from "@test/helpers";
import { type StepKind, type StepNode, validateStepGraph } from "@/step-graph";
import type { ResidualAnswer, ResidualRequest } from "@/workflow/advisor";
import type { ImplementOutcome } from "@/workflow/implement";
import type { LedgerWriteOptions } from "@/workflow/ledger";
import { STORY_GRAPH } from "@/workflow/story-graph";
import type { StoryLoopEnv, StoryLoopState, StoryNode } from "@/workflow/story-loop";
import { closeStep, evaluateStep, implementStep, initialStoryState, residualStep } from "@/workflow/story-steps";
import type { WorkflowFinding, WorkflowStoryRecord } from "@/workflow/types";

const NODE_IDS = ["implement", "evaluate", "residual", "fix", "close"] as const;
type NodeId = (typeof NODE_IDS)[number];

/** The node an id names; a missing node is a broken graph, not a value to cast around. */
function nodeFor(id: NodeId): StepNode<StoryLoopState, StoryLoopEnv, StoryNode> {
  const node = STORY_GRAPH.nodes[id];
  if (node === undefined) throw new Error(`Missing graph node: ${id}`);
  return node;
}

const EXPECTED_KINDS: Record<NodeId, StepKind> = {
  implement: "agent",
  evaluate: "agent",
  residual: "agent",
  fix: "agent",
  close: "pure",
};
const EXPECTED_PRODUCES: Record<NodeId, string[]> = {
  implement: ["pendingSession", "nextId", "questions", "concerns", "closeAs", "lastTurn"],
  evaluate: [
    "suiteThisIteration",
    "gates",
    "suite",
    "nextId",
    "reviewed",
    "unreviewed",
    "deferredMinors",
    "reviewOpen",
    "fixBase",
    "open",
    "pendingSession",
    "reportTurnRan",
  ],
  residual: ["suite", "rulings"],
  fix: ["round", "firstAfterResume", "fixBase", "pendingSession", "nextId", "questions", "concerns", "lastTurn"],
  close: ["outcome"],
};
const EXPECTED_TRANSITIONS: Record<NodeId, { on?: string; to: StoryNode }[]> = {
  implement: [
    { on: "worked", to: "evaluate" },
    { on: "no-work", to: "close" },
  ],
  evaluate: [
    { on: "clean", to: "close" },
    { on: "capped", to: "residual" },
    { on: "open", to: "fix" },
  ],
  residual: [{ to: "close" }],
  fix: [{ to: "evaluate" }],
  close: [{ to: "done" }],
};
const EXPECTED_EXITS: Partial<Record<NodeId, string[]>> = {
  implement: ["worked", "no-work"],
  evaluate: ["clean", "capped", "open"],
};

/** A finding the residual node rules on. */
const OPEN_FINDING: WorkflowFinding = { id: "F1", kind: "spec", severity: "important", issue: "issue one" };

/** The implementer reply a no-work turn carries: DONE with no status block at all. */
const NO_STATUS: ImplementOutcome = {
  reply: { status: "DONE", commits: [], testSummary: "", interrupted: false, noStatusBlock: true },
  autoCommitted: false,
};

describe("STORY_GRAPH", () => {
  test("AC-1/AC-2/AC-3: validates, starts at implement and ends at done", () => {
    expect(validateStepGraph(STORY_GRAPH)).toEqual({ errors: [] });
    expect(STORY_GRAPH.start).toBe("implement");
    expect(STORY_GRAPH.end).toEqual(["done"]);
  });

  test("AC-4: every node carries the node table's kind, so exactly four are agent nodes", () => {
    for (const id of NODE_IDS) expect(nodeFor(id).kind).toBe(EXPECTED_KINDS[id]);
    expect(
      NODE_IDS.filter((id) => nodeFor(id).kind === "agent").toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["evaluate", "fix", "implement", "residual"]);
    expect(nodeFor("close").kind).toBe("pure");
  });

  test("AC-5: no node commits, because the story loop keeps no lastHead", () => {
    expect(NODE_IDS.filter((id) => nodeFor(id).commits === true)).toEqual([]);
  });

  test("AC-6/AC-7: every node produces the node table's keys, and the cost stop produces costLimited", () => {
    for (const id of NODE_IDS) expect([...nodeFor(id).produces].sort()).toEqual([...EXPECTED_PRODUCES[id]].sort());
    expect(STORY_GRAPH.costStopProduces).toEqual(["costLimited"]);
  });

  test("AC-8: every node's transitions are the transitions table's rows, in table order", () => {
    for (const id of NODE_IDS) {
      expect(nodeFor(id).transitions.map(({ on, to }) => (on === undefined ? { to } : { on, to }))).toEqual(
        EXPECTED_TRANSITIONS[id],
      );
    }
  });

  test("AC-9: exits are the exit labels, and absent on the nodes whose only row is unconditional", () => {
    for (const id of NODE_IDS) {
      const exits = nodeFor(id).exits;
      if (EXPECTED_EXITS[id]) expect([...(exits ?? [])].sort()).toEqual([...EXPECTED_EXITS[id]].sort());
      else expect(exits).toBeUndefined();
    }
  });
});

/** An env whose cost seam is a spy, and whose sink records the two writes the cost stop must not make. */
function costEnv(exceeded: boolean) {
  const update = mock(async (_patch: Partial<WorkflowStoryRecord>) => {});
  const ledger = mock(async (_text: string, _options?: LedgerWriteOptions) => {});
  const costExceeded = mock(() => exceeded);
  const base = makeStoryLoopHarness({}, { steps: { costExceeded } }).env;
  const env: StoryLoopEnv = { ...base, sink: { update, ledger } };
  return { env, state: initialStoryState(env), costExceeded, update, ledger };
}

describe("STORY_GRAPH.costStop", () => {
  test("AC-10/AC-11/AC-12/AC-13 (row 2a): evaluate past the limit closes with costLimited, silently", async () => {
    const { env, state, costExceeded, update, ledger } = costEnv(true);
    expect(await STORY_GRAPH.costStop?.("evaluate", state, env)).toEqual({
      patch: { costLimited: true },
      to: "close",
    });
    expect(costExceeded).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(ledger).not.toHaveBeenCalled();
  });

  test("AC-14/AC-15: fix under the limit runs, after exactly one cost check", async () => {
    const { env, state, costExceeded } = costEnv(false);
    expect(await STORY_GRAPH.costStop?.("fix", state, env)).toBeUndefined();
    expect(costExceeded).toHaveBeenCalledTimes(1);
  });

  test("AC-16/AC-17: implement and residual never ask the cost seam", async () => {
    const { env, state, costExceeded } = costEnv(true);
    for (const node of ["implement", "residual"] as const) {
      expect(await STORY_GRAPH.costStop?.(node, state, env)).toBeUndefined();
    }
    expect(costExceeded).not.toHaveBeenCalled();
  });
});

describe("implementStep", () => {
  test("AC-37/AC-38: a no-work ladder exit returns the no-work exit and closeAs", async () => {
    const h = makeStoryLoopHarness({ implement: () => NO_STATUS }, { steps: { workProduced: async () => false } });
    const result = await implementStep(h.env, initialStoryState(h.env));
    expect(result.exit).toBe("no-work");
    expect(result.patch.closeAs).toEqual({ state: "complete-gate-open", reason: "no work produced" });
  });
});

describe("evaluateStep", () => {
  test("AC-33/AC-34: at the fix-round cap it returns capped and never mutates the state it was handed", async () => {
    const h = makeStoryLoopHarness({ review: [failingReview(1)] }, { maxFixRounds: 2 });
    const state: StoryLoopState = { ...initialStoryState(h.env), step: "evaluate", round: 2 };
    const before = structuredClone(state);
    const result = await evaluateStep(h.env, state);
    expect(result.exit).toBe("capped");
    expect(state).toEqual(before);
  });

  test("AC-35/AC-36: with a round left it returns open and the open finding in its patch", async () => {
    const h = makeStoryLoopHarness({ review: [failingReview(1)] }, { maxFixRounds: 2 });
    const state: StoryLoopState = { ...initialStoryState(h.env), step: "evaluate", round: 1 };
    const result = await evaluateStep(h.env, state);
    expect(result.exit).toBe("open");
    expect(result.patch.open).toHaveLength(1);
    expect(result.patch.open?.[0]?.severity).toBe("important");
  });
});

describe("residualStep", () => {
  /** The residual node's own env: a green gate set, a spied full suite and a spied advisor. */
  function residualHarness() {
    const ruleResidual = mock(
      (req: ResidualRequest): Promise<ResidualAnswer> =>
        Promise.resolve({
          rulings: req.items.map((f) => ({
            findingId: f.id,
            action: "waive" as const,
            text: `waive ${f.id}`,
            why: "out of scope",
            costIfWrong: "the finding ships",
            source: "advisor" as const,
          })),
          diagnoses: {},
        }),
    );
    const h = makeStoryLoopHarness({}, { maxFixRounds: 2, advisor: makeStoryLoopAdvisor({ ruleResidual }) });
    const suite = mock(async () => storyLoopFixtures.SUITE_GREEN);
    h.env.steps.fullSuite = suite;
    const state: StoryLoopState = {
      ...initialStoryState(h.env),
      step: "residual",
      round: 2,
      gates: storyLoopFixtures.GREEN,
      suiteThisIteration: false,
      open: [OPEN_FINDING],
    };
    return { h, state, suite, ruleResidual };
  }

  test("AC-43/AC-45/AC-46: runs the suite once, returns no exit and the suite it ran", async () => {
    const { h, state, suite } = residualHarness();
    const result = await residualStep(h.env, state);
    expect(suite).toHaveBeenCalledTimes(1);
    expect(result.exit).toBeUndefined();
    expect(result.patch.suite).toBe(storyLoopFixtures.SUITE_GREEN);
  });

  test("AC-44/AC-47: asks the advisor to rule, and patches the rulings it returned", async () => {
    const { h, state, ruleResidual } = residualHarness();
    const result = await residualStep(h.env, state);
    expect(ruleResidual).toHaveBeenCalledTimes(1);
    expect(ruleResidual.mock.calls[0]?.[0].items).toEqual([OPEN_FINDING]);
    expect(result.patch.rulings).toEqual([
      {
        findingId: "F1",
        action: "waive",
        text: "waive F1",
        why: "out of scope",
        costIfWrong: "the finding ships",
        source: "advisor",
      },
    ]);
  });
});

describe("closeStep", () => {
  test("AC-39/AC-40: closeAs decides the outcome, and the record is closed once through the sink", async () => {
    const h = makeStoryLoopHarness();
    const state: StoryLoopState = {
      ...initialStoryState(h.env),
      step: "close",
      closeAs: { state: "complete-gate-open", reason: "no work produced" },
      costLimited: false,
      round: 0,
      rulings: [],
    };
    const result = await closeStep(h.env, state);
    expect(result.patch.outcome).toEqual({
      state: "complete-gate-open",
      reason: "no work produced",
      rounds: 0,
      rulings: [],
      unreviewed: true,
    });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({ state: "complete-gate-open", reason: "no work produced", phase: "closed" });
  });
});
