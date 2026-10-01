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
import { assertNaxError, makeStory, makeTestRuntime } from "@test/helpers";
import { pickSelector } from "@/config";
import { NaxError } from "@/errors";
import { _storyOrchestratorDeps, orderGateLast, StoryOrchestratorBuilder } from "@/execution";
import type { PhaseKind } from "@/execution/story-orchestrator/types";
import type { FixCycle, FixCycleContext, FixCycleExitReason } from "@/findings/cycle-types";
import type { Finding } from "@/findings/types";
import type { CallContext, DeterministicOperation, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import {
  LINT_FINDING,
  mockAdversarialReviewOp,
  mockFullSuiteGateOp,
  mockImplementerOp,
  mockLintCheckOp,
  mockSemanticReviewOp,
  mockTypecheckCheckOp,
  mockVerifierOp,
  mockVerifyScopedOp,
} from "./_revalidation-fixtures";

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
 * Set up the initial callOp so only lint-check fails. The main loop then reaches
 * rectification with a lint finding, so the FIRST runFixCycle call is the primary
 * cycle under test. (When every phase failed, the primary pass never reached the
 * fix cycle and these tests were measuring the resume loop's second pass, which
 * also re-judges the phase that triggered it — #2264.)
 */
function setupInitialCallOp() {
  _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
    if (op.name === "lint-check") return { success: false, findings: [LINT_FINDING] };
    return { success: true, passed: true, findings: [] };
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
    // Keep the PRIMARY cycle: lint stays red, so the resume loop's second pass
    // runs too, with a different revalidation set from the one under test.
    if (capturedCycle === null) {
      capturedCycle = cycle;
      capturedCtx = cycleCtx;
    }
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
// AC3.1: strategiesRun=undefined → conservative fallback (all phases including verifier)
// ─────────────────────────────────────────────────────────────────────────────

describe("phasesToRevalidate — AC3.1: undefined strategiesRun → conservative fallback (all phases)", () => {
  test("AC3.1: strategiesRun=undefined → verifier included in conservative fallback", async () => {
    const ctx = makeCtx();
    const { capturedCycle, capturedCtx, getCalledOpsInValidate } = await captureAndSetupValidate(ctx);

    expect(capturedCycle).not.toBeNull();
    expect(capturedCtx).not.toBeNull();

    await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "full",
      strategiesRun: undefined,
    });

    const called = getCalledOpsInValidate();

    // Conservative fallback: verifier IS re-run (unknown strategies → revalidate everything)
    expect(called.has("verifier")).toBe(true);

    // All other phases in the plan must also be re-run
    expect(called.has("full-suite-gate")).toBe(true);
    expect(called.has("verify-scoped")).toBe(true);
    expect(called.has("lint-check")).toBe(true);
    expect(called.has("typecheck-check")).toBe(true);
    expect(called.has("semantic-review")).toBe(true);
    expect(called.has("adversarial-review")).toBe(true);
  });

  test("AC3.1: strategiesRun=[] (empty array) → same conservative fallback as undefined (all phases)", async () => {
    const ctx = makeCtx();
    const { capturedCycle, capturedCtx, getCalledOpsInValidate } = await captureAndSetupValidate(ctx);

    expect(capturedCycle).not.toBeNull();

    await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "full",
      strategiesRun: [],
    });

    const called = getCalledOpsInValidate();

    // Conservative fallback: verifier IS re-run (empty strategies → revalidate everything)
    expect(called.has("verifier")).toBe(true);
    expect(called.has("full-suite-gate")).toBe(true);
    expect(called.has("verify-scoped")).toBe(true);
    expect(called.has("lint-check")).toBe(true);
    expect(called.has("typecheck-check")).toBe(true);
    expect(called.has("semantic-review")).toBe(true);
    expect(called.has("adversarial-review")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3.2: strategiesRun=["autofix-implementer"] → review-relevant phases (verifier excluded)
// ─────────────────────────────────────────────────────────────────────────────

describe("phasesToRevalidate — AC3.2: autofix-implementer → review-relevant phases (verifier excluded)", () => {
  test("AC3.2: strategiesRun=['autofix-implementer'] → lint, typecheck, full-suite-gate, semantic, adversarial called; verifier and verify-scoped excluded", async () => {
    const ctx = makeCtx();
    const { capturedCycle, capturedCtx, getCalledOpsInValidate } = await captureAndSetupValidate(ctx);

    expect(capturedCycle).not.toBeNull();

    await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "full",
      strategiesRun: ["autofix-implementer"],
    });

    const called = getCalledOpsInValidate();

    // autofix-implementer addresses review findings — it cannot legitimately
    // change the TDD isolation verdict. Verifier stays a once-per-story phase.
    expect(called.has("verifier")).toBe(false);
    expect(called.has("verify-scoped")).toBe(false);

    // Lint, typecheck, full-suite-gate, semantic-review, adversarial-review
    // all remain in the revalidation set.
    expect(called.has("lint-check")).toBe(true);
    expect(called.has("typecheck-check")).toBe(true);
    expect(called.has("full-suite-gate")).toBe(true);
    expect(called.has("semantic-review")).toBe(true);
    expect(called.has("adversarial-review")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3.2b: strategiesRun=["autofix-test-writer"] → test-impacting phases without verifier
// ─────────────────────────────────────────────────────────────────────────────

describe("phasesToRevalidate — AC3.2b: autofix-test-writer → test-impacting phases without verifier", () => {
  test("AC3.2b: strategiesRun=['autofix-test-writer'] → lint, typecheck, full-suite-gate, adversarial called; verifier and verify-scoped excluded", async () => {
    const ctx = makeCtx();
    const { capturedCycle, capturedCtx, getCalledOpsInValidate } = await captureAndSetupValidate(ctx);

    expect(capturedCycle).not.toBeNull();

    await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "full",
      strategiesRun: ["autofix-test-writer"],
    });

    const called = getCalledOpsInValidate();

    // autofix-test-writer rewrites tests to satisfy adversarial-review — it
    // does not re-do the TDD test-writer/implementer pair, so verifier stays
    // out of the loop. The post-rectification-resume picks verifier up if it
    // was never run.
    expect(called.has("verifier")).toBe(false);
    expect(called.has("verify-scoped")).toBe(false);

    expect(called.has("lint-check")).toBe(true);
    expect(called.has("typecheck-check")).toBe(true);
    expect(called.has("full-suite-gate")).toBe(true);
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
// AC3.4: strategiesRun=["full-suite-rectify"] → lint, typecheck, gate, verifier, scoped,
// semantic AND adversarial (it edits tests → both reviews re-judge). (Audit #2.)
// ─────────────────────────────────────────────────────────────────────────────

describe("phasesToRevalidate — AC3.4: full-suite-rectify → verifier + both reviews included", () => {
  test("AC3.4: strategiesRun=['full-suite-rectify'] → lint, typecheck, gate, verifier, scoped, semantic, adversarial all called", async () => {
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
    // full-suite-rectify is a code-editing strategy — verifier re-judges the TDD verdict
    expect(called.has("verifier")).toBe(true);

    // adversarial-review IS now in full-suite-rectify's revalidation set: this strategy
    // edits TEST code, which is exactly what adversarial-review judges, so its prior
    // verdict is stale and must re-run rather than be read as a pre-rectification pass.
    expect(called.has("adversarial-review")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3.5: strategiesRun=["unknown-plugin-strategy"] → fallback = all non-verifier
// ─────────────────────────────────────────────────────────────────────────────

describe("phasesToRevalidate — AC3.5: unknown strategy → conservative fallback (all phases including verifier)", () => {
  test("AC3.5: strategiesRun=['unknown-plugin-strategy'] → all phases including verifier called (conservative fallback)", async () => {
    const ctx = makeCtx();
    const { capturedCycle, capturedCtx, getCalledOpsInValidate } = await captureAndSetupValidate(ctx);

    expect(capturedCycle).not.toBeNull();

    await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "full",
      strategiesRun: ["unknown-plugin-strategy"],
    });

    const called = getCalledOpsInValidate();

    // Unknown strategy → conservative fallback = allPhases (including verifier)
    expect(called.has("verifier")).toBe(true);
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

describe("phasesToRevalidate — AC3.6: union of mechanical-lintfix + autofix-implementer → review phases without verifier", () => {
  test("AC3.6: strategiesRun=['mechanical-lintfix','autofix-implementer'] → union excludes verifier (neither strategy includes it)", async () => {
    const ctx = makeCtx();
    const { capturedCycle, capturedCtx, getCalledOpsInValidate } = await captureAndSetupValidate(ctx);

    expect(capturedCycle).not.toBeNull();

    await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "full",
      strategiesRun: ["mechanical-lintfix", "autofix-implementer"],
    });

    const called = getCalledOpsInValidate();

    // Union of mechanical-lintfix (lint-check) + autofix-implementer
    // (lint, typecheck, gate, semantic, adversarial) — verifier excluded from both.
    expect(called.has("verifier")).toBe(false);
    expect(called.has("verify-scoped")).toBe(false);
    expect(called.has("lint-check")).toBe(true);
    expect(called.has("typecheck-check")).toBe(true);
    expect(called.has("full-suite-gate")).toBe(true);
    expect(called.has("semantic-review")).toBe(true);
    expect(called.has("adversarial-review")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal lite-validate — the full-suite gate runs LAST as the final arbiter,
// instead of being skipped. Previously lite mode skipped the gate entirely, so
// the cycle declared "resolved" off the cheaper phases alone (semantic last)
// without ever re-running the gate that had just received a fix — a dishonest
// exit. The gate now runs after every cheaper phase: a failing cheaper phase
// short-circuits before it (cost preserved), and when everything cheaper is
// green the gate decides the verdict. Session-agnostic — also covers a
// single-session per-story full-suite-gate.
// ─────────────────────────────────────────────────────────────────────────────

/** Capture the cycle, then install an ORDER-recording callOp with per-op failures. */
async function captureWithOrderedTracker(
  ctx: CallContext,
  failingOps: ReadonlySet<string> = new Set(),
): Promise<{
  capturedCycle: FixCycle<Finding> | null;
  capturedCtx: FixCycleContext | null;
  order: string[];
}> {
  const { capturedCycle, capturedCtx } = await captureAndSetupValidate(ctx);
  const order: string[] = [];
  _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
    order.push(op.name);
    if (failingOps.has(op.name)) return { success: false, passed: false, findings: [LINT_FINDING] };
    return { success: true, passed: true, findings: [] };
  }) as typeof _storyOrchestratorDeps.callOp;
  return { capturedCycle, capturedCtx, order };
}

describe("terminal lite-validate — gate runs LAST as final arbiter (Q1/Q3)", () => {
  test("lite mode: full-suite-gate IS re-run, and runs after every cheaper phase", async () => {
    const ctx = makeCtx();
    const { capturedCycle, capturedCtx, order } = await captureWithOrderedTracker(ctx);
    expect(capturedCycle).not.toBeNull();

    await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "lite",
      strategiesRun: ["full-suite-rectify"],
    });

    // Gate must actually run in lite mode (previously skipped -> dishonest "resolved").
    expect(order).toContain("full-suite-gate");
    // ...and it must be the LAST phase: every other revalidation phase precedes it.
    expect(order[order.length - 1]).toBe("full-suite-gate");
  });

  test("lite mode: a failing cheaper phase short-circuits BEFORE the gate (cost preserved)", async () => {
    const ctx = makeCtx();
    // semantic-review is a cheaper phase than the full-suite gate.
    const { capturedCycle, capturedCtx, order } = await captureWithOrderedTracker(ctx, new Set(["semantic-review"]));
    expect(capturedCycle).not.toBeNull();

    const result = await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "lite",
      strategiesRun: ["full-suite-rectify"],
    });

    expect(order).toContain("semantic-review");
    // Short-circuit on the cheaper failure means the expensive gate never runs.
    expect(order).not.toContain("full-suite-gate");
    // validate signals the short-circuit so the cycle cannot report a false "resolved".
    expect((result as { shortCircuited?: boolean }).shortCircuited).toBe(true);
  });

  test("full mode is unchanged: gate keeps its canonical position (not forced last)", async () => {
    const ctx = makeCtx();
    const { capturedCycle, capturedCtx, order } = await captureWithOrderedTracker(ctx);
    expect(capturedCycle).not.toBeNull();

    await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "full",
      strategiesRun: ["full-suite-rectify"],
    });

    // Canonical order places full-suite-gate before verifier; full mode preserves it.
    expect(order).toContain("full-suite-gate");
    expect(order.indexOf("full-suite-gate")).toBeLessThan(order.indexOf("verifier"));
  });

  test("lite mode: verifier-SSOT carve-out — a red gate is dispatched (last) and does not short-circuit, but a regression still reaches the cycle", async () => {
    const ctx = makeCtx();
    // Only the gate fails; the verifier (and everything cheaper) passes.
    const { capturedCycle, capturedCtx, order } = await captureWithOrderedTracker(ctx, new Set(["full-suite-gate"]));
    expect(capturedCycle).not.toBeNull();

    const result = await (capturedCycle as FixCycle<Finding>).validate(capturedCtx as FixCycleContext, {
      mode: "lite",
      strategiesRun: ["full-suite-rectify"],
    });

    // The gate still RUNS (last) — it validates the just-applied fix (Q1) ...
    expect(order[order.length - 1]).toBe("full-suite-gate");
    // ... and because the verifier passed, shouldSkipPhaseForRectification still keeps the
    // gate from short-circuiting the sweep (unrelated-regression policy).
    expect((result as { shortCircuited?: boolean }).shortCircuited).toBe(false);
    // No verifier-time baseline was supplied, so the failure counts as introduced by
    // rectification and is handed to the fix cycle rather than discarded (#1452).
    const findings = Array.isArray(result) ? result : result.findings;
    expect(findings).toHaveLength(1);
  });
});

describe("orderGateLast — pure ordering helper", () => {
  const mk = (kind: PhaseKind) => ({ kind });

  test("moves full-suite-gate to the end, preserving order of the other phases", () => {
    const input = [mk("full-suite-gate"), mk("verifier"), mk("lint-check"), mk("semantic-review")];
    expect(orderGateLast(input).map((p) => p.kind)).toEqual([
      "verifier",
      "lint-check",
      "semantic-review",
      "full-suite-gate",
    ]);
  });

  test("is a no-op when there is no full-suite-gate phase", () => {
    const input = [mk("lint-check"), mk("typecheck-check"), mk("semantic-review")];
    expect(orderGateLast(input).map((p) => p.kind)).toEqual(["lint-check", "typecheck-check", "semantic-review"]);
  });
});

// ===========================================================================
// StoryOrchestratorBuilder — Check Ops (absorbed from
// story-orchestrator-check-ops.test.ts)
// ===========================================================================

const testSel = pickSelector("test-orchestrator-sel", "execution");

/** The op fixtures' config slice, derived from the selector so the two cannot drift. */
type TestOpConfig = ReturnType<(typeof testSel)["select"]>;

const checkOpsMockImplementerOp: RunOperation<{ code: string }, { success: boolean }, TestOpConfig> = {
  kind: "run",
  name: "mock-implementer",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "warm" },
  build: () => ({
    role: { id: "r", content: "impl", overridable: false },
    task: { id: "t", content: "", overridable: false },
  }),
  parse: () => ({ success: true }),
};

function makeCheckOp(
  name: string,
): DeterministicOperation<
  { workdir: string; storyId: string },
  { success: boolean; findings: never[]; durationMs: number },
  TestOpConfig
> {
  return {
    kind: "deterministic",
    name,
    stage: "review",
    config: testSel,
    async execute() {
      return { success: true, findings: [], durationMs: 0 };
    },
  };
}

let checkOpsRuntime: NaxRuntime;

function checkOpsMakeCtx(): CallContext {
  checkOpsRuntime = makeTestRuntime();
  return {
    runtime: checkOpsRuntime,
    packageView: checkOpsRuntime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId: "US-003",
  };
}

afterEach(async () => {
  await checkOpsRuntime?.close();
});

describe("StoryOrchestratorBuilder — AC7: CANONICAL_ORDER includes new check phases", () => {
  test("AC7: phaseNames includes lint-check when addLintCheck is called", () => {
    const ctx = checkOpsMakeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: checkOpsMockImplementerOp, input: { code: "" } })
      .addLintCheck({ workdir: "/tmp", storyId: "US-003" })
      .build(ctx);
    expect(plan.phaseNames()).toContain("lint-check");
  });

  test("AC7: phaseNames includes typecheck-check when addTypecheckCheck is called", () => {
    const ctx = checkOpsMakeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: checkOpsMockImplementerOp, input: { code: "" } })
      .addTypecheckCheck({ workdir: "/tmp", storyId: "US-003" })
      .build(ctx);
    expect(plan.phaseNames()).toContain("typecheck-check");
  });

  test("AC7: phaseNames includes verify-scoped when addVerifyScoped is called", () => {
    const ctx = checkOpsMakeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: checkOpsMockImplementerOp, input: { code: "" } })
      .addVerifyScoped({ workdir: "/tmp", storyId: "US-003" })
      .build(ctx);
    expect(plan.phaseNames()).toContain("verify-scoped");
  });

  test("AC7: verify-scoped appears before lint-check in CANONICAL_ORDER", () => {
    const ctx = checkOpsMakeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: checkOpsMockImplementerOp, input: { code: "" } })
      .addVerifyScoped({ workdir: "/tmp", storyId: "US-003" })
      .addLintCheck({ workdir: "/tmp", storyId: "US-003" })
      .build(ctx);
    const names = plan.phaseNames();
    expect(names.indexOf("verify-scoped")).toBeLessThan(names.indexOf("lint-check"));
  });

  test("AC7: lint-check appears before typecheck-check in CANONICAL_ORDER", () => {
    const ctx = checkOpsMakeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: checkOpsMockImplementerOp, input: { code: "" } })
      .addLintCheck({ workdir: "/tmp", storyId: "US-003" })
      .addTypecheckCheck({ workdir: "/tmp", storyId: "US-003" })
      .build(ctx);
    const names = plan.phaseNames();
    expect(names.indexOf("lint-check")).toBeLessThan(names.indexOf("typecheck-check"));
  });

  test("lint-check not in phaseNames when addLintCheck not called", () => {
    const ctx = checkOpsMakeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: checkOpsMockImplementerOp, input: { code: "" } })
      .build(ctx);
    expect(plan.phaseNames()).not.toContain("lint-check");
  });

  test("typecheck-check not in phaseNames when addTypecheckCheck not called", () => {
    const ctx = checkOpsMakeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: checkOpsMockImplementerOp, input: { code: "" } })
      .build(ctx);
    expect(plan.phaseNames()).not.toContain("typecheck-check");
  });

  test("verify-scoped not in phaseNames when addVerifyScoped not called", () => {
    const ctx = checkOpsMakeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: checkOpsMockImplementerOp, input: { code: "" } })
      .build(ctx);
    expect(plan.phaseNames()).not.toContain("verify-scoped");
  });
});

describe("StoryOrchestratorBuilder — AC8: builder methods accept OrchestratorSlot overload", () => {
  test("AC8: addLintCheck accepts OrchestratorSlot with custom op", () => {
    const ctx = checkOpsMakeCtx();
    const customOp = makeCheckOp("custom-lint");
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: checkOpsMockImplementerOp, input: { code: "" } })
      .addLintCheck({ op: customOp, input: { workdir: "/tmp", storyId: "US-003" } })
      .build(ctx);
    expect(plan.phaseNames()).toContain("custom-lint");
  });

  test("AC8: addTypecheckCheck accepts OrchestratorSlot with custom op", () => {
    const ctx = checkOpsMakeCtx();
    const customOp = makeCheckOp("custom-typecheck");
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: checkOpsMockImplementerOp, input: { code: "" } })
      .addTypecheckCheck({ op: customOp, input: { workdir: "/tmp", storyId: "US-003" } })
      .build(ctx);
    expect(plan.phaseNames()).toContain("custom-typecheck");
  });

  test("AC8: addVerifyScoped accepts OrchestratorSlot with custom op", () => {
    const ctx = checkOpsMakeCtx();
    const customOp = makeCheckOp("custom-verify-scoped");
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: checkOpsMockImplementerOp, input: { code: "" } })
      .addVerifyScoped({ op: customOp, input: { workdir: "/tmp", storyId: "US-003" } })
      .build(ctx);
    expect(plan.phaseNames()).toContain("custom-verify-scoped");
  });
});

// ===========================================================================
// Duplicate phase guard (absorbed from story-orchestrator-duplicate-phase.test.ts)
// ===========================================================================

const INPUT = { story: makeStory({ id: "S1", title: "t" }), contextMarkdown: "c" };

describe("StoryOrchestratorBuilder — duplicate phase guard", () => {
  test("addImplementer called twice throws ORCHESTRATOR_PHASE_DUPLICATE", () => {
    const b = new StoryOrchestratorBuilder();
    b.addImplementer(INPUT);
    expect(() => b.addImplementer(INPUT)).toThrow(NaxError);
  });

  test("thrown NaxError has code ORCHESTRATOR_PHASE_DUPLICATE", () => {
    const b = new StoryOrchestratorBuilder();
    b.addImplementer(INPUT);
    try {
      b.addImplementer(INPUT);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      assertNaxError(err);
      expect(err.code).toBe("ORCHESTRATOR_PHASE_DUPLICATE");
    }
  });

  test("addTestWriter called twice throws ORCHESTRATOR_PHASE_DUPLICATE", () => {
    const b = new StoryOrchestratorBuilder();
    const writerInput = { story: makeStory({ id: "S1", title: "t" }), contextMarkdown: "c" };
    b.addTestWriter(writerInput);
    expect(() => b.addTestWriter(writerInput)).toThrow(NaxError);
  });
});
