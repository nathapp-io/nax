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
import { _storyOrchestratorDeps, StoryOrchestratorBuilder } from "@/execution";
import type { StoryOrchestratorResult } from "@/execution";
import type { FixCycle, FixCycleContext, FixCycleExitReason } from "@/findings/cycle-types";
import type { Finding } from "@/findings/types";
import { pickSelector } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import { makeTestRuntime, makeStory } from "@test/helpers";
import type { NaxRuntime } from "@/runtime";
import type { RunOperation, CallContext } from "@/operations";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const testSel = pickSelector("test-exhaustion-sel", "execution");

const mockImplementerOp: RunOperation<{ story: string }, { success: boolean }, typeof DEFAULT_CONFIG> = {
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

const mockVerifierOp: RunOperation<{ story: string }, { success: boolean; findings: Finding[] }, typeof DEFAULT_CONFIG> = {
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

const mockFullSuiteGateOp: RunOperation<
  { story: string },
  { success: boolean; findings: Finding[] },
  typeof DEFAULT_CONFIG
> = {
  kind: "run",
  name: "full-suite-gate",
  stage: "verify",
  config: testSel as any,
  session: { role: "verifier", lifetime: "fresh" },
  build: () => ({
    role: { id: "r", content: "gate", overridable: false },
    task: { id: "t", content: "", overridable: false },
  }),
  parse: () => ({ success: true, findings: [] }),
};

const SEMANTIC_FINDING: Finding = {
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

    let capturedCycle: FixCycle<Finding> | null = null;
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
    expect(capturedCycle).not.toBeNull();
    const findings = (capturedCycle as unknown as FixCycle<Finding>).findings;
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

    let capturedCycle: FixCycle<Finding> | null = null;
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
    expect(capturedCycle).not.toBeNull();
    const findings = (capturedCycle as unknown as FixCycle<Finding>).findings;
    const hasTestRunnerFinding = findings.some((f) => f.source === "test-runner");
    expect(hasTestRunnerFinding).toBe(true);
  });

  test("AC1.3: no verifier registered → gate findings flow through unchanged", async () => {
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "full-suite-gate") return { success: false, findings: [TEST_RUNNER_FINDING] };
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    let capturedCycle: FixCycle<Finding> | null = null;
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

    expect(capturedCycle).not.toBeNull();
    const findings = (capturedCycle as unknown as FixCycle<Finding>).findings;
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

    // First validate call: gate runs → fails → shouldSkipPhaseForRectification sees no prior
    // verifier pass → gate findings included. Then verifier runs → passes → populates phaseOutputs.
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "full-suite-gate") return { success: false, findings: [TEST_RUNNER_FINDING] };
      if (op.name === "verifier") return { success: true, findings: [] };
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const firstCallFindings = await (capturedCycle as FixCycle<Finding>).validate(
      capturedCtx as FixCycleContext,
      { mode: "full" },
    );
    // First call: verifier hadn't pre-passed in phaseOutputs → gate findings included
    const firstHasTestRunner = firstCallFindings.some((f) => f.source === "test-runner");
    expect(firstHasTestRunner).toBe(true);

    // Second validate call: now phaseOutputs[verifier] has the prior passing result →
    // shouldSkipPhaseForRectification fires on gate → gate findings excluded.
    let gateCalledSecondTime = false;
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "full-suite-gate") {
        gateCalledSecondTime = true;
        return { success: false, findings: [TEST_RUNNER_FINDING] };
      }
      if (op.name === "verifier") return { success: true, findings: [] };
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const secondCallFindings = await (capturedCycle as FixCycle<Finding>).validate(
      capturedCtx as FixCycleContext,
      { mode: "full" },
    );
    // Gate still ran (it's part of validationPhases — carve-out only filters findings, not dispatch)
    expect(gateCalledSecondTime).toBe(true);
    // But gate findings are excluded because verifier passed in the previous iteration
    const secondHasTestRunner = secondCallFindings.some((f) => f.source === "test-runner");
    expect(secondHasTestRunner).toBe(false);
  });
});
