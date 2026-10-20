/**
 * G3 (step-graph): the story loop's wiring onto the engine, and the state it starts from.
 *
 * The wiring is what the G0 goldens cannot see — the engine call itself: one call per story, the
 * graph's initial state, a persist hook that writes nothing, and the two run options that keep the
 * story loop's own cost rule and its absence of an abort check. AC-19 and AC-48 run the real engine,
 * so the graph and the wiring are exercised together, unstubbed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { failingReview, makeStoryLoopHarness } from "@test/helpers";
import { NaxError } from "@/errors";
import { newStoryRecord } from "@/workflow/result";
import { STORY_GRAPH } from "@/workflow/story-graph";
import { _storyLoopDeps, runStoryLoop, type StoryLoopOutcome } from "@/workflow/story-loop";
import { initialStoryState } from "@/workflow/story-steps";
import type { WorkflowFinding, WorkflowStoryRecord } from "@/workflow/types";

const originalRunner = _storyLoopDeps.runStepGraph;
afterEach(() => {
  _storyLoopDeps.runStepGraph = originalRunner;
});

/** The outcome a stubbed runner resolves with; AC-21 pins that it is what `runStoryLoop` resolves to. */
const OUTCOME: StoryLoopOutcome = { state: "complete", reason: "clean", rounds: 0, rulings: [], unreviewed: false };

/** The arguments the stubbed runner was called with, so one call's hooks and options can be invoked. */
type RunnerArgs = Parameters<typeof originalRunner>;

/** Stubs the engine call with `resolve`, and answers with the arguments it recorded. */
function stubRunner(resolve: (args: RunnerArgs) => RunnerArgs[2]): RunnerArgs[] {
  const calls: RunnerArgs[] = [];
  _storyLoopDeps.runStepGraph = async (...args) => {
    calls.push(args);
    return resolve(args);
  };
  return calls;
}

const withOutcome = (args: RunnerArgs): RunnerArgs[2] => ({ ...args[2], outcome: OUTCOME });

const SPEC_FINDING: WorkflowFinding = { id: "F1", kind: "spec", severity: "important", issue: "gap" };
const GATE_FINDING: WorkflowFinding = { id: "G1", kind: "gate", severity: "important", issue: "lint red" };

describe("initialStoryState", () => {
  test("AC-18: a fresh story starts at implement with the loop's defaults", () => {
    const h = makeStoryLoopHarness();
    const state = initialStoryState(h.env);
    expect(state).toMatchObject({
      step: "implement",
      round: 0,
      nextId: 1,
      firstAfterResume: false,
      costLimited: false,
      timings: {},
    });
    expect(state.reviewOpen).toEqual([]);
  });

  test("AC-19: a resumed story starts at evaluate, keeping the record's round, ids and open spec findings", () => {
    const resume: WorkflowStoryRecord = {
      ...newStoryRecord("US-001", 5, "t"),
      round: 2,
      reviewed: true,
      nextFindingId: 5,
      deferredMinors: 1,
      fixBase: "b1",
      openFindings: [SPEC_FINDING, GATE_FINDING],
    };
    const h = makeStoryLoopHarness({}, { resume });
    const state = initialStoryState(h.env);
    expect(state).toMatchObject({
      step: "evaluate",
      round: 2,
      reviewed: true,
      nextId: 5,
      deferredMinors: 1,
      fixBase: "b1",
      firstAfterResume: true,
    });
    expect(state.reviewOpen).toEqual([SPEC_FINDING]);
  });
});

describe("runStoryLoop wiring", () => {
  test("AC-20/AC-21: one engine call with the graph, the env and the initial state, whose outcome it returns", async () => {
    const h = makeStoryLoopHarness();
    const calls = stubRunner(withOutcome);
    await expect(runStoryLoop(h.env)).resolves.toBe(OUTCOME);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(STORY_GRAPH);
    expect(calls[0]?.[1]).toBe(h.env);
    expect(calls[0]?.[2].step).toBe("implement");
  });

  test("AC-22/AC-23/AC-24/AC-25: persist writes nothing, and the hooks never announce a step", async () => {
    const h = makeStoryLoopHarness();
    const calls = stubRunner(withOutcome);
    await runStoryLoop(h.env);
    const hooks = calls[0]?.[3];
    if (hooks === undefined) throw new Error("the hooks were not captured");
    await expect(hooks.persist({ ...initialStoryState(h.env), outcome: OUTCOME })).resolves.toBeUndefined();
    expect(h.updates).toEqual([]);
    expect(h.ledger).toEqual([]);
    expect(hooks.onStep).toBeUndefined();
  });

  test("AC-26/AC-27/AC-28/AC-29/AC-30/AC-31: the options carry the story loop's own rules", async () => {
    const h = makeStoryLoopHarness();
    const calls = stubRunner(withOutcome);
    await runStoryLoop(h.env);
    const options = calls[0]?.[4];
    if (options === undefined) throw new Error("the options were not captured");
    expect(options.aborted()).toBe(false);
    expect(options.costExceeded?.()).toBe(true);
    expect(h.turns).toEqual([]);
    expect(options.logScope).toBeUndefined();
    expect(options.readHead).toBeUndefined();
    expect(options.onAbort).toBeUndefined();
  });

  test("AC-32 (row 3): a final state with no outcome rejects rather than returning undefined", async () => {
    const h = makeStoryLoopHarness();
    stubRunner((args) => args[2]);
    const rejection = runStoryLoop(h.env);
    await expect(rejection).rejects.toBeInstanceOf(NaxError);
    await expect(rejection).rejects.toMatchObject({
      code: "WORKFLOW_STORY_NO_OUTCOME",
      context: { stage: "workflow", storyId: h.env.storyId },
    });
  });
});

describe("runStoryLoop on the real engine", () => {
  test("AC-41/AC-42: one warm fix round completes the story, on exactly two implementer turns", async () => {
    const h = makeStoryLoopHarness({ review: [failingReview(1)] }, { maxFixRounds: 2 });
    await expect(runStoryLoop(h.env)).resolves.toEqual({
      state: "complete",
      reason: "clean",
      rounds: 1,
      rulings: [],
      unreviewed: false,
    });
    expect(h.turns).toHaveLength(2);
    expect(h.turns[0]).toEqual({ kind: "implement" });
    expect(h.turns[1]).toMatchObject({ kind: "fix", round: 1 });
  });

  test("AC-48 (row 1a): a seam error escapes runStoryLoop as the same error object", async () => {
    const failure = new Error("gates exploded");
    const h = makeStoryLoopHarness(
      {},
      {
        steps: {
          gates: async () => {
            throw failure;
          },
        },
      },
    );
    await expect(runStoryLoop(h.env)).rejects.toBe(failure);
  });

  test("AC-50 (row 2b): the cost limit at the top of a pass closes the story cost-limit", async () => {
    const h = makeStoryLoopHarness({}, { steps: { costExceeded: () => true } });
    await expect(runStoryLoop(h.env)).resolves.toMatchObject({
      state: "complete-gate-open",
      reason: "cost-limit",
    });
  });

  test("AC-50 (row 2b): the cost limit before a fix round closes the story cost-limit, with no round spent", async () => {
    const h = makeStoryLoopHarness({ review: [failingReview(1)] });
    let calls = 0;
    h.env.steps.costExceeded = () => {
      calls += 1;
      return calls > 1;
    };
    await expect(runStoryLoop(h.env)).resolves.toMatchObject({
      state: "complete-gate-open",
      reason: "cost-limit",
      rounds: 0,
    });
  });
});
