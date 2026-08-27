/**
 * Rectification Oscillation Circuit-Breaker (US-002)
 *
 * Three concerns:
 *
 * 1. Pure source-reappearance counter (AC1, AC2). Post-#1355 the counter
 *    counts genuine ping-pong (a resolved finding source reappearing), NOT
 *    every `regressed-different-source` outcome — a forward reviewer-reveal
 *    chain no longer trips the breaker.
 * 2. `runRectification` records source-reappearance reversals into
 *    `ctx.runtime.rectificationOscillations` (AC3).
 * 3. `decideStageAction` reads the accumulated count, the
 *    `review.conflictDetection.{enabled,maxOscillations}` config, and the
 *    presence of `ctx.runtime.rectificationOscillations` to either escalate
 *    (AC7, AC8, AC9, AC10) or pause with a notify (AC4, AC5, AC6, AC11,
 *    AC12).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeTestContext, makeTestRuntime, makeTestStory } from "@test/helpers";
import { type DEFAULT_CONFIG, type NaxConfig, pickSelector } from "@/config";
import {
  _postRunDeps,
  _storyOrchestratorDeps,
  applyPostRunInspection,
  countOscillationOutcomes,
  decideStageAction,
  getOscillations,
  StoryOrchestratorBuilder,
} from "@/execution";
import type { FixCycle, FixCycleContext, FixCycleExitReason, Iteration } from "@/findings/cycle-types";
import type { Finding } from "@/findings/types";
import type { CallContext, RunOperation } from "@/operations";
import type { PipelineContext } from "@/pipeline/types";
import type { NaxRuntime } from "@/runtime";
import { LINT_FINDING, makeInspectionOpts, makePlanResult, TEST_RUNNER_FINDING } from "./_post-run-fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Pure source-reappearance counter (AC1, AC2)
//
// Post-#1355: a "reversal" is a finding source that was resolved (present in an
// earlier findingsBefore, absent from that iteration's findingsAfter) then
// reappears in a later findingsAfter. A strictly-forward reveal chain
// (typecheck → semantic → adversarial, each once) counts zero.
// ─────────────────────────────────────────────────────────────────────────────

/** One iteration built from before/after finding sources. */
function iterFromSources(n: number, before: Finding["source"][], after: Finding["source"][]): Iteration {
  const f = (source: Finding["source"]): Finding => ({ source, severity: "error", category: "test", message: source });
  return {
    iterationNum: n,
    findingsBefore: before.map(f),
    fixesApplied: [],
    findingsAfter: after.map(f),
    outcome: "partial",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
  };
}

/**
 * A minimal iteration sequence producing exactly `count` genuine reversals by
 * alternating lint ↔ test-runner. Reversals = number of swaps after the first
 * (the first swap only resolves a source; subsequent swaps make a resolved
 * source reappear). `reversalIterations(0)` is a single non-reversing swap.
 */
function reversalIterations(count: number): Iteration[] {
  const sources: Finding["source"][] = ["lint", "test-runner"];
  const iters: Iteration[] = [];
  for (let i = 0; i <= count; i++) {
    iters.push(iterFromSources(i + 1, [sources[i % 2]], [sources[(i + 1) % 2]]));
  }
  return iters;
}

describe("AC1: countOscillationOutcomes counts resolved-source reappearances (ping-pong)", () => {
  test("two lint↔test-runner round-trips count 2 reversals", () => {
    expect(countOscillationOutcomes(reversalIterations(2))).toBe(2);
  });

  test("a single resolved source reappearing counts 1", () => {
    expect(countOscillationOutcomes(reversalIterations(1))).toBe(1);
  });
});

describe("AC2: countOscillationOutcomes returns 0 without a resolved-source reappearance", () => {
  test("forward reveal chain (typecheck → semantic → adversarial) counts 0", () => {
    expect(
      countOscillationOutcomes([
        iterFromSources(1, ["typecheck"], ["semantic-review"]),
        iterFromSources(2, ["semantic-review"], ["semantic-review"]),
        iterFromSources(3, ["semantic-review"], ["adversarial-review"]),
      ]),
    ).toBe(0);
  });

  test("returns 0 for an empty iteration list", () => {
    expect(countOscillationOutcomes([])).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. runRectification increment site (AC3)
// ─────────────────────────────────────────────────────────────────────────────

const testSel = pickSelector("test-oscillation-sel", "execution");
type ExecutionSlice = Pick<NaxConfig, "execution">;

const mockImplementerOp: RunOperation<{ story: string }, { success: boolean }, ExecutionSlice> = {
  kind: "run",
  name: "implementer",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "warm" },
  build: () => ({
    role: { id: "r", content: "impl", overridable: false },
    task: { id: "t", content: "", overridable: false },
  }),
  parse: () => ({ success: true }),
};

function makePhaseOp(
  name: string,
): RunOperation<{ story: string }, { success: boolean; findings: Finding[] }, ExecutionSlice> {
  return {
    kind: "run",
    name,
    stage: "verify",
    config: testSel,
    session: { role: "verifier", lifetime: "fresh" },
    build: () => ({
      role: { id: "r", content: name, overridable: false },
      task: { id: "t", content: "", overridable: false },
    }),
    parse: () => ({ success: false, findings: [LINT_FINDING] }),
  };
}

let origCallOp: typeof _storyOrchestratorDeps.callOp;
let origRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
let runtime: NaxRuntime | undefined;

function makeCallCtx(storyId: string): CallContext {
  const rt = makeTestRuntime();
  runtime = rt;
  return {
    runtime: rt,
    packageView: rt.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId,
  } as CallContext;
}

/** A monotonic single-source sequence — no source ever reappears (count 0). */
function monotonicIterations(): Iteration[] {
  return [iterFromSources(1, ["lint"], ["lint"]), iterFromSources(2, ["lint"], [])];
}

function buildRectificationPlan(ctx: CallContext) {
  return new StoryOrchestratorBuilder()
    .addImplementer({ op: mockImplementerOp, input: { story: ctx.storyId ?? "US-osc" } })
    .addFullSuiteGate({ op: makePhaseOp("full-suite-gate"), input: { story: ctx.storyId ?? "US-osc" } })
    .addVerifier({ op: makePhaseOp("verifier"), input: { story: ctx.storyId ?? "US-osc" } })
    .addVerifyScoped({ op: makePhaseOp("verify-scoped"), input: { story: ctx.storyId ?? "US-osc" } })
    .addLintCheck({ op: makePhaseOp("lint-check"), input: { story: ctx.storyId ?? "US-osc" } })
    .addTypecheckCheck({ op: makePhaseOp("typecheck-check"), input: { story: ctx.storyId ?? "US-osc" } })
    .addRectification({
      maxAttempts: 3,
      strategies: [],
      abortOnIncreasingFailures: false,
    })
    .build(ctx, { isThreeSession: true });
}

beforeEach(() => {
  origCallOp = _storyOrchestratorDeps.callOp;
  origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
  origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
  _storyOrchestratorDeps.captureGitRef = mock(async () => "HEAD");
  _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
    if (op.name === "implementer") return { success: true };
    return { success: false, findings: [LINT_FINDING] };
  }) as typeof _storyOrchestratorDeps.callOp;
});

afterEach(async () => {
  _storyOrchestratorDeps.callOp = origCallOp;
  _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
  _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
  await runtime?.close();
  runtime = undefined;
});

describe("AC3: runRectification increments rectificationOscillations on source reappearance", () => {
  test("one resolved-source reappearance increases the per-story count by exactly 1", async () => {
    const storyId = "US-osc-inc-1";
    const ctx = makeCallCtx(storyId);
    const store = ctx.runtime.rectificationOscillations;
    expect(store).toBeInstanceOf(Map);
    expect(getOscillations(store, storyId)).toBe(0);

    _storyOrchestratorDeps.runFixCycle = mock(async (_cycle: FixCycle<Finding>, _cycleCtx: FixCycleContext) => {
      return {
        iterations: reversalIterations(1),
        finalFindings: [LINT_FINDING],
        exitReason: "max-attempts-total" as FixCycleExitReason,
        costUsd: 0,
      };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    const plan = buildRectificationPlan(ctx);
    await plan.run();

    expect(getOscillations(store, storyId)).toBe(1);
  });

  test("two source reappearances in a single cycle increase the count by 2", async () => {
    const storyId = "US-osc-inc-2";
    const ctx = makeCallCtx(storyId);
    const store = ctx.runtime.rectificationOscillations;

    _storyOrchestratorDeps.runFixCycle = mock(async (_cycle: FixCycle<Finding>, _cycleCtx: FixCycleContext) => {
      return {
        iterations: reversalIterations(2),
        finalFindings: [LINT_FINDING],
        exitReason: "max-attempts-total" as FixCycleExitReason,
        costUsd: 0,
      };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    const plan = buildRectificationPlan(ctx);
    await plan.run();

    expect(getOscillations(store, storyId)).toBe(2);
  });

  test("a forward reveal chain (no reappearance) does not increase the per-story count", async () => {
    const storyId = "US-osc-inc-3";
    const ctx = makeCallCtx(storyId);
    const store = ctx.runtime.rectificationOscillations;

    _storyOrchestratorDeps.runFixCycle = mock(async (_cycle: FixCycle<Finding>, _cycleCtx: FixCycleContext) => {
      return {
        iterations: monotonicIterations(),
        finalFindings: [LINT_FINDING],
        exitReason: "max-attempts-total" as FixCycleExitReason,
        costUsd: 0,
      };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    const plan = buildRectificationPlan(ctx);
    await plan.run();

    expect(getOscillations(store, storyId)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. decideStageAction — circuit-breaker pause routing (AC4-AC12)
//
// The breaker is read by `decideStageAction` and written by
// `runRectification`. Tests in this section drive the count through the
// real increment site (mocking `_storyOrchestratorDeps.runFixCycle` to
// return N `regressed-different-source` iterations, then running the
// orchestrator plan) so the seam between the writer and reader is
// exercised end-to-end. The runtime map returned by `createRuntime` is
// the same instance the increment site writes to and `decideStageAction`
// reads from — a wiring regression (e.g. one of them substituting a
// different store) would turn these tests red.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AC9-specific factory: a runtime whose `rectificationOscillations`
 * property is absent (mimics the post-run.ts fail-open path when the
 * runtime doesn't carry the map).
 */
function buildRuntimeWithoutOscillations(): PipelineContext {
  const sharedRuntime = makeTestRuntime();
  const ctx = makeTestContext({
    story: makeTestStory({ id: "US-cb-9", title: "CB test" }),
  });
  Object.defineProperty(ctx, "runtime", {
    value: sharedRuntime,
    configurable: true,
  });
  // Strip the property the runtime would normally expose.
  Object.defineProperty(sharedRuntime, "rectificationOscillations", {
    value: undefined,
    configurable: true,
  });
  ctx.config = {
    ...ctx.config,
    review: {
      ...ctx.config.review,
      conflictDetection: { enabled: true, maxOscillations: 2 },
    },
  };
  return ctx;
}

let origAutoCommit: typeof _postRunDeps.autoCommitIfDirty;
let origDetect: typeof _postRunDeps.detectMergeConflict;
let origFailClose: typeof _postRunDeps.failAndClose;
const createdRuntimes: NaxRuntime[] = [];

function trackRuntime(r: NaxRuntime): NaxRuntime {
  createdRuntimes.push(r);
  return r;
}

beforeEach(() => {
  origAutoCommit = _postRunDeps.autoCommitIfDirty;
  origDetect = _postRunDeps.detectMergeConflict;
  origFailClose = _postRunDeps.failAndClose;
  _postRunDeps.autoCommitIfDirty = mock(async () => undefined) as typeof _postRunDeps.autoCommitIfDirty;
  _postRunDeps.detectMergeConflict = mock(() => false) as typeof _postRunDeps.detectMergeConflict;
  _postRunDeps.failAndClose = mock(async () => undefined) as typeof _postRunDeps.failAndClose;
});

afterEach(async () => {
  _postRunDeps.autoCommitIfDirty = origAutoCommit;
  _postRunDeps.detectMergeConflict = origDetect;
  _postRunDeps.failAndClose = origFailClose;
  // Close any runtimes created via `trackRuntime` /
  // `buildRuntimeWithoutOscillations` so the test-helper's existing
  // close-tracking doesn't try to close a runtime we already replaced
  // (or vice versa).
  const toClose = createdRuntimes.splice(0, createdRuntimes.length);
  await Promise.allSettled(toClose.map((r) => r.close()));
});

describe("AC4: decideStageAction returns action === 'pause' when the breaker threshold is met", () => {
  test("enabled, maxOscillations=2, count=2 → pause", async () => {
    const sharedRuntime = makeTestRuntime();
    trackRuntime(sharedRuntime);
    const callCtx: CallContext = {
      runtime: sharedRuntime,
      packageView: sharedRuntime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "US-cb-1",
    } as CallContext;
    const iterations: Iteration[] = reversalIterations(2);
    _storyOrchestratorDeps.runFixCycle = mock(async (_cycle: FixCycle<Finding>, _cycleCtx: FixCycleContext) => ({
      iterations,
      finalFindings: [LINT_FINDING],
      exitReason: "max-attempts-total" as FixCycleExitReason,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;
    await buildRectificationPlan(callCtx).run();

    const ctx = makeTestContext({
      story: makeTestStory({ id: "US-cb-1", title: "CB test" }),
    });
    Object.defineProperty(ctx, "runtime", {
      value: sharedRuntime,
      configurable: true,
    });
    ctx.config = {
      ...ctx.config,
      review: {
        ...ctx.config.review,
        conflictDetection: { enabled: true, maxOscillations: 2 },
      },
    };

    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("pause");
  });
});

describe("AC5/AC6: pause reason includes the count and an oscillation substring", () => {
  test("reason contains the count '2' and a case-insensitive 'oscillat' substring", async () => {
    const sharedRuntime = makeTestRuntime();
    trackRuntime(sharedRuntime);
    const callCtx: CallContext = {
      runtime: sharedRuntime,
      packageView: sharedRuntime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "US-cb-2",
    } as CallContext;
    const iterations: Iteration[] = reversalIterations(2);
    _storyOrchestratorDeps.runFixCycle = mock(async (_cycle: FixCycle<Finding>, _cycleCtx: FixCycleContext) => ({
      iterations,
      finalFindings: [LINT_FINDING],
      exitReason: "max-attempts-total" as FixCycleExitReason,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;
    await buildRectificationPlan(callCtx).run();

    const ctx = makeTestContext({
      story: makeTestStory({ id: "US-cb-2", title: "CB test" }),
    });
    Object.defineProperty(ctx, "runtime", {
      value: sharedRuntime,
      configurable: true,
    });
    ctx.config = {
      ...ctx.config,
      review: {
        ...ctx.config.review,
        conflictDetection: { enabled: true, maxOscillations: 2 },
      },
    };

    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);

    if (result.action !== "pause") {
      throw new Error(`Expected pause, got ${result.action}`);
    }
    expect(result.reason).toContain("2");
    expect(result.reason ?? "").toMatch(/oscillat/i);
  });
});

describe("AC7: count below maxOscillations escalates", () => {
  test("count=1, maxOscillations=2 → escalate (not pause)", async () => {
    const sharedRuntime = makeTestRuntime();
    trackRuntime(sharedRuntime);
    const callCtx: CallContext = {
      runtime: sharedRuntime,
      packageView: sharedRuntime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "US-cb-3",
    } as CallContext;
    // One resolved-source reappearance produces a count of 1.
    const iterations: Iteration[] = reversalIterations(1);
    _storyOrchestratorDeps.runFixCycle = mock(async (_cycle: FixCycle<Finding>, _cycleCtx: FixCycleContext) => ({
      iterations,
      finalFindings: [LINT_FINDING],
      exitReason: "max-attempts-total" as FixCycleExitReason,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;
    await buildRectificationPlan(callCtx).run();
    expect(getOscillations(sharedRuntime.rectificationOscillations, "US-cb-3")).toBe(1);

    const ctx = makeTestContext({
      story: makeTestStory({ id: "US-cb-3", title: "CB test" }),
    });
    Object.defineProperty(ctx, "runtime", {
      value: sharedRuntime,
      configurable: true,
    });
    ctx.config = {
      ...ctx.config,
      review: {
        ...ctx.config.review,
        conflictDetection: { enabled: true, maxOscillations: 2 },
      },
    };

    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("escalate");
  });
});

describe("AC8: conflictDetection.enabled === false escalates even when count >= maxOscillations", () => {
  test("count=2, maxOscillations=2, enabled=false → escalate", async () => {
    const sharedRuntime = makeTestRuntime();
    trackRuntime(sharedRuntime);
    const callCtx: CallContext = {
      runtime: sharedRuntime,
      packageView: sharedRuntime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "US-cb-4",
    } as CallContext;
    const iterations: Iteration[] = reversalIterations(2);
    _storyOrchestratorDeps.runFixCycle = mock(async (_cycle: FixCycle<Finding>, _cycleCtx: FixCycleContext) => ({
      iterations,
      finalFindings: [LINT_FINDING],
      exitReason: "max-attempts-total" as FixCycleExitReason,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;
    await buildRectificationPlan(callCtx).run();

    const ctx = makeTestContext({
      story: makeTestStory({ id: "US-cb-4", title: "CB test" }),
    });
    Object.defineProperty(ctx, "runtime", {
      value: sharedRuntime,
      configurable: true,
    });
    ctx.config = {
      ...ctx.config,
      review: {
        ...ctx.config.review,
        conflictDetection: { enabled: false, maxOscillations: 2 },
      },
    };

    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("escalate");
  });
});

describe("AC9: missing runtime.rectificationOscillations → escalate", () => {
  test("rectificationOscillations absent on ctx.runtime → escalate", async () => {
    const ctx = buildRuntimeWithoutOscillations();
    trackRuntime(ctx.runtime as NaxRuntime);

    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("escalate");
  });
});

describe("AC10: count=0 on a normal single-source unfixable finding escalates", () => {
  test("count=0 → escalate (not pause)", async () => {
    // No oscillation iterations run, so the count stays at 0. The runtime
    // map is present but empty for this story — a "normal" non-oscillating
    // failure.
    const sharedRuntime = makeTestRuntime();
    trackRuntime(sharedRuntime);
    const callCtx: CallContext = {
      runtime: sharedRuntime,
      packageView: sharedRuntime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "US-cb-6",
    } as CallContext;
    // No source reappears — monotonic single-source progress.
    const iterations: Iteration[] = monotonicIterations();
    _storyOrchestratorDeps.runFixCycle = mock(async (_cycle: FixCycle<Finding>, _cycleCtx: FixCycleContext) => ({
      iterations,
      finalFindings: [LINT_FINDING],
      exitReason: "max-attempts-total" as FixCycleExitReason,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;
    await buildRectificationPlan(callCtx).run();
    expect(getOscillations(sharedRuntime.rectificationOscillations, "US-cb-6")).toBe(0);

    const ctx = makeTestContext({
      story: makeTestStory({ id: "US-cb-6", title: "CB test" }),
    });
    Object.defineProperty(ctx, "runtime", {
      value: sharedRuntime,
      configurable: true,
    });
    ctx.config = {
      ...ctx.config,
      review: {
        ...ctx.config.review,
        conflictDetection: { enabled: true, maxOscillations: 2 },
      },
    };

    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("escalate");
  });
});

describe("AC11: pause emits a notify through the injected interaction channel", () => {
  test("the injected interaction channel receives a request with type === 'notify'", async () => {
    const sharedRuntime = makeTestRuntime();
    trackRuntime(sharedRuntime);
    const callCtx: CallContext = {
      runtime: sharedRuntime,
      packageView: sharedRuntime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "US-cb-7",
    } as CallContext;
    const iterations: Iteration[] = reversalIterations(2);
    _storyOrchestratorDeps.runFixCycle = mock(async (_cycle: FixCycle<Finding>, _cycleCtx: FixCycleContext) => ({
      iterations,
      finalFindings: [LINT_FINDING],
      exitReason: "max-attempts-total" as FixCycleExitReason,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;
    await buildRectificationPlan(callCtx).run();

    const sent: Array<{ type: string }> = [];
    const ctx = makeTestContext({
      story: makeTestStory({ id: "US-cb-7", title: "CB test" }),
    });
    Object.defineProperty(ctx, "runtime", {
      value: sharedRuntime,
      configurable: true,
    });
    Object.defineProperty(ctx, "interaction", {
      value: {
        send: async (req: { type: string }) => {
          sent.push({ type: req.type });
        },
      },
      configurable: true,
    });
    ctx.config = {
      ...ctx.config,
      review: {
        ...ctx.config.review,
        conflictDetection: { enabled: true, maxOscillations: 2 },
      },
    };

    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);

    expect(result.action).toBe("pause");
    expect(sent.some((r) => r.type === "notify")).toBe(true);
  });
});

describe("AC12: interaction.send() throwing does not abort the pause", () => {
  test("interaction throws → still returns action === 'pause'", async () => {
    const sharedRuntime = makeTestRuntime();
    trackRuntime(sharedRuntime);
    const callCtx: CallContext = {
      runtime: sharedRuntime,
      packageView: sharedRuntime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "US-cb-8",
    } as CallContext;
    const iterations: Iteration[] = reversalIterations(2);
    _storyOrchestratorDeps.runFixCycle = mock(async (_cycle: FixCycle<Finding>, _cycleCtx: FixCycleContext) => ({
      iterations,
      finalFindings: [LINT_FINDING],
      exitReason: "max-attempts-total" as FixCycleExitReason,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;
    await buildRectificationPlan(callCtx).run();

    const ctx = makeTestContext({
      story: makeTestStory({ id: "US-cb-8", title: "CB test" }),
    });
    Object.defineProperty(ctx, "runtime", {
      value: sharedRuntime,
      configurable: true,
    });
    Object.defineProperty(ctx, "interaction", {
      value: {
        send: async () => {
          throw new Error("interaction unavailable");
        },
      },
      configurable: true,
    });
    ctx.config = {
      ...ctx.config,
      review: {
        ...ctx.config.review,
        conflictDetection: { enabled: true, maxOscillations: 2 },
      },
    };

    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("pause");
  });
});
