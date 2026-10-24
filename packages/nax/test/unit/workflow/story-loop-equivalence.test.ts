/**
 * G0 (step-graph equivalence): the story loop's scripted harness and trace recorder (US-003).
 *
 * The trace is taken at the loop's injection seams (`StoryLoopEnv.steps`, `StoryLoopEnv.advisor`,
 * `StoryLoopEnv.sink`) plus the `workflow` run log, so it describes behaviour and not implementation.
 * Goldens live in `test/fixtures/workflow-equivalence/story/<scenario>.json` and are regenerated only
 * deliberately: `NAX_UPDATE_WORKFLOW_GOLDEN=1 bun test test/unit/workflow/story-loop-equivalence.test.ts`.
 * Regeneration writes them with `JSON.stringify(…, null, 2)`; biome reflows short arrays onto one line,
 * so follow it with `bun x biome format --write test/fixtures/workflow-equivalence/story/`.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertCaughtInstanceOf,
  compareWithGolden,
  failingReview,
  makeStoryLoopAdvisor,
  makeStoryLoopHarness,
  normalizeTrace,
  recordStoryTrace,
  reReviewVerdict,
  storyLoopFixtures,
  type TraceEvent,
  type WorkflowTrace,
  withTempDir,
} from "@test/helpers";
import type { ImplementOutcome, ImplementTurn } from "@/workflow/implement";
import { newStoryRecord } from "@/workflow/result";
import { runStoryLoop } from "@/workflow/story-loop";
import type { WorkflowFinding, WorkflowFindingDraft, WorkflowStoryRecord } from "@/workflow/types";

const { GREEN, RED_LINT, SUITE_GREEN, SUITE_RED, PASS, OK } = storyLoopFixtures;

const OPEN_FINDING: WorkflowFinding = { id: "F1", kind: "spec", severity: "important", issue: "issue one" };

const NEEDS_CONTEXT: ImplementOutcome = {
  reply: { status: "NEEDS_CONTEXT", commits: [], testSummary: "", interrupted: false, concerns: "which API?" },
  autoCommitted: false,
};

/** An implementer that asks once, then works: the shortest script with an advisor call in it. */
const asksOnce = (turn: ImplementTurn): ImplementOutcome => (turn.kind === "implement" ? NEEDS_CONTEXT : OK);
const ANSWERING = makeStoryLoopAdvisor({ answerQuestion: async () => "try X" });

type EventOfKind<K extends TraceEvent["kind"]> = Extract<TraceEvent, { kind: K }>;

const eventsOf = <K extends TraceEvent["kind"]>(trace: WorkflowTrace, kind: K): EventOfKind<K>[] =>
  trace.events.filter((event): event is EventOfKind<K> => event.kind === kind);

const methodsOf = (trace: WorkflowTrace, kind: "call" | "return"): string[] =>
  trace.events.flatMap((event) => (event.kind === kind ? [event.method] : []));

const callsOf = (trace: WorkflowTrace): string[] => methodsOf(trace, "call");

/** The rejection of `compareWithGolden`, or null when it passed. */
const goldenFailure = (trace: WorkflowTrace, root?: string): Promise<unknown> =>
  compareWithGolden(trace, root === undefined ? {} : { root }).then(
    () => null,
    (err: unknown) => err,
  );

const GOLDEN_ENV = "NAX_UPDATE_WORKFLOW_GOLDEN";

async function withGoldenEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[GOLDEN_ENV];
  if (value === undefined) delete process.env[GOLDEN_ENV];
  else process.env[GOLDEN_ENV] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[GOLDEN_ENV];
    else process.env[GOLDEN_ENV] = previous;
  }
}

describe("makeStoryLoopHarness", () => {
  test("AC-1: an empty script runs to complete in zero rounds", async () => {
    const h = makeStoryLoopHarness();
    expect(await runStoryLoop(h.env)).toMatchObject({ state: "complete", rounds: 0 });
  });

  test("AC-2: queued gate results are yielded in queue order", async () => {
    const h = makeStoryLoopHarness({ gates: [RED_LINT, GREEN] });
    expect(await h.env.steps.gates()).toBe(RED_LINT);
    expect(await h.env.steps.gates()).toBe(GREEN);
  });

  test("AC-3: queued full-suite results are yielded in queue order", async () => {
    const h = makeStoryLoopHarness({ suite: [SUITE_RED, SUITE_GREEN] });
    expect(await h.env.steps.fullSuite()).toBe(SUITE_RED);
    expect(await h.env.steps.fullSuite()).toBe(SUITE_GREEN);
  });

  test("AC-4: queued story-review verdicts are yielded in queue order", async () => {
    const failing = failingReview();
    const h = makeStoryLoopHarness({ review: [failing, PASS] });
    expect(await h.env.steps.storyReview([], GREEN.states)).toEqual({ ran: true, verdict: failing });
    expect(await h.env.steps.storyReview([], GREEN.states)).toEqual({ ran: true, verdict: PASS });
  });

  test("AC-5: a queued null is a story review that did not run", async () => {
    const h = makeStoryLoopHarness({ review: [null] });
    expect(await h.env.steps.storyReview([])).toEqual({ ran: false, why: expect.any(String) });
  });

  test("AC-6: queued addressed flags mark every supplied finding's id, in queue order", async () => {
    const h = makeStoryLoopHarness({ reReviewAllAddressed: [false, true] });
    const second: WorkflowFinding = { ...OPEN_FINDING, id: "F2" };
    const asked = [OPEN_FINDING, second];
    expect(await h.env.steps.reReview(1, asked, "h1")).toEqual({
      ran: true,
      verdict: {
        verdicts: [
          { id: "F1", addressed: false, note: "" },
          { id: "F2", addressed: false, note: "" },
        ],
        newFindings: [],
      },
    });
    expect(await h.env.steps.reReview(2, asked, "h2")).toEqual({
      ran: true,
      verdict: {
        verdicts: [
          { id: "F1", addressed: true, note: "" },
          { id: "F2", addressed: true, note: "" },
        ],
        newFindings: [],
      },
    });
  });

  test("AC-7: the implement function's result is what the turn yields", async () => {
    const custom: ImplementOutcome = {
      reply: { status: "NEEDS_CONTEXT", commits: [], testSummary: "", interrupted: false, concerns: "which API?" },
      autoCommitted: true,
    };
    const seen: ImplementTurn[] = [];
    const h = makeStoryLoopHarness({
      implement: (turn) => {
        seen.push(turn);
        return custom;
      },
    });
    const turn: ImplementTurn = { kind: "implement" };
    expect(await h.env.steps.implement(turn)).toBe(custom);
    expect(seen).toEqual([turn]);
  });

  test("a resumed harness accumulates onto its resume record, keeping the fields no patch rewrites", async () => {
    const resume: WorkflowStoryRecord = {
      ...newStoryRecord("US-001", 5, "earlier"),
      round: 2,
      phase: "rereview",
      reviewed: true,
      fixBase: "h1",
      openFindings: [OPEN_FINDING],
      nextFindingId: 2,
      timings: { "story-review": 12 },
    };
    const h = makeStoryLoopHarness({ reReviewAllAddressed: [true] }, { resume });
    // The machine resumes at round 2; its storage must agree, not start a fresh story beside it.
    expect(await runStoryLoop(h.env)).toMatchObject({ state: "complete", rounds: 2 });
    expect(h.record()).toMatchObject({
      round: 2,
      startedAt: "earlier",
      maxRounds: 5,
      timings: { "story-review": 12 },
      openFindings: [],
      state: "complete",
      phase: "closed",
    });
    // An independent copy: patching the harness's record never wrote through to the caller's.
    expect(resume).toMatchObject({
      round: 2,
      phase: "rereview",
      startedAt: "earlier",
      fixBase: "h1",
      openFindings: [OPEN_FINDING],
    });
  });
});

describe("recordStoryTrace", () => {
  test("AC-8: runs runStoryLoop on the harness env and returns a story trace", async () => {
    const h = makeStoryLoopHarness();
    const trace = await recordStoryTrace("clean", h);
    expect(trace.scenario).toBe("clean");
    expect(trace.machine).toBe("story");
    // The loop really ran on this harness: its own captures saw the calls.
    expect(h.turns).toHaveLength(1);
    expect(trace.end).toEqual({
      returned: { state: "complete", reason: "clean", rounds: 0, rulings: [], unreviewed: false },
    });
  });

  test("AC-9: every steps and advisor call records a call and a return, in invocation order", async () => {
    const h = makeStoryLoopHarness({ implement: asksOnce }, { advisor: ANSWERING });
    const trace = await recordStoryTrace("calls", h);
    const expected = ["implement", "answerQuestion", "implement", "costExceeded", "gates", "fullSuite", "storyReview"];
    expect(methodsOf(trace, "call")).toEqual(expected);
    expect(methodsOf(trace, "return")).toEqual(expected);
    const callAndReturn = trace.events.filter((event) => event.kind === "call" || event.kind === "return");
    expect(callAndReturn.map((event) => event.kind)).toEqual(expected.flatMap(() => ["call", "return"]));
    const calls = eventsOf(trace, "call");
    // Arguments: the turn, the advisor question, and a two-argument seam.
    expect(calls[0]).toEqual({ kind: "call", method: "implement", args: [{ kind: "implement" }] });
    expect(calls[1]).toEqual({
      kind: "call",
      method: "answerQuestion",
      args: [{ storyId: "US-001", status: "NEEDS_CONTEXT", concerns: "which API?" }],
    });
    expect(calls[6]?.args).toEqual([[], { ...GREEN.states, ...SUITE_GREEN.states }]);
    const returns = eventsOf(trace, "return");
    // Results, including a synchronous one that lands before the next call.
    expect(returns[0]).toEqual({ kind: "return", method: "implement", value: NEEDS_CONTEXT });
    expect(returns[1]).toEqual({ kind: "return", method: "answerQuestion", value: "try X" });
    expect(returns[3]).toEqual({ kind: "return", method: "costExceeded", value: false });
    expect(returns[4]).toEqual({ kind: "return", method: "gates", value: GREEN });
  });

  test("AC-10: each sink update records its patch, in the loop's order relative to the calls", async () => {
    const h = makeStoryLoopHarness();
    const trace = await recordStoryTrace("updates", h);
    const updates = eventsOf(trace, "update");
    expect(updates.map((event) => event.record)).toEqual(h.updates);
    expect(updates[0]?.record).toEqual({ phase: "implement" });
    expect(updates.at(-1)?.record).toMatchObject({ state: "complete", phase: "closed" });
    const firstUpdate = trace.events.findIndex((event) => event.kind === "update");
    const implementCall = trace.events.findIndex((event) => event.kind === "call" && event.method === "implement");
    const gatesCall = trace.events.findIndex((event) => event.kind === "call" && event.method === "gates");
    const closeUpdate = trace.events.findLastIndex((event) => event.kind === "update");
    // The phase is persisted before the step it announces, and the close follows the last step.
    expect(firstUpdate).toBeLessThan(implementCall);
    expect(gatesCall).toBeLessThan(closeUpdate);
  });

  test("AC-11: ledger writes are recorded, including the unbound sink.ledger the residual adjudication calls", async () => {
    const h = makeStoryLoopHarness(
      { review: [failingReview()], reReviewAllAddressed: [false, false] },
      { maxFixRounds: 2 },
    );
    const trace = await recordStoryTrace("ledger", h);
    const ledger = eventsOf(trace, "ledger");
    expect(ledger.map((event) => event.text)).toEqual(h.ledger);
    expect(ledger[0]?.text).toBe("fix round 1/2 (1 open: F1)");
    // adjudicateResidual is handed `env.sink.ledger` unbound, so the wrapper must not need `this`.
    const rulingIndex = trace.events.findIndex(
      (event) => event.kind === "ledger" && event.text.startsWith("Ruling: hold F1"),
    );
    expect(rulingIndex).toBeGreaterThan(-1);
    const ruleReturn = trace.events.findIndex((event) => event.kind === "return" && event.method === "ruleResidual");
    expect(ruleReturn).toBeGreaterThan(-1);
    expect(ruleReturn).toBeLessThan(rulingIndex);
    // A write that carried options keeps them; the end line passes mirror:false.
    expect(ledger.find((event) => event.text.startsWith("complete-with-rulings ("))?.options).toEqual({
      mirror: false,
    });
  });

  test("AC-12: workflow-stage log lines are recorded with level, message and data", async () => {
    const trace = await recordStoryTrace("logs", makeStoryLoopHarness());
    const logs = eventsOf(trace, "log");
    expect(logs.find((event) => event.message === "US-001 implementer start")).toEqual({
      kind: "log",
      level: "info",
      message: "US-001 implementer start",
      data: { storyId: "US-001", step: "implementer" },
    });
    const done = logs.find((event) => event.message.startsWith("US-001 implementer: DONE"));
    expect(done?.level).toBe("info");
    expect(done?.data).toMatchObject({ storyId: "US-001", step: "implementer" });
    // The step's wall-clock duration rides along; normalizeTrace is what neutralizes it.
    expect(typeof done?.data?.durationMs).toBe("number");
  });

  test("AC-13: a steps method the harness leaves out stays absent on the wrapped env", async () => {
    const noStatus: ImplementOutcome = {
      reply: { status: "DONE", commits: [], testSummary: "", interrupted: false, noStatusBlock: true },
      autoCommitted: false,
    };
    const h = makeStoryLoopHarness({ implement: (turn) => (turn.kind === "implement" ? noStatus : OK) });
    const trace = await recordStoryTrace("absent-optional", h);
    const methods = [...methodsOf(trace, "call"), ...methodsOf(trace, "return")];
    // Both are read only through `env.steps.x?.()`; a wrapper that always supplied them would show up here.
    expect(methods).not.toContain("workProduced");
    expect(methods).not.toContain("modelFor");
    // Absent workProduced means "work produced", so the no-work ladder never restarted the story.
    expect(callsOf(trace).filter((method) => method === "implement")).toHaveLength(1);
    expect(trace.end).toHaveProperty("returned");
  });

  test("AC-14: without a root override the comparison reads the committed story fixture tree", async () => {
    await withGoldenEnv(undefined, async () => {
      const trace = await recordStoryTrace("no-such-golden-scenario", makeStoryLoopHarness());
      const failure = await goldenFailure(trace);
      assertCaughtInstanceOf(failure, Error, "compareWithGolden rejection");
      expect(failure.message).toContain(
        join("test", "fixtures", "workflow-equivalence", "story", "no-such-golden-scenario.json"),
      );
    });
  });

  test("AC-15: NAX_UPDATE_WORKFLOW_GOLDEN=1 writes <root>/story/<scenario>.json, two-space indented", async () => {
    await withGoldenEnv("1", () =>
      withTempDir(async (root) => {
        const trace = await recordStoryTrace("clean", makeStoryLoopHarness());
        await compareWithGolden(trace, { root });
        const text = await Bun.file(join(root, "story", "clean.json")).text();
        expect(text).toBe(`${JSON.stringify(normalizeTrace(trace), null, 2)}\n`);
        expect(text).toContain('\n  "end":');
        expect(text.endsWith("\n")).toBe(true);
      }),
    );
  });

  test("AC-16: a story golden mismatch names the scenario, the index and both events", async () => {
    await withGoldenEnv("1", () =>
      withTempDir(async (root) => {
        const trace = await recordStoryTrace("differs", makeStoryLoopHarness());
        await compareWithGolden(trace, { root });
        await withGoldenEnv(undefined, async () => {
          const at = trace.events.findIndex((event) => event.kind === "call");
          const changed: WorkflowTrace = {
            ...trace,
            events: trace.events.map((event, index) =>
              index === at ? { kind: "call", method: "gates", args: [] } : event,
            ),
          };
          const failure = await goldenFailure(changed, root);
          assertCaughtInstanceOf(failure, Error, "compareWithGolden rejection");
          expect(failure.message).toContain('scenario "differs"');
          expect(failure.message).toContain(`event index ${at}`);
          expect(failure.message).toContain(`expected: ${JSON.stringify(normalizeTrace(trace).events[at])}`);
          expect(failure.message).toContain(`actual:   ${JSON.stringify(normalizeTrace(changed).events[at])}`);
        });
      }),
    );
  });

  test("AC-17: two runs of one script serialize identically, with the close patch's endedAt as <ts>", async () => {
    const script = { review: [failingReview()], reReviewAllAddressed: [false, true] };
    const first = await recordStoryTrace("repeat", makeStoryLoopHarness(script));
    const second = await recordStoryTrace("repeat", makeStoryLoopHarness(script));
    const text = JSON.stringify(normalizeTrace(first));
    expect(text).toBe(JSON.stringify(normalizeTrace(second)));
    const closing = eventsOf(normalizeTrace(first), "update").at(-1);
    expect(closing?.record).toMatchObject({ phase: "closed", endedAt: "<ts>" });
    // The noise normalizeTrace removes was really there: wall-clock durations and endedAt.
    expect(first.events.some((event) => event.kind === "log" && typeof event.data?.durationMs === "number")).toBe(true);
    expect(text).toContain('"endedAt":"<ts>"');
    expect(text).toContain('"durationMs":0');
  });

  test("AC-18: a scripted step that throws a plain Error ends the trace and the recorder resolves", async () => {
    const h = makeStoryLoopHarness(
      {},
      {
        steps: {
          gates: async () => {
            throw new Error("boom");
          },
        },
      },
    );
    const trace = await recordStoryTrace("boom", h);
    expect(trace.end).toEqual({ threw: { code: null, message: "boom" } });
  });
});

/** The steps that spend an agent call: the ones a resume must not repeat. */
const AGENT_METHODS: readonly string[] = ["implement", "storyReview", "reReview"];

const fixTurns = (turns: readonly ImplementTurn[]): Extract<ImplementTurn, { kind: "fix" }>[] =>
  turns.filter((turn): turn is Extract<ImplementTurn, { kind: "fix" }> => turn.kind === "fix");

/** Narrows a trace call's untyped first arg to a fix turn; the recorder keeps seam args as unknown. */
const isFixTurn = (value: unknown): value is Extract<ImplementTurn, { kind: "fix" }> =>
  typeof value === "object" && value !== null && "kind" in value && value.kind === "fix";

const NO_STATUS: ImplementOutcome = {
  reply: { status: "DONE", commits: [], testSummary: "", interrupted: false, noStatusBlock: true },
  autoCommitted: false,
};

const NEW_FINDING: WorkflowFindingDraft = { kind: "quality", severity: "important", issue: "issue two" };

/** A scenario-level harness factory: a fresh harness per call, so two recordings start from one script. */
const cleanHarness = () => makeStoryLoopHarness();
const redGatesHarness = () => makeStoryLoopHarness({ gates: [RED_LINT, GREEN] });
const oneFailingReviewHarness = () => makeStoryLoopHarness({ review: [failingReview()], reReviewAllAddressed: [true] });
const warmCapHarness = () =>
  makeStoryLoopHarness({ review: [failingReview()], reReviewAllAddressed: [false, false, false, true] });
const costHarness = () => makeStoryLoopHarness({}, { steps: { costExceeded: () => true } });
const noWorkHarness = () =>
  makeStoryLoopHarness(
    { implement: (turn) => (turn.kind === "implement" ? NO_STATUS : OK) },
    { steps: { workProduced: async () => false } },
  );
const resumeHarness = () => makeStoryLoopHarness({ reReviewAllAddressed: [true] }, { resume: RESUME_RECORD });
const newFindingHarness = () =>
  makeStoryLoopHarness({
    review: [failingReview()],
    reReviews: [reReviewVerdict(["F1"], [NEW_FINDING]), reReviewVerdict(["F2"])],
  });

/** The advisor a residual scenario needs: it rules the open finding instead of defaulting to hold. */
const RULING_ADVISOR = makeStoryLoopAdvisor({
  ruleResidual: async (req) => ({
    rulings: req.items.map((finding) => ({
      findingId: finding.id,
      action: "waive",
      text: `waive ${finding.id}: ${finding.issue}`,
      why: "out of scope for this story",
      costIfWrong: "the finding ships",
      source: "advisor",
    })),
    diagnoses: {},
  }),
});

/** A prior run that stopped after its round-1 re-review had not addressed F1. */
const RESUME_RECORD: WorkflowStoryRecord = {
  ...newStoryRecord("US-001", 5, "t"),
  round: 2,
  phase: "rereview",
  reviewed: true,
  fixBase: "h1",
  openFindings: [OPEN_FINDING],
  nextFindingId: 2,
};

describe("clean", () => {
  test("AC-19: a clean story completes in zero rounds", async () => {
    const trace = await recordStoryTrace("clean", cleanHarness());
    expect(trace.end.returned).toMatchObject({ state: "complete", rounds: 0 });
    await compareWithGolden(trace);
  });

  test("AC-20: a clean story makes exactly one implement turn, of kind implement", async () => {
    const h = cleanHarness();
    const trace = await recordStoryTrace("clean", h);
    expect(h.turns).toEqual([{ kind: "implement" }]);
    expect(callsOf(trace).filter((method) => method === "implement")).toHaveLength(1);
    await compareWithGolden(trace);
  });
});

describe("red-gates-then-green", () => {
  test("AC-21: the red gate's fix turn comes before the story review", async () => {
    const h = redGatesHarness();
    const trace = await recordStoryTrace("red-gates-then-green", h);
    // The fix turn, not the initial implement: the property is that the *fix* precedes the review.
    const fixCall = trace.events.findIndex(
      (event) => event.kind === "call" && event.method === "implement" && isFixTurn(event.args[0]),
    );
    const reviewCall = trace.events.findIndex((event) => event.kind === "call" && event.method === "storyReview");
    expect(fixCall).toBeGreaterThan(-1);
    expect(reviewCall).toBeGreaterThan(-1);
    expect(fixCall).toBeLessThan(reviewCall);
    // The fix was handed the gate's own finding, not a review's.
    expect(fixTurns(h.turns).map((turn) => turn.findings.map((finding) => finding.gate))).toEqual([["lint"]]);
    await compareWithGolden(trace);
  });
});

describe("review-fail-one-round", () => {
  test("AC-22: one important finding and an addressed re-review completes in one round", async () => {
    const trace = await recordStoryTrace("review-fail-one-round", oneFailingReviewHarness());
    expect(trace.end.returned).toMatchObject({ state: "complete", rounds: 1 });
    await compareWithGolden(trace);
  });
});

describe("fresh-after-warm-cap", () => {
  test("AC-23: the fix turns of rounds 1 to 3 are warm", async () => {
    const h = warmCapHarness();
    const trace = await recordStoryTrace("fresh-after-warm-cap", h);
    expect(fixTurns(h.turns).map((turn) => [turn.round, turn.fresh])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, true],
    ]);
    await compareWithGolden(trace);
  });

  test("AC-24: the fix turn of round 4 is fresh and one tier up", async () => {
    const h = warmCapHarness();
    const trace = await recordStoryTrace("fresh-after-warm-cap", h);
    expect(fixTurns(h.turns).at(3)).toMatchObject({ round: 4, fresh: true, stepUps: 1 });
    await compareWithGolden(trace);
  });
});

describe("residual-rulings", () => {
  const residualHarness = () =>
    makeStoryLoopHarness(
      { review: [failingReview()], reReviewAllAddressed: [false, false] },
      { maxFixRounds: 2, advisor: RULING_ADVISOR },
    );

  test("AC-25: findings open past the fix-round cap close the story with rulings", async () => {
    const trace = await recordStoryTrace("residual-rulings", residualHarness());
    expect(trace.end.returned).toMatchObject({ state: "complete-with-rulings" });
    await compareWithGolden(trace);
  });

  test("AC-26: the trace records the advisor's ruleResidual call", async () => {
    const trace = await recordStoryTrace("residual-rulings", residualHarness());
    const ruling = eventsOf(trace, "call").find((event) => event.method === "ruleResidual");
    expect(ruling).toBeDefined();
    // The open finding is what the advisor was asked to rule on.
    expect(ruling?.args[0]).toMatchObject({ storyId: "US-001", redGates: [] });
    await compareWithGolden(trace);
  });
});

describe("needs-context-answered", () => {
  test("AC-27: the advisor's answer becomes an answer turn", async () => {
    const h = makeStoryLoopHarness({ implement: asksOnce }, { advisor: ANSWERING });
    const trace = await recordStoryTrace("needs-context-answered", h);
    expect(h.turns).toEqual([{ kind: "implement" }, { kind: "answer", text: "try X", stepUps: 0, limit: "implement" }]);
    await compareWithGolden(trace);
  });
});

describe("review-not-ran", () => {
  test("AC-28: a story review that did not run leaves the story unreviewed", async () => {
    const trace = await recordStoryTrace("review-not-ran", makeStoryLoopHarness({ review: [null] }));
    expect(trace.end.returned).toMatchObject({ state: "complete", unreviewed: true });
    await compareWithGolden(trace);
  });
});

describe("full-suite-red", () => {
  test("AC-29: a full suite that stays red closes the story gate-open", async () => {
    const h = makeStoryLoopHarness({}, { maxFixRounds: 1, steps: { fullSuite: async () => SUITE_RED } });
    const trace = await recordStoryTrace("full-suite-red", h);
    expect(trace.end.returned).toMatchObject({ state: "complete-gate-open", reason: "red: full-suite" });
    await compareWithGolden(trace);
  });
});

describe("cost-exceeded", () => {
  test("AC-30: the story still implements once before the first cost check", async () => {
    const h = costHarness();
    const trace = await recordStoryTrace("cost-exceeded", h);
    expect(h.turns).toEqual([{ kind: "implement" }]);
    await compareWithGolden(trace);
  });

  test("AC-31: no gate step runs once the cost limit is reached", async () => {
    const trace = await recordStoryTrace("cost-exceeded", costHarness());
    expect(callsOf(trace)).not.toContain("gates");
    await compareWithGolden(trace);
  });

  test("AC-32: the outcome is gate-open for the cost limit", async () => {
    const trace = await recordStoryTrace("cost-exceeded", costHarness());
    expect(trace.end.returned).toMatchObject({ state: "complete-gate-open", reason: "cost-limit" });
    await compareWithGolden(trace);
  });
});

describe("no-work-restart", () => {
  test("AC-33: a no-work first turn is followed by a warm restart", async () => {
    const h = noWorkHarness();
    const trace = await recordStoryTrace("no-work-restart", h);
    expect(h.turns).toEqual([{ kind: "implement" }, { kind: "restart", fresh: false, stepUps: 0 }]);
    await compareWithGolden(trace);
  });

  test("AC-34: a restart that did the work lets the story complete", async () => {
    const trace = await recordStoryTrace("no-work-restart", noWorkHarness());
    expect(trace.end.returned).toMatchObject({ state: "complete" });
    await compareWithGolden(trace);
  });
});

describe("resume-mid-fix", () => {
  test("AC-35: a resumed story never runs the first implement turn", async () => {
    const h = resumeHarness();
    const trace = await recordStoryTrace("resume-mid-fix", h);
    expect(h.turns).toEqual([]);
    expect(callsOf(trace)).not.toContain("implement");
    await compareWithGolden(trace);
  });

  test("AC-36: the first agent call is the round-2 re-review", async () => {
    const trace = await recordStoryTrace("resume-mid-fix", resumeHarness());
    const firstAgent = eventsOf(trace, "call").find((event) => AGENT_METHODS.includes(event.method));
    expect(firstAgent?.method).toBe("reReview");
    expect(firstAgent?.args[0]).toBe(2);
    await compareWithGolden(trace);
  });
});

describe("rereview-new-finding", () => {
  test("AC-37: the re-review's return lists the finding it added", async () => {
    const trace = await recordStoryTrace("rereview-new-finding", newFindingHarness());
    const reReviewReturn = eventsOf(trace, "return").find((event) => event.method === "reReview");
    expect(reReviewReturn?.value).toMatchObject({ ran: true, verdict: { newFindings: [NEW_FINDING] } });
    await compareWithGolden(trace);
  });

  test("AC-38: the round after it fixes the new important finding", async () => {
    const h = newFindingHarness();
    const trace = await recordStoryTrace("rereview-new-finding", h);
    expect(fixTurns(h.turns).at(-1)?.findings).toEqual([{ ...NEW_FINDING, id: "F2" }]);
    await compareWithGolden(trace);
  });
});
