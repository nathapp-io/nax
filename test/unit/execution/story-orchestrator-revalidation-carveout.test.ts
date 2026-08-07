/**
 * Verifier-SSOT carve-out — rectification revalidation.
 *
 * Split from `story-orchestrator-revalidation.test.ts` (800-line test limit); shares its
 * phase-op and finding fixtures via `_revalidation-fixtures.ts`.
 *
 * Covers #1401 (the nbf sweep must not inherit a stale verifier pass) and #1452 (a gate
 * failure absent from the verifier-time baseline must reach the fix cycle rather than be
 * discarded and then failed on by the staleness guard).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _storyOrchestratorDeps, runRectification } from "@/execution";
import type { FixCycle, FixCycleContext, FixCycleExitReason } from "@/findings/cycle-types";
import type { Finding } from "@/findings/types";
import type { CallContext } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { makeTestRuntime } from "@test/helpers";
import {
  ADVISORY,
  GATE_FAILURE,
  GATE_FAILURE_KEY,
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

  test("US-002 production composition: no-progress reason outranks count-increase", async () => {
    const ctx = makeCtx();
    const before = [ADVISORY];
    let capturedCycle: FixCycle<Finding> | null = null;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: FixCycle<Finding>) => {
      capturedCycle = cycle;
      return { iterations: [], finalFindings: [], exitReason: "resolved" as FixCycleExitReason, costUsd: 0 };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    await runRectification(
      ctx,
      makeRectifyState([{
        name: "strategy",
        appliesTo: () => true,
        fixOp: mockImplementerOp,
        buildInput: () => ({ story: "US-002" }),
        maxAttempts: 12,
      }]),
      {},
      greenBefore(),
      { initialFindings: before },
    );

    const iterations = Array.from({ length: 3 }, (_, index) => ({
      iterationNum: index + 1,
      findingsBefore: before,
      findingsAfter: [...before, { ...GATE_FAILURE, message: `new-${index}` }],
      fixesApplied: [{ strategyName: "strategy", op: "implementer", targetFiles: [], summary: "" }],
      outcome: "regressed" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
    }));
    const reason = (capturedCycle as unknown as FixCycle<Finding>).strategies[0]?.bailWhen?.(iterations);
    expect(reason).toContain("no finding resolved");
  });

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

  /**
   * #1452 — the carve-out is now split by the verifier-time baseline.
   *
   * The verifier judged the PRE-rectification tree, so its pass can only exempt failures
   * that already existed then. A failure absent from `gateBaselineKeys` was introduced BY
   * rectification, is exactly what `ExecutionPlan.run`'s staleness guard will fail the story
   * on, and therefore has to reach the fix cycle instead of being discarded.
   */
  async function captureMainPathCarveOut(
    baselineKeys?: ReadonlySet<string>,
  ): Promise<{ findings: readonly Finding[]; shortCircuited: boolean }> {
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

    await runRectification(
      ctx,
      makeRectifyState(),
      {},
      phaseOutputs,
      baselineKeys ? { gateBaselineKeys: baselineKeys } : undefined,
    );
    failGateOnly();

    const result = await (cycle as unknown as FixCycle<Finding>).validate(cycleCtx as unknown as FixCycleContext, {
      mode: "full",
      strategiesRun: ["autofix-implementer"],
    });
    return {
      findings: result.findings,
      shortCircuited: (result as { shortCircuited?: boolean }).shortCircuited === true,
    };
  }

  test("main path: a gate failure already in the verifier-time baseline stays exempt (#1452)", async () => {
    const baseline = new Set([GATE_FAILURE_KEY]);
    const { findings, shortCircuited } = await captureMainPathCarveOut(baseline);

    // The verifier already judged this failure unrelated — unchanged behaviour.
    expect(findings.some((f) => f.source === "test-runner")).toBe(false);
    expect(shortCircuited).toBe(false);
  });

  test("main path: a gate failure ABSENT from the baseline reaches the cycle instead of being swallowed (#1452)", async () => {
    const { findings, shortCircuited } = await captureMainPathCarveOut(new Set(["some/other.test.ts::unrelated"]));

    // Introduced by rectification -> must be fixable, not silently dropped.
    expect(findings.filter((f) => f.source === "test-runner")).toHaveLength(1);
    // The carve-out's other half is preserved: downstream phases still run.
    expect(shortCircuited).toBe(false);
  });

  test("main path: an omitted baseline is treated as 'no baseline known' — findings reach the cycle (#1452)", async () => {
    const { findings } = await captureMainPathCarveOut();

    expect(findings.filter((f) => f.source === "test-runner")).toHaveLength(1);
  });

  // #1383 parity. `describeGateRegression` excludes already-quarantined keys from the
  // blame set, so a known flake firing inside the revalidation window must KEEP the pass.
  // Turning the carve-out off exposed the sweep to that same gate output, so the sweep has
  // to apply the same exclusion — otherwise the flake seeds a fix attempt (and a test-code
  // edit via full-suite-rectify) and the pass is discarded, reversing #1383.
  test("nbf path: a failure the run already quarantined does NOT seed a fix attempt", async () => {
    const ctx = makeCtx();
    ctx.runtime.quarantineMemo.add(GATE_FAILURE_KEY);

    const phaseOutputs = greenBefore();
    const { cycle, cycleCtx } = await captureNbfCycle(ctx, makeRectifyState(), phaseOutputs, nbfOverrides());

    const result = await cycle.validate(cycleCtx, { mode: "full", strategiesRun: ["autofix-implementer"] });

    // No blame ⇒ no finding ⇒ the cycle resolves and `keptTreeRegressed` (which excludes
    // the same key) keeps the pass, exactly as it did before #1401.
    expect(result.findings.some((f) => f.source === "test-runner")).toBe(false);
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
