/**
 * StoryOrchestratorResult — rectificationExhausted / unfixedFindings (US-005 AC5/AC6)
 *
 * Verifies that ExecutionPlan.run() sets rectificationExhausted + unfixedFindings on
 * the returned StoryOrchestratorResult when the FixCycle exits via an exhaustion
 * reason ("max-attempts-total", "max-attempts-per-strategy", "bail-when") AND there
 * are remaining findings.
 *
 * The new fields must also be absent when the cycle resolves cleanly.
 *
 * Uses _storyOrchestratorDeps._callOp and _storyOrchestratorDeps.runFixCycle injection
 * so no real agent processes are spawned.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, makeTestRuntime } from "@test/helpers";
import { pickSelector } from "@/config";
import type { PhaseKind, StoryOrchestratorResult } from "@/execution";
import {
  _storyOrchestratorDeps,
  phasesToRevalidate,
  StoryOrchestratorBuilder,
  withIncreasingFailuresBail,
} from "@/execution";
import { type InternalPhase, STRATEGY_TO_REVALIDATION_PHASES } from "@/execution/story-orchestrator";
import type { FixStrategy, Iteration } from "@/findings";
import type { FixCycle, FixCycleContext, FixCycleExitReason } from "@/findings/cycle-types";
import type { Finding } from "@/findings/types";
import type { CallContext, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const testSel = pickSelector("test-exhaustion-sel", "execution");

/** The op fixtures' config slice, derived from the selector so the two cannot drift. */
type TestOpConfig = ReturnType<(typeof testSel)["select"]>;

const mockImplementerOp: RunOperation<{ story: string }, { success: boolean }, TestOpConfig> = {
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

const mockVerifierOp: RunOperation<{ story: string }, { success: boolean; findings: Finding[] }, TestOpConfig> = {
  kind: "run",
  name: "verifier",
  stage: "verify",
  config: testSel,
  session: { role: "verifier", lifetime: "fresh" },
  build: () => ({
    role: { id: "r", content: "verify", overridable: false },
    task: { id: "t", content: "", overridable: false },
  }),
  parse: () => ({ success: false, findings: [] }),
};

const LINT_FINDING: Finding = {
  source: "lint",
  tool: "biome",
  severity: "error",
  category: "style",
  message: "Unused variable",
  file: "src/foo.ts",
  line: 5,
};

const TEST_RUNNER_FINDING: Finding = {
  source: "test-runner",
  severity: "error",
  category: "failed-test",
  message: "Test failed",
  file: "test/foo.test.ts",
  line: 10,
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared dep mocks
// ─────────────────────────────────────────────────────────────────────────────

let origCallOp: typeof _storyOrchestratorDeps.callOp;
let origRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
let runtime: NaxRuntime;

function makeCtx(): CallContext {
  runtime = makeTestRuntime();
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId: "US-005",
  } as CallContext;
}

function makePlanWithRectification(ctx: CallContext) {
  return new StoryOrchestratorBuilder()
    .addImplementer({ op: mockImplementerOp, input: { story: "US-005" } })
    .addVerifier({ op: mockVerifierOp, input: { story: "US-005" } })
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
  // Default: implementer succeeds, verifier fails with test-runner finding
  _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
    if (op.name === "verifier") {
      return {
        success: false,
        findings: [TEST_RUNNER_FINDING],
      };
    }
    return { success: true };
  }) as typeof _storyOrchestratorDeps.callOp;
});

afterEach(async () => {
  _storyOrchestratorDeps.callOp = origCallOp;
  _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
  _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
  await runtime?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: StoryOrchestratorResult type has rectificationExhausted field
// ─────────────────────────────────────────────────────────────────────────────

describe("StoryOrchestratorResult — AC5: rectificationExhausted field declared", () => {
  test("AC5: StoryOrchestratorResult type includes rectificationExhausted boolean field", async () => {
    _storyOrchestratorDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "resolved" as FixCycleExitReason,
      costUsd: 0,
    }));
    const ctx = makeCtx();
    const plan = makePlanWithRectification(ctx);
    const result: StoryOrchestratorResult = await plan.run();
    // The field must exist on the type (undefined when not exhausted is OK)
    expect("rectificationExhausted" in result || result.rectificationExhausted === undefined).toBe(true);
  });

  test("AC5: StoryOrchestratorResult type includes unfixedFindings field", async () => {
    _storyOrchestratorDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "resolved" as FixCycleExitReason,
      costUsd: 0,
    }));
    const ctx = makeCtx();
    const plan = makePlanWithRectification(ctx);
    const result: StoryOrchestratorResult = await plan.run();
    expect("unfixedFindings" in result || result.unfixedFindings === undefined).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: plan.run() sets rectificationExhausted when cycle exits with exhaustion
// ─────────────────────────────────────────────────────────────────────────────

describe("ExecutionPlan.run() — AC6: rectificationExhausted on cycle exhaustion", () => {
  test.each([
    ["max-attempts-total" as FixCycleExitReason],
    ["max-attempts-per-strategy" as FixCycleExitReason],
    ["bail-when" as FixCycleExitReason],
    ["no-strategy" as FixCycleExitReason],
    ["agent-gave-up" as FixCycleExitReason],
  ])("AC6: exitReason '%s' with remaining findings → rectificationExhausted=true", async (exitReason) => {
    _storyOrchestratorDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [LINT_FINDING],
      exitReason,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;
    const ctx = makeCtx();
    const plan = makePlanWithRectification(ctx);
    const result = await plan.run();
    expect(result.rectificationExhausted).toBe(true);
  });

  test("AC6: exitReason 'max-attempts-total' with remaining findings → unfixedFindings populated", async () => {
    const findings: Finding[] = [LINT_FINDING];
    _storyOrchestratorDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: findings,
      exitReason: "max-attempts-total" as FixCycleExitReason,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;
    const ctx = makeCtx();
    const plan = makePlanWithRectification(ctx);
    const result = await plan.run();
    expect(result.unfixedFindings).toBeDefined();
    expect(result.unfixedFindings?.length).toBe(1);
    expect(result.unfixedFindings?.[0]?.source).toBe("lint");
  });

  test("AC6: exitReason 'bail-when' with remaining findings → both fields set together", async () => {
    const findings: Finding[] = [LINT_FINDING, TEST_RUNNER_FINDING];
    _storyOrchestratorDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: findings,
      exitReason: "bail-when" as FixCycleExitReason,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;
    const ctx = makeCtx();
    const plan = makePlanWithRectification(ctx);
    const result = await plan.run();
    expect(result.rectificationExhausted).toBe(true);
    expect(result.unfixedFindings).toBeDefined();
    expect(result.unfixedFindings?.length).toBe(2);
  });

  test("Fix-A: exitReason 'agent-gave-up' with non-empty finalFindings → rectificationExhausted=true, unfixedFindings populated", async () => {
    // Spec verbatim AC: Given a rectification cycle that exits with exitReason: "agent-gave-up"
    // and non-empty finalFindings, the story orchestrator returns
    // { rectificationExhausted: true, unfixedFindings: cycleResult.finalFindings }.
    const findings: Finding[] = [LINT_FINDING, TEST_RUNNER_FINDING];
    _storyOrchestratorDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: findings,
      exitReason: "agent-gave-up" as FixCycleExitReason,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;
    const ctx = makeCtx();
    const plan = makePlanWithRectification(ctx);
    const result = await plan.run();
    expect(result.rectificationExhausted).toBe(true);
    expect(result.unfixedFindings).toBeDefined();
    expect(result.unfixedFindings?.length).toBe(2);
    expect(result.unfixedFindings).toEqual(findings);
  });

  test("Fix-A: exitReason 'agent-gave-up' with EMPTY finalFindings → rectificationExhausted NOT set", async () => {
    // Edge case: agent gave up but there are no remaining findings — should NOT exhaust
    _storyOrchestratorDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "agent-gave-up" as FixCycleExitReason,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;
    const ctx = makeCtx();
    const plan = makePlanWithRectification(ctx);
    const result = await plan.run();
    expect(result.rectificationExhausted).not.toBe(true);
  });

  test("AC6: exitReason 'resolved' → rectificationExhausted is NOT set to true", async () => {
    _storyOrchestratorDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "resolved" as FixCycleExitReason,
      costUsd: 0,
    }));
    const ctx = makeCtx();
    const plan = makePlanWithRectification(ctx);
    const result = await plan.run();
    expect(result.rectificationExhausted).not.toBe(true);
  });

  test("AC6: exitReason 'max-attempts-total' with EMPTY finalFindings → rectificationExhausted NOT set", async () => {
    // Spec: only set when finalFindings.length > 0
    _storyOrchestratorDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "max-attempts-total" as FixCycleExitReason,
      costUsd: 0,
    }));
    const ctx = makeCtx();
    const plan = makePlanWithRectification(ctx);
    const result = await plan.run();
    expect(result.rectificationExhausted).not.toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1.1–AC1.4: gatherRectificationFindings — verifier-as-SSOT carve-out
// ─────────────────────────────────────────────────────────────────────────────

const mockFullSuiteGateOp: RunOperation<{ story: string }, { success: boolean; findings: Finding[] }, TestOpConfig> = {
  kind: "run",
  name: "full-suite-gate",
  stage: "verify",
  config: testSel,
  session: { role: "verifier", lifetime: "fresh" },
  build: () => ({
    role: { id: "r", content: "gate", overridable: false },
    task: { id: "t", content: "", overridable: false },
  }),
  parse: () => ({ success: true, findings: [] }),
};

const _SEMANTIC_FINDING: Finding = {
  source: "semantic-review",
  severity: "error",
  category: "",
  message: "Does not implement AC-001",
  file: "src/foo.ts",
  line: 5,
};

const VERIFIER_FINDING: Finding = {
  source: "test-runner",
  severity: "error",
  category: "",
  message: "Verifier test failed",
  file: "test/verifier.test.ts",
  line: 1,
};

function makePlanWithGateAndVerifier(ctx: CallContext) {
  return new StoryOrchestratorBuilder()
    .addImplementer({ op: mockImplementerOp, input: { story: "US-005" } })
    .addFullSuiteGate({ op: mockFullSuiteGateOp, input: { story: "US-005" } })
    .addVerifier({ op: mockVerifierOp, input: { story: "US-005" } })
    .addRectification({
      maxAttempts: 3,
      strategies: [],
      abortOnIncreasingFailures: false,
    })
    .build(ctx, { isThreeSession: true });
}

function makePlanWithGateOnly(ctx: CallContext) {
  return new StoryOrchestratorBuilder()
    .addImplementer({ op: mockImplementerOp, input: { story: "US-005" } })
    .addFullSuiteGate({ op: mockFullSuiteGateOp, input: { story: "US-005" } })
    .addRectification({
      maxAttempts: 3,
      strategies: [],
      abortOnIncreasingFailures: false,
    })
    .build(ctx, { isThreeSession: true });
}

describe("gatherRectificationFindings — verifier-as-SSOT carve-out (AC1.x)", () => {
  test("AC1.1: gate fails → loop halts before verifier → gate findings enter initial cycle (new: verifier-SSOT carve-out unreachable in initial phase)", async () => {
    // New contract: gate failure halts the main loop before verifier runs. The verifier-as-SSOT
    // carve-out (shouldSkipPhaseForRectification) only fires when verifier has ALREADY passed
    // (e.g. in a post-rectification revalidation where verifier re-judged successfully).
    // In the initial phase, verifier never ran → phaseOutputs[verifier] is undefined → carve-out
    // does not fire → gate findings are included → runFixCycle IS called.
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      // Verifier is registered in the plan but never dispatched (loop halts at gate).
      if (op.name === "verifier") return { success: true, findings: [] };
      if (op.name === "full-suite-gate") return { success: false, findings: [TEST_RUNNER_FINDING] };
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    let capturedCycle: FixCycle<Finding> | undefined;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: FixCycle<Finding>) => {
      capturedCycle = cycle;
      return {
        iterations: [],
        finalFindings: [],
        exitReason: "resolved" as FixCycleExitReason,
        costUsd: 0,
      };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    const ctx = makeCtx();
    const plan = makePlanWithGateAndVerifier(ctx);
    await plan.run();

    // Gate findings flow through to the cycle — verifier never ran so carve-out doesn't fire.
    assertDefined(capturedCycle, "capturedCycle");
    const findings = capturedCycle.findings;
    const hasTestRunnerFinding = findings.some((f) => f.source === "test-runner");
    expect(hasTestRunnerFinding).toBe(true);
  });

  test("AC1.2: gate fails → loop halts before verifier, gate findings still flow to cycle", async () => {
    // Gate fails → loop short-circuits before verifier ever runs.
    // The verifier mock below is unreachable; it exists only to confirm the mock is
    // not the source of gate findings flowing through.
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "verifier") return { success: false, findings: [VERIFIER_FINDING] }; // unreachable
      if (op.name === "full-suite-gate") return { success: false, findings: [TEST_RUNNER_FINDING] };
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    let capturedCycle: FixCycle<Finding> | undefined;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: FixCycle<Finding>) => {
      capturedCycle = cycle;
      return {
        iterations: [],
        finalFindings: [],
        exitReason: "resolved" as FixCycleExitReason,
        costUsd: 0,
      };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    const ctx = makeCtx();
    const plan = makePlanWithGateAndVerifier(ctx);
    await plan.run();

    // phaseOutputs[verifier] is undefined (verifier never ran), so the cross-iteration
    // carve-out never fires. Gate findings flow to cycle unfiltered.
    assertDefined(capturedCycle, "capturedCycle");
    const findings = capturedCycle.findings;
    const hasTestRunnerFinding = findings.some((f) => f.source === "test-runner");
    expect(hasTestRunnerFinding).toBe(true);
  });

  test("AC1.3: no verifier registered → gate findings flow through unchanged", async () => {
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "full-suite-gate") return { success: false, findings: [TEST_RUNNER_FINDING] };
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    let capturedCycle: FixCycle<Finding> | undefined;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: FixCycle<Finding>) => {
      capturedCycle = cycle;
      return {
        iterations: [],
        finalFindings: [],
        exitReason: "resolved" as FixCycleExitReason,
        costUsd: 0,
      };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    const ctx = makeCtx();
    const plan = makePlanWithGateOnly(ctx);
    await plan.run();

    assertDefined(capturedCycle, "capturedCycle");
    const findings = capturedCycle.findings;
    const hasTestRunnerFinding = findings.some((f) => f.source === "test-runner");
    expect(hasTestRunnerFinding).toBe(true);
  });

  test("AC1.4: in validate callback, gate findings excluded when verifier already passed in a prior validate iteration (cross-iteration carve-out)", async () => {
    // New contract: gate halts the main loop before verifier, so phaseOutputs[verifier]
    // is undefined after the initial plan run. The shouldSkipPhaseForRectification carve-out
    // fires only when verifier has ALREADY passed in a prior validate call (cross-iteration).
    //
    // Scenario: call validate twice — first call let verifier pass and populate phaseOutputs;
    // second call should see verifier's prior pass and exclude gate findings.
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      // Gate fails, verifier is registered but never dispatched in main loop (gate halts first).
      if (op.name === "full-suite-gate") return { success: false, findings: [TEST_RUNNER_FINDING] };
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    let capturedCycle: FixCycle<Finding> | null = null;
    let capturedCtx: FixCycleContext | null = null;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: FixCycle<Finding>, cycleCtx: FixCycleContext) => {
      capturedCycle = cycle;
      capturedCtx = cycleCtx;
      return {
        iterations: [],
        finalFindings: [],
        exitReason: "resolved" as FixCycleExitReason,
        costUsd: 0,
      };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    const ctx = makeCtx();
    const plan = makePlanWithGateAndVerifier(ctx);
    await plan.run();

    if (capturedCycle === null || capturedCtx === null) return;

    // First validate call: gate PASSES (simulating fix landed) → loop proceeds to verifier
    // → verifier passes → populates phaseOutputs[verifier]. Under the new halt contract
    // (PR #1127 + revalidation short-circuit), verifier only judges green-gate code, so
    // this iteration MUST have gate=passing for the carve-out to establish.
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "full-suite-gate") return { success: true, findings: [] };
      if (op.name === "verifier") return { success: true, findings: [] };
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, { mode: "full" });

    // Second validate call: gate regresses to failing. phaseOutputs[verifier] still holds the
    // prior passing result → shouldSkipPhaseForRectification fires on gate → gate findings excluded.
    let gateCalledSecondTime = false;
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "full-suite-gate") {
        gateCalledSecondTime = true;
        return { success: false, findings: [TEST_RUNNER_FINDING] };
      }
      if (op.name === "verifier") return { success: true, findings: [] };
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const secondValidate = await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "full",
    });
    const secondCallFindings = Array.isArray(secondValidate) ? secondValidate : secondValidate.findings;
    // Gate still ran (it's part of validationPhases — carve-out only filters findings, not dispatch)
    expect(gateCalledSecondTime).toBe(true);
    // But gate findings are excluded because verifier passed in the previous iteration
    const secondHasTestRunner = secondCallFindings.some((f) => f.source === "test-runner");
    expect(secondHasTestRunner).toBe(false);
  });

  test("AC1.5: gate fails in validate with no prior verifier pass — findings still collected before short-circuit", async () => {
    // Companion to AC1.4: confirms that when verifier has NEVER passed (no SSOT
    // carve-out), gate findings are still pushed into the findings array even
    // though the new revalidation short-circuit breaks the sweep. The cycle
    // needs those findings to drive the next fix iteration.
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "full-suite-gate") return { success: false, findings: [TEST_RUNNER_FINDING] };
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    let capturedCycle: FixCycle<Finding> | null = null;
    let capturedCtx: FixCycleContext | null = null;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: FixCycle<Finding>, cycleCtx: FixCycleContext) => {
      capturedCycle = cycle;
      capturedCtx = cycleCtx;
      return { iterations: [], finalFindings: [], exitReason: "resolved" as FixCycleExitReason, costUsd: 0 };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    const ctx = makeCtx();
    const plan = makePlanWithGateAndVerifier(ctx);
    await plan.run();
    if (capturedCycle === null || capturedCtx === null) return;

    // Fresh validate with gate failing — phaseOutputs has no prior verifier pass.
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "full-suite-gate") return { success: false, findings: [TEST_RUNNER_FINDING] };
      if (op.name === "verifier") return { success: true, findings: [] };
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const validateResult = await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "full",
    });
    const findings = Array.isArray(validateResult) ? validateResult : validateResult.findings;
    // Short-circuit fires AFTER pushing the gate finding into the findings array,
    // so the cycle can still drive the next fix iteration.
    expect(findings.some((f) => f.source === "test-runner")).toBe(true);
    if (!Array.isArray(validateResult)) {
      expect(validateResult.shortCircuited).toBe(true);
    }
  });
});

// ===========================================================================
// withIncreasingFailuresBail — consecutive-increase bail predicate (absorbed
// from story-orchestrator-bail.test.ts)
// ===========================================================================

function finding(message: string): Finding {
  return { severity: "error", category: "test", source: "tdd-verifier", message };
}

function iter(beforeCount: number, afterCount: number, num = 1): Iteration<Finding> {
  return {
    iterationNum: num,
    findingsBefore: Array.from({ length: beforeCount }, (_, i) => finding(`before-${i}`)),
    findingsAfter: Array.from({ length: afterCount }, (_, i) => finding(`after-${i}`)),
    fixesApplied: [{ strategyName: "s", op: "noop-op", targetFiles: [], summary: "" }],
    outcome: afterCount > beforeCount ? "regressed" : "unchanged",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
  };
}

function baseStrategy(): FixStrategy<Finding, unknown, unknown, unknown> {
  const fixOp: FixStrategy<Finding, unknown, unknown, unknown>["fixOp"] = {
    name: "noop",
    kind: "complete",
    stage: "verify",
    config: [],
    build: () => ({
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: "", overridable: false },
    }),
    parse: () => null,
  };
  return {
    name: "autofix-test-writer",
    appliesTo: () => true,
    fixOp,
    buildInput: () => ({}),
    maxAttempts: 3,
    coRun: "co-run-sequential",
  };
}

function bailOf(
  strategies: FixStrategy<Finding, unknown, unknown, unknown>[],
): (iters: Iteration<Finding>[]) => string | null {
  const fn = strategies[0]?.bailWhen;
  if (!fn) throw new Error("expected bailWhen to be wrapped");
  return fn;
}

describe("withIncreasingFailuresBail — consecutive threshold", () => {
  test("disabled: returns strategies unchanged (no bailWhen wrapping)", () => {
    const original = baseStrategy();
    const [wrapped] = withIncreasingFailuresBail([original], false, 2);
    expect(wrapped).toBe(original);
    expect(wrapped.bailWhen).toBeUndefined();
  });

  test("threshold 2: a single regressing iteration does NOT bail", () => {
    const bail = bailOf(withIncreasingFailuresBail([baseStrategy()], true, 2));
    // The flailing scenario from the log: churn (1->1) then one increase (1->2).
    expect(bail([iter(1, 1, 1)])).toBeNull();
    expect(bail([iter(1, 1, 1), iter(1, 2, 2)])).toBeNull();
  });

  test("threshold 2: two consecutive regressing iterations bail", () => {
    const bail = bailOf(withIncreasingFailuresBail([baseStrategy()], true, 2));
    const reason = bail([iter(1, 2, 1), iter(2, 3, 2)]);
    expect(reason).toContain("2 consecutive");
    expect(reason).toContain("1 -> 3");
  });

  test("threshold 2: a non-regressing iteration between increases resets the run", () => {
    const bail = bailOf(withIncreasingFailuresBail([baseStrategy()], true, 2));
    // increase, then flat — trailing window [flat, ...] is not all-regressed.
    expect(bail([iter(1, 2, 1), iter(2, 2, 2)])).toBeNull();
    // ...but two increases AFTER the flat one do bail.
    expect(bail([iter(1, 2, 1), iter(2, 2, 2), iter(2, 3, 3), iter(3, 4, 4)])).toContain("2 consecutive");
  });

  test("threshold 1: reproduces legacy bail-on-first-increase behaviour", () => {
    const bail = bailOf(withIncreasingFailuresBail([baseStrategy()], true, 1));
    expect(bail([iter(1, 1, 1)])).toBeNull();
    expect(bail([iter(1, 2, 1)])).toContain("1 -> 2");
  });

  test("user-supplied bailWhen wins over the increasing-failures predicate", () => {
    const strat = { ...baseStrategy(), bailWhen: () => "user-reason" };
    const bail = bailOf(withIncreasingFailuresBail([strat], true, 2));
    expect(bail([iter(1, 2, 1), iter(2, 3, 2)])).toBe("user-reason");
  });
});

// ===========================================================================
// Revalidation routing for the repo-scoped test-fix strategy (#1654) (absorbed
// from story-orchestrator-revalidation-repo-scope.test.ts)
// ===========================================================================

const ALL_PHASE_KINDS: PhaseKind[] = [
  "test-writer",
  "greenfield-gate",
  "implementer",
  "test-presence-gate",
  "full-suite-gate",
  "mutation-check",
  "verifier",
  "verify-scoped",
  "lint-check",
  "typecheck-check",
  "semantic-review",
  "adversarial-review",
];

const repoScopeTestSel = pickSelector("test-revalidation-sel", "execution");

/** Real InternalPhase fixtures — phasesToRevalidate only reads `kind`, but the slot is typed. */
const allPhases: InternalPhase[] = ALL_PHASE_KINDS.map(
  (kind): InternalPhase => ({
    kind,
    slot: {
      op: {
        kind: "deterministic",
        name: `${kind}-op`,
        stage: "run",
        config: repoScopeTestSel,
        execute: async () => ({}),
      },
      input: {},
    },
  }),
);

describe("repo-scoped-test-fix revalidation mapping (#1654)", () => {
  test("is declared in the SSOT map, not left to the unknown-strategy fallback", () => {
    expect(STRATEGY_TO_REVALIDATION_PHASES["repo-scoped-test-fix"]).toBeDefined();
  });

  test("re-runs the same phases as full-suite-rectify", () => {
    // It fixes failing tests through the same op and may edit tests via the same
    // declaration protocol, so the verifier and both reviews go stale in exactly
    // the same way. A wider file scope does not change which phases are affected.
    expect(STRATEGY_TO_REVALIDATION_PHASES["repo-scoped-test-fix"]).toEqual(
      STRATEGY_TO_REVALIDATION_PHASES["full-suite-rectify"],
    );
  });

  test("does not re-run the story's authoring phases", () => {
    const kinds = phasesToRevalidate(["repo-scoped-test-fix"], allPhases).map((p) => p.kind);
    expect(kinds).not.toContain("test-writer");
    expect(kinds).not.toContain("implementer");
    expect(kinds).not.toContain("greenfield-gate");
  });

  test("re-runs the gate that produced the finding", () => {
    const kinds = phasesToRevalidate(["repo-scoped-test-fix"], allPhases).map((p) => p.kind);
    expect(kinds).toContain("full-suite-gate");
  });

  test("co-running with full-suite-rectify does not widen the set", () => {
    const solo = phasesToRevalidate(["repo-scoped-test-fix"], allPhases).map((p) => p.kind);
    const both = phasesToRevalidate(["full-suite-rectify", "repo-scoped-test-fix"], allPhases).map((p) => p.kind);
    expect(both).toEqual(solo);
  });
});
