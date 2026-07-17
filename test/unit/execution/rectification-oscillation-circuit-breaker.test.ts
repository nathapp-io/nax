/**
 * Rectification Oscillation Circuit-Breaker (US-002)
 *
 * Three concerns:
 *
 * 1. Pure outcome-count helper (AC1, AC2).
 * 2. `runRectification` records `regressed-different-source` iterations into
 *    `ctx.runtime.rectificationOscillations` (AC3).
 * 3. `decideStageAction` reads the accumulated count, the
 *    `review.conflictDetection.{enabled,maxOscillations}` config, and the
 *    presence of `ctx.runtime.rectificationOscillations` to either escalate
 *    (AC7, AC8, AC9, AC10) or pause with a notify (AC4, AC5, AC6, AC11,
 *    AC12).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
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
import type { NaxRuntime, PipelineContext } from "@/runtime";
import { makeTestContext, makeTestRuntime } from "@test/helpers";
import { LINT_FINDING, makeInspectionOpts, makePlanResult, TEST_RUNNER_FINDING } from "./_post-run-fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Pure outcome-count helper (AC1, AC2)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC1: countOscillationOutcomes counts regressed-different-source outcomes", () => {
  test("returns 2 for [regressed-different-source, partial, regressed-different-source]", () => {
    expect(
      countOscillationOutcomes([
        { outcome: "regressed-different-source" },
        { outcome: "partial" },
        { outcome: "regressed-different-source" },
      ]),
    ).toBe(2);
  });

  test("counts every regressed-different-source outcome in a longer mixed list", () => {
    expect(
      countOscillationOutcomes([
        { outcome: "resolved" },
        { outcome: "regressed-different-source" },
        { outcome: "regressed" },
        { outcome: "regressed-different-source" },
        { outcome: "partial" },
        { outcome: "regressed-different-source" },
      ]),
    ).toBe(3);
  });
});

describe("AC2: countOscillationOutcomes returns 0 when no regressed-different-source outcomes are present", () => {
  test("returns 0 for [resolved, partial, regressed, unchanged]", () => {
    expect(
      countOscillationOutcomes([
        { outcome: "resolved" },
        { outcome: "partial" },
        { outcome: "regressed" },
        { outcome: "unchanged" },
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

const mockImplementerOp: RunOperation<{ story: string }, { success: boolean }, typeof DEFAULT_CONFIG> = {
  kind: "run",
  name: "implementer",
  stage: "run",
  config: testSel as never,
  session: { role: "implementer", lifetime: "warm" },
  build: () => ({
    role: { id: "r", content: "impl", overridable: false },
    task: { id: "t", content: "", overridable: false },
  }),
  parse: () => ({ success: true }),
};

function makePhaseOp(
  name: string,
): RunOperation<{ story: string }, { success: boolean; findings: Finding[] }, typeof DEFAULT_CONFIG> {
  return {
    kind: "run",
    name,
    stage: "verify",
    config: testSel as never,
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
let runtime: NaxRuntime;

function makeCallCtx(storyId: string): CallContext {
  runtime = makeTestRuntime();
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId,
  } as CallContext;
}

function makeIteration(n: number, outcome: Iteration["outcome"]): Iteration {
  return {
    iterationNum: n,
    findingsBefore: [LINT_FINDING],
    fixesApplied: [],
    findingsAfter: [LINT_FINDING],
    outcome,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
  };
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
  runtime = undefined as unknown as NaxRuntime;
});

describe("AC3: runRectification increments rectificationOscillations on regressed-different-source", () => {
  test("one regressed-different-source iteration increases the per-story count by exactly 1", async () => {
    const storyId = "US-osc-inc-1";
    const ctx = makeCallCtx(storyId);
    const store = ctx.runtime.rectificationOscillations;
    expect(store).toBeInstanceOf(Map);
    expect(getOscillations(store, storyId)).toBe(0);

    _storyOrchestratorDeps.runFixCycle = mock(
      async (_cycle: FixCycle<Finding>, _cycleCtx: FixCycleContext) => {
        return {
          iterations: [makeIteration(1, "regressed-different-source")],
          finalFindings: [LINT_FINDING],
          exitReason: "max-attempts-total" as FixCycleExitReason,
          costUsd: 0,
        };
      },
    ) as typeof _storyOrchestratorDeps.runFixCycle;

    const plan = buildRectificationPlan(ctx);
    await plan.run();

    expect(getOscillations(store, storyId)).toBe(1);
  });

  test("two regressed-different-source iterations in a single cycle increase the count by 2", async () => {
    const storyId = "US-osc-inc-2";
    const ctx = makeCallCtx(storyId);
    const store = ctx.runtime.rectificationOscillations;

    _storyOrchestratorDeps.runFixCycle = mock(
      async (_cycle: FixCycle<Finding>, _cycleCtx: FixCycleContext) => {
        return {
          iterations: [
            makeIteration(1, "regressed-different-source"),
            makeIteration(2, "regressed-different-source"),
          ],
          finalFindings: [LINT_FINDING],
          exitReason: "max-attempts-total" as FixCycleExitReason,
          costUsd: 0,
        };
      },
    ) as typeof _storyOrchestratorDeps.runFixCycle;

    const plan = buildRectificationPlan(ctx);
    await plan.run();

    expect(getOscillations(store, storyId)).toBe(2);
  });

  test("non-oscillating outcomes do not increase the per-story count", async () => {
    const storyId = "US-osc-inc-3";
    const ctx = makeCallCtx(storyId);
    const store = ctx.runtime.rectificationOscillations;

    _storyOrchestratorDeps.runFixCycle = mock(
      async (_cycle: FixCycle<Finding>, _cycleCtx: FixCycleContext) => {
        return {
          iterations: [makeIteration(1, "unchanged"), makeIteration(2, "partial")],
          finalFindings: [LINT_FINDING],
          exitReason: "max-attempts-total" as FixCycleExitReason,
          costUsd: 0,
        };
      },
    ) as typeof _storyOrchestratorDeps.runFixCycle;

    const plan = buildRectificationPlan(ctx);
    await plan.run();

    expect(getOscillations(store, storyId)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. decideStageAction — circuit-breaker pause routing (AC4-AC12)
// ─────────────────────────────────────────────────────────────────────────────

function makeBreakerCtx(overrides: {
  storyId?: string;
  enabled?: boolean;
  maxOscillations?: number;
  interaction?: { send: (req: { type: string }) => Promise<void> };
  includeRuntime?: boolean;
  omitOscillations?: boolean;
} = {}): PipelineContext {
  const ctx = makeTestContext({
    story: { id: overrides.storyId ?? "US-cb-1", title: "CB test" } as never,
  });
  // Inject a runtime with the oscillation store — production creates one
  // via createRuntime; tests bypass it so we set the minimum surface needed.
  if (overrides.includeRuntime !== false) {
    const store = overrides.omitOscillations
      ? undefined
      : new Map<string, number>([[overrides.storyId ?? "US-cb-1", 2]]);
    Object.defineProperty(ctx, "runtime", {
      value: {
        rectificationOscillations: store,
        agentManager: ctx.agentManager,
      } as never,
      configurable: true,
    });
  } else {
    Object.defineProperty(ctx, "runtime", {
      value: { rectificationOscillations: undefined } as never,
      configurable: true,
    });
  }

  // Inject the conflictDetection config the breaker reads.
  ctx.config = {
    ...ctx.config,
    review: {
      ...ctx.config.review,
      conflictDetection: {
        enabled: overrides.enabled ?? true,
        maxOscillations: overrides.maxOscillations ?? 2,
      },
    },
  } as typeof ctx.config;

  if (overrides.interaction) {
    Object.defineProperty(ctx, "interaction", {
      value: overrides.interaction,
      configurable: true,
    });
  }

  return ctx;
}

let origAutoCommit: typeof _postRunDeps.autoCommitIfDirty;
let origDetect: typeof _postRunDeps.detectMergeConflict;
let origFailClose: typeof _postRunDeps.failAndClose;

beforeEach(() => {
  origAutoCommit = _postRunDeps.autoCommitIfDirty;
  origDetect = _postRunDeps.detectMergeConflict;
  origFailClose = _postRunDeps.failAndClose;
  _postRunDeps.autoCommitIfDirty = mock(async () => undefined) as typeof _postRunDeps.autoCommitIfDirty;
  _postRunDeps.detectMergeConflict = mock(() => false) as typeof _postRunDeps.detectMergeConflict;
  _postRunDeps.failAndClose = mock(async () => undefined) as typeof _postRunDeps.failAndClose;
});

afterEach(() => {
  _postRunDeps.autoCommitIfDirty = origAutoCommit;
  _postRunDeps.detectMergeConflict = origDetect;
  _postRunDeps.failAndClose = origFailClose;
});

describe("AC4: decideStageAction returns action === 'pause' when the breaker threshold is met", () => {
  test("enabled, maxOscillations=2, count=2 → pause", async () => {
    const ctx = makeBreakerCtx({ enabled: true, maxOscillations: 2, storyId: "US-cb-1" });
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
    const ctx = makeBreakerCtx({ enabled: true, maxOscillations: 2, storyId: "US-cb-2" });
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
    const storyId = "US-cb-3";
    const ctx = makeBreakerCtx({ enabled: true, maxOscillations: 2, storyId });
    (ctx.runtime as { rectificationOscillations: Map<string, number> }).rectificationOscillations.set(
      storyId,
      1,
    );
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
    const ctx = makeBreakerCtx({ enabled: false, maxOscillations: 2, storyId: "US-cb-4" });
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
    const ctx = makeBreakerCtx({ enabled: true, maxOscillations: 2, storyId: "US-cb-5", omitOscillations: true });
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
    const storyId = "US-cb-6";
    const ctx = makeBreakerCtx({ enabled: true, maxOscillations: 2, storyId });
    (ctx.runtime as { rectificationOscillations: Map<string, number> }).rectificationOscillations.set(
      storyId,
      0,
    );
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
    const sent: Array<{ type: string }> = [];
    const ctx = makeBreakerCtx({
      enabled: true,
      maxOscillations: 2,
      storyId: "US-cb-7",
      interaction: { send: async (req) => { sent.push({ type: req.type }); } },
    });
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
    const ctx = makeBreakerCtx({
      enabled: true,
      maxOscillations: 2,
      storyId: "US-cb-8",
      interaction: {
        send: async () => {
          throw new Error("interaction unavailable");
        },
      },
    });
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
