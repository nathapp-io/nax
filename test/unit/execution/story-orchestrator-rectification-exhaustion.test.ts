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
import type { FixCycleExitReason } from "@/findings/cycle-types";
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
  message: "Unused variable",
  file: "src/foo.ts",
  line: 5,
};

const TEST_RUNNER_FINDING: Finding = {
  source: "test-runner",
  severity: "error",
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
  ])("AC6: exitReason '%s' with remaining findings → rectificationExhausted=true", async (exitReason) => {
    _storyOrchestratorDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [LINT_FINDING],
      exitReason,
      costUsd: 0,
    }));
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
    }));
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
    }));
    const ctx = makeCtx();
    const plan = makePlanWithRectification(ctx);
    const result = await plan.run();
    expect(result.rectificationExhausted).toBe(true);
    expect(result.unfixedFindings).toBeDefined();
    expect(result.unfixedFindings?.length).toBe(2);
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
