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
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import { StoryOrchestratorBuilder, _storyOrchestratorDeps, orderGateLast, runRectification } from "@/execution";
import type { FixCycle, FixCycleContext, FixCycleExitReason } from "@/findings/cycle-types";
import type { Finding } from "@/findings/types";
import type { CallContext, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { makeTestRuntime } from "@test/helpers";

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
  category: "",
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

  test("lite mode: verifier-SSOT carve-out — a red gate is dispatched (last) but its finding is discarded when the verifier passed", async () => {
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
    // ... but because the verifier passed, shouldSkipPhaseForRectification discards
    // the gate's finding (unrelated-regression policy). So the cycle is not blocked:
    // no findings surface and it does NOT short-circuit on the gate failure.
    expect(result.findings).toHaveLength(0);
    expect((result as { shortCircuited?: boolean }).shortCircuited).toBe(false);
  });
});

describe("orderGateLast — pure ordering helper", () => {
  const mk = (kind: string) => ({ kind, slot: { op: { name: kind } } }) as never;

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

// ─────────────────────────────────────────────────────────────────────────────
// #1401 — the nbf revalidation must not inherit a STALE verifier pass.
//
// `phasesToRevalidate` places full-suite-gate before the verifier in the sweep,
// so when the carve-out is evaluated `phaseOutputs[verifier]` still holds the
// PRE-rectification pass. On the nbf path that stale green made the carve-out
// discard the very regression the pass had just introduced, which (a) let the
// cycle exit "resolved" so `regressionAttempts` was never spent, and (b) skipped
// the halt-on-failure short-circuit so the verifier session still ran against a
// red gate. `runNonBlockingFix` then read the same gate output RAW and restored.
//
// The carve-out exists so a story is not rolled back over regressions it did not
// cause. nbf never fails a story — it only chooses keep-vs-discard of its own
// edits — so the policy has nothing to protect there and only forfeits the repair.
// ─────────────────────────────────────────────────────────────────────────────

describe("verifier-SSOT carve-out — nbf revalidation must not inherit a stale verifier pass (#1401)", () => {
  const ADVISORY = {
    source: "adversarial-review",
    severity: "warning",
    category: "style",
    message: "advisory — seeds the nbf pass",
  } as unknown as Finding;

  const GATE_FAILURE = {
    source: "test-runner",
    severity: "error",
    category: "",
    message: "the regression the nbf pass introduced",
    file: "test/integration/tdd/story-orchestrator-verdict.test.ts",
    rule: "verifier session fails",
  } as unknown as Finding;

  /** Gate + verifier + the cheap checks: the minimum to reproduce the stale read. */
  function makeRectifyState(strategies: unknown[] = []): Parameters<typeof runRectification>[1] {
    return {
      fullSuiteGate: { kind: "full-suite-gate", slot: { op: mockFullSuiteGateOp, input: { story: "US-1401" } } },
      verifier: { kind: "verifier", slot: { op: mockVerifierOp, input: { story: "US-1401" } } },
      lintCheck: { kind: "lint-check", slot: { op: mockLintCheckOp, input: { story: "US-1401" } } },
      typecheckCheck: { kind: "typecheck-check", slot: { op: mockTypecheckCheckOp, input: { story: "US-1401" } } },
      rectification: { maxAttempts: 3, strategies, abortOnIncreasingFailures: false },
    } as unknown as Parameters<typeof runRectification>[1];
  }

  /** Mirrors ExecutionPlan's nbf wiring: seeded advisories + verifierGuard extra phase. */
  function nbfOverrides(extra: Record<string, unknown> = {}) {
    return {
      initialFindings: [ADVISORY],
      extraRevalidationKinds: ["verifier"],
      // 1 + review.nonBlockingFix.regressionAttempts (default 1).
      maxAttempts: 2,
      ...extra,
    } as unknown as Parameters<typeof runRectification>[4];
  }

  /** Pre-rectification state: the story was green, verifier included. */
  const greenBefore = (): Record<string, unknown> => ({
    verifier: { success: true, passed: true, findings: [] },
    "full-suite-gate": { success: true, passed: true, findings: [] },
  });

  /** Re-runs during validate: only the gate is red. */
  function failGateOnly(): void {
    _storyOrchestratorDeps.callOp = mock(async (_c: unknown, op: { name: string }) => {
      if (op.name === "full-suite-gate") return { success: false, passed: false, findings: [GATE_FAILURE] };
      return { success: true, passed: true, findings: [] };
    }) as typeof _storyOrchestratorDeps.callOp;
  }

  /** Capture the FixCycle runRectification builds, without running it. */
  async function captureNbfCycle(
    ctx: CallContext,
    state: Parameters<typeof runRectification>[1],
    phaseOutputs: Record<string, unknown>,
    overrides: Parameters<typeof runRectification>[4],
  ): Promise<{ cycle: FixCycle<Finding>; cycleCtx: FixCycleContext }> {
    let cycle: FixCycle<Finding> | null = null;
    let cycleCtx: FixCycleContext | null = null;
    _storyOrchestratorDeps.runFixCycle = mock(async (c: FixCycle<Finding>, cc: FixCycleContext) => {
      cycle = c;
      cycleCtx = cc;
      return { iterations: [], finalFindings: [], exitReason: "resolved" as FixCycleExitReason, costUsd: 0 };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    await runRectification(ctx, state, {}, phaseOutputs, overrides);
    failGateOnly();
    return { cycle: cycle as unknown as FixCycle<Finding>, cycleCtx: cycleCtx as unknown as FixCycleContext };
  }

  test("nbf path: a gate regression surfaces as a finding instead of being discarded by the stale verifier pass", async () => {
    const ctx = makeCtx();
    const phaseOutputs = greenBefore();
    const { cycle, cycleCtx } = await captureNbfCycle(ctx, makeRectifyState(), phaseOutputs, nbfOverrides());

    const result = await cycle.validate(cycleCtx, { mode: "full", strategiesRun: ["autofix-implementer"] });

    // The gate's failure must reach the cycle — this is what makes the next
    // iteration happen at all, i.e. what makes `regressionAttempts` spendable.
    expect(result.findings.some((f) => f.source === "test-runner")).toBe(true);
    // And the halt-on-failure contract must hold: nothing downstream of a red
    // gate may run, so the expensive verifier session is never dispatched.
    expect((result as { shortCircuited?: boolean }).shortCircuited).toBe(true);
  });

  test("nbf path: the verifier is NOT dispatched after the gate goes red (no session spent on a doomed pass)", async () => {
    const ctx = makeCtx();
    const phaseOutputs = greenBefore();
    const { cycle, cycleCtx } = await captureNbfCycle(ctx, makeRectifyState(), phaseOutputs, nbfOverrides());

    const dispatched: string[] = [];
    const failing = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = (async (c: unknown, op: { name: string }, i: unknown) => {
      dispatched.push(op.name);
      return (failing as (c: unknown, op: unknown, i: unknown) => Promise<unknown>)(c, op, i);
    }) as typeof _storyOrchestratorDeps.callOp;

    await cycle.validate(cycleCtx, { mode: "full", strategiesRun: ["autofix-implementer"] });

    expect(dispatched).toContain("full-suite-gate");
    expect(dispatched).not.toContain("verifier");
  });

  test("control — the main (non-nbf) path keeps the carve-out: a red gate is still discarded when the verifier passed", async () => {
    const ctx = makeCtx();
    // Seed via gatherRectificationFindings: lint red pre-rectification, verifier green.
    const phaseOutputs: Record<string, unknown> = {
      verifier: { success: true, passed: true, findings: [] },
      "lint-check": { success: false, passed: false, findings: [LINT_FINDING] },
    };
    let cycle: FixCycle<Finding> | null = null;
    let cycleCtx: FixCycleContext | null = null;
    _storyOrchestratorDeps.runFixCycle = mock(async (c: FixCycle<Finding>, cc: FixCycleContext) => {
      cycle = c;
      cycleCtx = cc;
      return { iterations: [], finalFindings: [], exitReason: "resolved" as FixCycleExitReason, costUsd: 0 };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    await runRectification(ctx, makeRectifyState(), {}, phaseOutputs);
    failGateOnly();

    const result = await (cycle as unknown as FixCycle<Finding>).validate(cycleCtx as unknown as FixCycleContext, {
      mode: "full",
      strategiesRun: ["autofix-implementer"],
    });

    // Unchanged main-path semantics: the verifier's pass still exempts the gate.
    expect(result.findings.some((f) => f.source === "test-runner")).toBe(false);
    expect((result as { shortCircuited?: boolean }).shortCircuited).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1401 — the consequence the two tests above buy: `review.nonBlockingFix
// .regressionAttempts` becomes spendable. `runNonBlockingFix` passes
// `1 + regressionAttempts` as the cycle's maxAttemptsTotal; while the gate
// regression was discarded the cycle always exited "resolved" on iteration 1, so
// the budget could never be reached on any verifier-bearing (three-session) plan.
// This drives the REAL runFixCycle to prove the second attempt now happens.
// ─────────────────────────────────────────────────────────────────────────────

describe("nbf regressionAttempts is actually spendable once the gate regression surfaces (#1401)", () => {
  const ADVISORY = {
    source: "adversarial-review",
    severity: "warning",
    category: "style",
    message: "advisory — seeds the nbf pass",
  } as unknown as Finding;

  const GATE_FAILURE = {
    source: "test-runner",
    severity: "error",
    category: "",
    message: "the regression the nbf pass introduced",
    file: "test/integration/tdd/story-orchestrator-verdict.test.ts",
    rule: "verifier session fails",
  } as unknown as Finding;

  test("a gate that stays red drives a SECOND fix attempt instead of exiting 'resolved' after one", async () => {
    const ctx = makeCtx();

    const attempts: string[] = [];
    _storyOrchestratorDeps.callOp = mock(async (_c: unknown, op: { name: string }) => {
      if (op.name === "implementer") {
        attempts.push("fix");
        return { success: true };
      }
      // The nbf edit broke the suite and the repair does not clear it, so the gate
      // stays red across both iterations — the worst case for the budget.
      if (op.name === "full-suite-gate") return { success: false, passed: false, findings: [GATE_FAILURE] };
      return { success: true, passed: true, findings: [] };
    }) as typeof _storyOrchestratorDeps.callOp;

    const strategy = {
      name: "autofix-implementer",
      appliesTo: (f: Finding) => f.source === "adversarial-review" || f.source === "test-runner",
      fixOp: mockImplementerOp,
      buildInput: () => ({ story: "US-1401" }),
      maxAttempts: 2,
    };

    const state = {
      fullSuiteGate: { kind: "full-suite-gate", slot: { op: mockFullSuiteGateOp, input: { story: "US-1401" } } },
      verifier: { kind: "verifier", slot: { op: mockVerifierOp, input: { story: "US-1401" } } },
      lintCheck: { kind: "lint-check", slot: { op: mockLintCheckOp, input: { story: "US-1401" } } },
      rectification: { maxAttempts: 3, strategies: [strategy], abortOnIncreasingFailures: false },
    } as unknown as Parameters<typeof runRectification>[1];

    await runRectification(
      ctx,
      state,
      {},
      // Pre-rectification: green, verifier included — the stale pass that used to
      // exempt the gate for the whole sweep.
      { verifier: { success: true, passed: true, findings: [] } },
      {
        initialFindings: [ADVISORY],
        extraRevalidationKinds: ["verifier"],
        // 1 + review.nonBlockingFix.regressionAttempts (default 1).
        maxAttempts: 2,
      } as unknown as Parameters<typeof runRectification>[4],
    );

    // Iteration 1 fixes the advisory; the gate then goes red and that finding now
    // reaches the cycle, so iteration 2 dispatches the repair attempt.
    expect(attempts).toHaveLength(2);
  });
});
