/**
 * US-006 (gate-config-route, #2899): a fix round that ended BLOCKED without a config change and left
 * the gates exactly as red as they were before it cannot converge, so its pass exits `capped` and the
 * residual node adjudicates now instead of spending the rounds the story had left.
 *
 * The block cases drive `evaluateStep` directly — the exit label, the ledger line and the applied
 * rule are the node's own. The last case drives the whole graph, where the early stop is what keeps
 * the story to one round.
 */
import { describe, expect, test } from "bun:test";
import { makeStoryLoopAdvisor, makeStoryLoopHarness, storyLoopFixtures } from "@test/helpers";
import type { ResidualRequest } from "@/workflow/advisor";
import type { ImplementOutcome } from "@/workflow/implement";
import { runStoryLoop, type StoryLoopState } from "@/workflow/story-loop";
import { evaluateStep, initialStoryState } from "@/workflow/story-steps";
import type { GateRunResult, WorkflowFinding } from "@/workflow/types";

const { OK } = storyLoopFixtures;
const MAX_FIX_ROUNDS = 3;

/** The open finding a scoped-red pass hands the fix round; the pass under test assigns `F2`. */
const OPEN_GATE: WorkflowFinding = {
  id: "F1",
  kind: "gate",
  severity: "important",
  issue: "the scoped gate failed",
};

/** The scoped gate's finding, as a gate run reports it. */
const SCOPED_FINDING = {
  kind: "gate",
  gate: "scoped",
  severity: "important",
  issue: "the scoped gate failed",
} as const;

const RED_SCOPED: GateRunResult = {
  red: true,
  states: { lint: "green", typecheck: "green", scoped: "red" },
  findings: [SCOPED_FINDING],
};

const RED_LINT: GateRunResult = {
  red: true,
  states: { lint: "red", typecheck: "green", scoped: "green" },
  findings: [{ kind: "gate", gate: "lint", severity: "important", issue: "the lint gate failed" }],
};

const RED_LINT_AND_SCOPED: GateRunResult = {
  red: true,
  states: { lint: "red", typecheck: "green", scoped: "red" },
  findings: [SCOPED_FINDING],
};

/** The turn a fix round ends with when the implementer cannot get the gates green. */
const BLOCKED_TURN = { status: "BLOCKED", fallback: false, stepUps: 0 } as const;
/** The same turn, whose answer was a config change nax made. */
const APPLIED_TURN = { ...BLOCKED_TURN, configApplied: true } as const;
/** A fix round that said it was done. */
const DONE_TURN = { status: "DONE", fallback: false, stepUps: 0 } as const;

interface PassScript {
  /** The gate run of the pass *before* the BLOCKED round; absent is a story that never ran gates. */
  readonly previous?: GateRunResult;
  /** The gate run this pass takes — the pass after the round. */
  readonly gates: GateRunResult;
  /** The turn the round before this pass ended with. */
  readonly lastTurn?: StoryLoopState["lastTurn"];
  /** The round the story is on; the default is the fix round the block spent. */
  readonly round?: number;
}

type Harness = ReturnType<typeof makeStoryLoopHarness>;

/** One evaluate pass over the state a BLOCKED round left behind. */
async function runPass(script: PassScript): Promise<{ h: Harness; exit: string | undefined }> {
  const h = makeStoryLoopHarness({}, { maxFixRounds: MAX_FIX_ROUNDS, steps: { gates: async () => script.gates } });
  const state: StoryLoopState = {
    ...initialStoryState(h.env),
    step: "evaluate",
    round: script.round ?? 1,
    nextId: 2,
    open: [OPEN_GATE],
    ...(script.previous === undefined ? {} : { gates: script.previous }),
    ...(script.lastTurn === undefined ? {} : { lastTurn: script.lastTurn }),
  };
  const result = await evaluateStep(h.env, state);
  return { h, exit: result.exit };
}

/** Whether the pass sent the story to the advisor at all — the rule's own ledger line. */
const routesToAdvisor = (h: Harness): boolean => h.ledger.some((line) => line.includes("go to the advisor"));

/** The implementer's reply in a fix round that could not lift the red gates. */
const BLOCKED_OUTCOME: ImplementOutcome = {
  reply: {
    status: "BLOCKED",
    commits: [],
    testSummary: "",
    interrupted: false,
    concerns: "the scoped gate fails on the package's own command",
  },
  autoCommitted: false,
};

const fixes = (h: Harness) => h.turns.filter((turn) => turn.kind === "fix");

describe("evaluateStep — an unchanged BLOCKED fix round (US-006)", () => {
  test("AC-1: scoped red before and after a BLOCKED round exits 'capped', with rounds still left", async () => {
    const { exit } = await runPass({ previous: RED_SCOPED, gates: RED_SCOPED, lastTurn: BLOCKED_TURN });
    expect(exit).toBe("capped");
  });

  test("AC-2: the ledger sends the still-open ids to the advisor, naming the red gate", async () => {
    const { h } = await runPass({ previous: RED_SCOPED, gates: RED_SCOPED, lastTurn: BLOCKED_TURN });
    expect(h.ledger).toContain("fix round r1 blocked with scoped unchanged: F2 go to the advisor");
  });

  test("AC-3: lint and scoped both unchanged name both gates", async () => {
    const { h } = await runPass({ previous: RED_LINT_AND_SCOPED, gates: RED_LINT_AND_SCOPED, lastTurn: BLOCKED_TURN });
    expect(h.ledger).toContain("fix round r1 blocked with lint, scoped unchanged: F2 go to the advisor");
  });

  test("AC-4: an applied config change keeps the round's path, so the pass stays 'open'", async () => {
    const { h, exit } = await runPass({ previous: RED_SCOPED, gates: RED_SCOPED, lastTurn: APPLIED_TURN });
    expect(exit).toBe("open");
    expect(routesToAdvisor(h)).toBe(false);
  });

  test("AC-5: a changed red set keeps the round's path, so the pass stays 'open'", async () => {
    const { h, exit } = await runPass({ previous: RED_SCOPED, gates: RED_LINT, lastTurn: BLOCKED_TURN });
    expect(exit).toBe("open");
    expect(routesToAdvisor(h)).toBe(false);
  });

  test("AC-6: a fix round that ended DONE keeps the round's path, so the pass stays 'open'", async () => {
    const { h, exit } = await runPass({ previous: RED_SCOPED, gates: RED_SCOPED, lastTurn: DONE_TURN });
    expect(exit).toBe("open");
    expect(routesToAdvisor(h)).toBe(false);
  });

  test("AC-7: a story's first pass, with no gate run before it, never stops early", async () => {
    const { h, exit } = await runPass({ gates: RED_SCOPED, lastTurn: BLOCKED_TURN, round: 0 });
    expect(exit).toBe("open");
    expect(routesToAdvisor(h)).toBe(false);
  });
});

describe("runStoryLoop — the blocked stop reaches the residual node (US-006)", () => {
  test("a BLOCKED round with unchanged scoped red ends the story after one round", async () => {
    const requests: ResidualRequest[] = [];
    const h = makeStoryLoopHarness(
      { gates: [RED_SCOPED, RED_SCOPED], implement: (turn) => (turn.kind === "fix" ? BLOCKED_OUTCOME : OK) },
      {
        maxFixRounds: MAX_FIX_ROUNDS,
        advisor: makeStoryLoopAdvisor({
          ruleResidual: async (request) => {
            requests.push(request);
            return { rulings: [], diagnoses: {} };
          },
        }),
      },
    );
    const out = await runStoryLoop(h.env);
    expect(out.rounds).toBe(1);
    expect(fixes(h)).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(h.ledger).toContain("fix round r1 blocked with scoped unchanged: F2 go to the advisor");
  });
});
