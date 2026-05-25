/**
 * phasesToRevalidate — AC3.1–AC3.6
 *
 * Tests the private `phasesToRevalidate` function via the `validate` callback
 * exposed through `runFixCycle` injection. We:
 *   1. Build a plan with ALL revalidation phases registered.
 *   2. Run the plan, which triggers `runFixCycle` capturing the cycle.
 *   3. Manually invoke `capturedCycle.validate(ctx, opts)` with different
 *      `strategiesRun` values.
 *   4. Track which op names were called on `callOp` during that validate
 *      to determine which phases were re-run.
 *
 * Verifier is always excluded regardless of opts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _storyOrchestratorDeps, StoryOrchestratorBuilder } from "@/execution";
import type { FixCycle, FixCycleContext, FixCycleExitReason } from "@/findings/cycle-types";
import type { Finding } from "@/findings/types";
import { pickSelector, DEFAULT_CONFIG } from "@/config";
import { makeTestRuntime } from "@test/helpers";
import type { NaxRuntime } from "@/runtime";
import type { RunOperation, CallContext } from "@/operations";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const testSel = pickSelector("test-revalidation-sel", "execution");

const mockImplementerOp: RunOperation<{ story: string }, { success: boolean }, typeof DEFAULT_CONFIG> = {
  kind: "run",
  name: "implementer",
  stage: "run",
  config: testSel as any,
  session: { role: "implementer", lifetime: "warm" },
  build: () => ({
    role: { id: "r", content: "impl", overridable: false },
    task: { id: "t", content: "", overridable: false },
  }),
  parse: () => ({ success: true }),
};

function makePhaseOp(
  name: string,
  stage: string,
  role: string,
): RunOperation<{ story: string }, { success: boolean; findings: Finding[] }, typeof DEFAULT_CONFIG> {
  return {
    kind: "run",
    name,
    stage: stage as any,
    config: testSel as any,
    session: { role: role as any, lifetime: "fresh" },
    build: () => ({
      role: { id: "r", content: name, overridable: false },
      task: { id: "t", content: "", overridable: false },
    }),
    parse: () => ({ success: false, findings: [] }),
  };
}

const mockVerifierOp = makePhaseOp("verifier", "verify", "verifier");
const mockFullSuiteGateOp = makePhaseOp("full-suite-gate", "verify", "verifier");
const mockVerifyScopedOp = makePhaseOp("verify-scoped", "verify", "verifier");
const mockLintCheckOp = makePhaseOp("lint-check", "verify", "verifier");
const mockTypecheckCheckOp = makePhaseOp("typecheck-check", "verify", "verifier");
const mockSemanticReviewOp = makePhaseOp("semantic-review", "review", "reviewer-semantic");
const mockAdversarialReviewOp = makePhaseOp("adversarial-review", "review", "reviewer-adversarial");

const LINT_FINDING: Finding = {
  source: "lint",
  tool: "biome",
  severity: "error",
  message: "Unused variable",
  file: "src/foo.ts",
  line: 5,
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared state
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
    storyId: "US-revalidation",
  } as CallContext;
}

/**
 * Build a plan with ALL revalidation phases + implementer + verifier + rectification.
 * Verifier fails initially so runFixCycle gets called.
 */
function makeFullPlan(ctx: CallContext) {
  return new StoryOrchestratorBuilder()
    .addImplementer({ op: mockImplementerOp, input: { story: "US-revalidation" } })
    .addFullSuiteGate({ op: mockFullSuiteGateOp, input: { story: "US-revalidation" } })
    .addVerifier({ op: mockVerifierOp, input: { story: "US-revalidation" } })
    .addVerifyScoped({ op: mockVerifyScopedOp, input: { story: "US-revalidation" } })
    .addLintCheck({ op: mockLintCheckOp, input: { story: "US-revalidation" } })
    .addTypecheckCheck({ op: mockTypecheckCheckOp, input: { story: "US-revalidation" } })
    .addSemanticReview({ op: mockSemanticReviewOp, input: { story: "US-revalidation" } })
    .addAdversarialReview({ op: mockAdversarialReviewOp, input: { story: "US-revalidation" } })
    .addRectification({
      maxAttempts: 3,
      strategies: [],
      abortOnIncreasingFailures: false,
    })
    .build(ctx, { isThreeSession: true });
}

/**
 * Set up the initial callOp so:
 *  - implementer: succeeds
 *  - verifier: fails (so runFixCycle is triggered)
 *  - all other phases: fail with a lint finding (so they appear in initialFindings)
 */
function setupInitialCallOp() {
  _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
    if (op.name === "implementer") return { success: true };
    if (op.name === "verifier") return { success: false, findings: [LINT_FINDING] };
    // All other phases fail to ensure runFixCycle is called
    return { success: false, findings: [LINT_FINDING] };
  }) as typeof _storyOrchestratorDeps.callOp;
}

/**
 * Run the plan to capture the FixCycle, then set up a fresh callOp tracker
 * for measuring which phases are called during validate.
 * Returns { capturedCycle, capturedCtx, calledOps }.
 */
async function captureAndSetupValidate(ctx: CallContext): Promise<{
  capturedCycle: FixCycle<Finding> | null;
  capturedCtx: FixCycleContext | null;
  getCalledOpsInValidate: () => Set<string>;
}> {
  setupInitialCallOp();

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

  const plan = makeFullPlan(ctx);
  await plan.run();

  // Now set up a tracking callOp for the validate call
  const calledOps = new Set<string>();

  _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
    calledOps.add(op.name);
    return { success: true, passed: true, findings: [] };
  }) as typeof _storyOrchestratorDeps.callOp;

  return {
    capturedCycle,
    capturedCtx,
    getCalledOpsInValidate: () => calledOps,
  };
}

beforeEach(() => {
  origCallOp = _storyOrchestratorDeps.callOp;
  origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
  origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
  _storyOrchestratorDeps.captureGitRef = mock(async () => "HEAD");
});

afterEach(async () => {
  _storyOrchestratorDeps.callOp = origCallOp;
  _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
  _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
  await runtime?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3.1: strategiesRun=undefined → all non-verifier phases
// ─────────────────────────────────────────────────────────────────────────────

describe("phasesToRevalidate — AC3.1: undefined strategiesRun → all non-verifier phases", () => {
  test("AC3.1: strategiesRun=undefined → verifier excluded, all other phases called", async () => {
    const ctx = makeCtx();
    const { capturedCycle, capturedCtx, getCalledOpsInValidate } = await captureAndSetupValidate(ctx);

    expect(capturedCycle).not.toBeNull();
    expect(capturedCtx).not.toBeNull();

    await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "full",
      strategiesRun: undefined,
    });

    const called = getCalledOpsInValidate();

    // Verifier must NOT be re-run
    expect(called.has("verifier")).toBe(false);

    // All other phases in the plan must be re-run
    expect(called.has("full-suite-gate")).toBe(true);
    expect(called.has("verify-scoped")).toBe(true);
    expect(called.has("lint-check")).toBe(true);
    expect(called.has("typecheck-check")).toBe(true);
    expect(called.has("semantic-review")).toBe(true);
    expect(called.has("adversarial-review")).toBe(true);
  });

  test("AC3.1: strategiesRun=[] (empty array) → same fallback as undefined (all non-verifier)", async () => {
    const ctx = makeCtx();
    const { capturedCycle, capturedCtx, getCalledOpsInValidate } = await captureAndSetupValidate(ctx);

    expect(capturedCycle).not.toBeNull();

    await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "full",
      strategiesRun: [],
    });

    const called = getCalledOpsInValidate();

    expect(called.has("verifier")).toBe(false);
    expect(called.has("full-suite-gate")).toBe(true);
    expect(called.has("verify-scoped")).toBe(true);
    expect(called.has("lint-check")).toBe(true);
    expect(called.has("typecheck-check")).toBe(true);
    expect(called.has("semantic-review")).toBe(true);
    expect(called.has("adversarial-review")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3.2: strategiesRun=["autofix-implementer"] → all 6 non-verifier phases
// ─────────────────────────────────────────────────────────────────────────────

describe("phasesToRevalidate — AC3.2: autofix-implementer → all non-verifier phases", () => {
  test("AC3.2: strategiesRun=['autofix-implementer'] → lint, typecheck, full-suite-gate, verify-scoped, semantic, adversarial called; verifier excluded", async () => {
    const ctx = makeCtx();
    const { capturedCycle, capturedCtx, getCalledOpsInValidate } = await captureAndSetupValidate(ctx);

    expect(capturedCycle).not.toBeNull();

    await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "full",
      strategiesRun: ["autofix-implementer"],
    });

    const called = getCalledOpsInValidate();

    expect(called.has("verifier")).toBe(false);
    expect(called.has("lint-check")).toBe(true);
    expect(called.has("typecheck-check")).toBe(true);
    expect(called.has("full-suite-gate")).toBe(true);
    expect(called.has("verify-scoped")).toBe(true);
    expect(called.has("semantic-review")).toBe(true);
    expect(called.has("adversarial-review")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3.3: strategiesRun=["mechanical-lintfix"] → only lint-check
// ─────────────────────────────────────────────────────────────────────────────

describe("phasesToRevalidate — AC3.3: mechanical-lintfix → only lint-check", () => {
  test("AC3.3: strategiesRun=['mechanical-lintfix'] → only lint-check called; all others excluded", async () => {
    const ctx = makeCtx();
    const { capturedCycle, capturedCtx, getCalledOpsInValidate } = await captureAndSetupValidate(ctx);

    expect(capturedCycle).not.toBeNull();

    await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "full",
      strategiesRun: ["mechanical-lintfix"],
    });

    const called = getCalledOpsInValidate();

    expect(called.has("lint-check")).toBe(true);

    // All others must NOT be called
    expect(called.has("verifier")).toBe(false);
    expect(called.has("typecheck-check")).toBe(false);
    expect(called.has("full-suite-gate")).toBe(false);
    expect(called.has("verify-scoped")).toBe(false);
    expect(called.has("semantic-review")).toBe(false);
    expect(called.has("adversarial-review")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3.4: strategiesRun=["full-suite-rectify"] → lint, typecheck, gate, scoped, semantic; NO adversarial
// ─────────────────────────────────────────────────────────────────────────────

describe("phasesToRevalidate — AC3.4: full-suite-rectify → no adversarial-review", () => {
  test("AC3.4: strategiesRun=['full-suite-rectify'] → lint, typecheck, gate, scoped, semantic called; adversarial and verifier excluded", async () => {
    const ctx = makeCtx();
    const { capturedCycle, capturedCtx, getCalledOpsInValidate } = await captureAndSetupValidate(ctx);

    expect(capturedCycle).not.toBeNull();

    await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "full",
      strategiesRun: ["full-suite-rectify"],
    });

    const called = getCalledOpsInValidate();

    expect(called.has("lint-check")).toBe(true);
    expect(called.has("typecheck-check")).toBe(true);
    expect(called.has("full-suite-gate")).toBe(true);
    expect(called.has("verify-scoped")).toBe(true);
    expect(called.has("semantic-review")).toBe(true);

    // These must NOT be called
    expect(called.has("adversarial-review")).toBe(false);
    expect(called.has("verifier")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3.5: strategiesRun=["unknown-plugin-strategy"] → fallback = all non-verifier
// ─────────────────────────────────────────────────────────────────────────────

describe("phasesToRevalidate — AC3.5: unknown strategy → fallback to all non-verifier phases", () => {
  test("AC3.5: strategiesRun=['unknown-plugin-strategy'] → all non-verifier phases called (conservative fallback)", async () => {
    const ctx = makeCtx();
    const { capturedCycle, capturedCtx, getCalledOpsInValidate } = await captureAndSetupValidate(ctx);

    expect(capturedCycle).not.toBeNull();

    await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "full",
      strategiesRun: ["unknown-plugin-strategy"],
    });

    const called = getCalledOpsInValidate();

    expect(called.has("verifier")).toBe(false);
    expect(called.has("lint-check")).toBe(true);
    expect(called.has("typecheck-check")).toBe(true);
    expect(called.has("full-suite-gate")).toBe(true);
    expect(called.has("verify-scoped")).toBe(true);
    expect(called.has("semantic-review")).toBe(true);
    expect(called.has("adversarial-review")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3.6: strategiesRun=["mechanical-lintfix", "autofix-implementer"] → union (broad set)
// ─────────────────────────────────────────────────────────────────────────────

describe("phasesToRevalidate — AC3.6: union of mechanical-lintfix + autofix-implementer → all non-verifier phases", () => {
  test("AC3.6: strategiesRun=['mechanical-lintfix','autofix-implementer'] → union: lint + typecheck + gate + scoped + semantic + adversarial; verifier excluded", async () => {
    const ctx = makeCtx();
    const { capturedCycle, capturedCtx, getCalledOpsInValidate } = await captureAndSetupValidate(ctx);

    expect(capturedCycle).not.toBeNull();

    await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "full",
      strategiesRun: ["mechanical-lintfix", "autofix-implementer"],
    });

    const called = getCalledOpsInValidate();

    // Union of mechanical-lintfix (lint-check) + autofix-implementer
    // (lint, typecheck, gate, scoped, semantic, adversarial) = all 6 non-verifier phases
    expect(called.has("verifier")).toBe(false);
    expect(called.has("lint-check")).toBe(true);
    expect(called.has("typecheck-check")).toBe(true);
    expect(called.has("full-suite-gate")).toBe(true);
    expect(called.has("verify-scoped")).toBe(true);
    expect(called.has("semantic-review")).toBe(true);
    expect(called.has("adversarial-review")).toBe(true);
  });
});
