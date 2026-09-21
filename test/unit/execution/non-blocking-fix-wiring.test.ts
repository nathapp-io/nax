// test/unit/execution/non-blocking-fix-wiring.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  assertDefined,
  makeFinding,
  makeFixCycleResult,
  makeIteration,
  makeMockCallContext,
  makeMockPlanInputs,
  makeNaxConfig,
  makeSpawn,
  makeStory,
  makeTestRuntime,
} from "@test/helpers";
import type { NonBlockingFixConfig } from "@/config/selectors";
import { _storyOrchestratorDeps, buildPlanForStrategy } from "@/execution";
import type { NonBlockingFixArgs, NonBlockingFixDeps } from "@/execution/non-blocking-fix";
import { actionableAdvisoryFindings, runNonBlockingFix, shouldRunNonBlockingFix } from "@/execution/non-blocking-fix";
import type { Finding } from "@/findings";
import type { NaxRuntime } from "@/runtime";
import { _rollbackDeps } from "@/tdd";

describe("non-blocking-fix wiring gate", () => {
  test("gate is off without config", () => {
    expect(shouldRunNonBlockingFix(undefined, 5)).toBe(false);
  });
  test("gate is on when enabled with advisory findings", () => {
    expect(
      shouldRunNonBlockingFix(
        {
          enabled: true,
          scope: "both",
          regressionAttempts: 1,
          verifierGuard: true,
          sourceDiffCap: { maxFiles: 10, maxLines: 500 },
          sources: ["adversarial"],
        },
        5,
      ),
    ).toBe(true);
  });
  test("gate is off when enabled but zero advisory findings", () => {
    expect(
      shouldRunNonBlockingFix(
        {
          enabled: true,
          scope: "source",
          regressionAttempts: 1,
          verifierGuard: false,
          sourceDiffCap: { maxFiles: 10, maxLines: 500 },
          sources: ["adversarial"],
        },
        0,
      ),
    ).toBe(false);
  });
  test("gate is off when config present but disabled", () => {
    expect(
      shouldRunNonBlockingFix(
        {
          enabled: false,
          scope: "both",
          regressionAttempts: 1,
          verifierGuard: true,
          sourceDiffCap: { maxFiles: 10, maxLines: 500 },
          sources: ["adversarial"],
        },
        3,
      ),
    ).toBe(false);
  });
});

describe("non-blocking-fix runtime wiring", () => {
  let origCallOp: typeof _storyOrchestratorDeps.callOp;
  let origRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
  let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
  let origRollbackSpawn: typeof _rollbackDeps.spawn;
  let origRollbackAutoCommit: typeof _rollbackDeps.autoCommitIfDirty;
  let origRunNonBlockingFix: typeof _storyOrchestratorDeps.runNonBlockingFix;
  let runtime: NaxRuntime | undefined;

  beforeEach(() => {
    origCallOp = _storyOrchestratorDeps.callOp;
    origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
    origRollbackSpawn = _rollbackDeps.spawn;
    origRollbackAutoCommit = _rollbackDeps.autoCommitIfDirty;
    origRunNonBlockingFix = _storyOrchestratorDeps.runNonBlockingFix;

    _storyOrchestratorDeps.captureGitRef = mock(async () => "HEAD");
    _storyOrchestratorDeps.callOp = mock(async (_ctx, op) => {
      if (op.name === "adversarial-review") {
        return {
          success: true,
          passed: true,
          advisoryFindings: [
            { source: "adversarial-review", severity: "warning", category: "input", message: "advisory finding" },
          ],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.runFixCycle = async <F extends Finding>() =>
      makeFixCycleResult<F>({ exitReason: "no-strategy" });

    _rollbackDeps.autoCommitIfDirty = mock(async () => {});
    _rollbackDeps.spawn = makeSpawn(() => "abc1234\n").spawn;
  });

  afterEach(async () => {
    _storyOrchestratorDeps.callOp = origCallOp;
    _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
    _rollbackDeps.spawn = origRollbackSpawn;
    _rollbackDeps.autoCommitIfDirty = origRollbackAutoCommit;
    _storyOrchestratorDeps.runNonBlockingFix = origRunNonBlockingFix;
    await runtime?.close();
    runtime = undefined;
  });

  test("story orchestrator routes non-blocking fix through injected runtime wiring with measureSourceDiff", async () => {
    const runNonBlockingFix = mock(async (_args: NonBlockingFixArgs, _overrides?: Partial<NonBlockingFixDeps>) => ({
      ran: true,
      kept: true,
      restored: false,
    }));
    _storyOrchestratorDeps.runNonBlockingFix = runNonBlockingFix;

    const config = makeNaxConfig({
      quality: { autofix: { enabled: true } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
      review: {
        nonBlockingFix: {
          enabled: true,
          scope: "triage",
          regressionAttempts: 1,
          verifierGuard: true,
          sourceDiffCap: { maxFiles: 10, maxLines: 500 },
          sources: ["adversarial"],
        },
        adversarial: {
          model: "balanced",
          diffMode: "ref",
          rules: [],
          timeoutMs: 600_000,
          parallel: false,
          maxConcurrentSessions: 2,
        },
      },
    });
    const story = makeStory({ attempts: 1 });
    runtime = makeTestRuntime({ config });
    const ctx = makeMockCallContext({ runtime });
    const adversarialConfig = config.review.adversarial;
    assertDefined(adversarialConfig, "config.review.adversarial");
    const inputs = makeMockPlanInputs({
      story,
      implementer: { story },
      fullSuiteGate: { story, workdir: "/tmp/test" },
      verifier: { story },
      adversarialReview: {
        story,
        workdir: "/tmp/test",
        adversarialConfig,
        mode: adversarialConfig.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });

    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();

    expect(runNonBlockingFix).toHaveBeenCalledTimes(1);
    const deps = runNonBlockingFix.mock.calls[0]?.[1] as { measureSourceDiff?: unknown } | undefined;
    expect(typeof deps?.measureSourceDiff).toBe("function");
  });

  test("non-blocking fix is SKIPPED when every advisory finding requires no action (#1359)", async () => {
    // The observed US-004 case: adversarial passed with ONE advisory finding, and that
    // finding was a compliance confirmation whose own suggestion read "No action needed".
    // NBF opened anyway, dispatched a paid implementer pass, broke a test, and rolled
    // back. With the actionability filter the gate never opens.
    const runNonBlockingFix = mock(async () => ({ ran: true, kept: true, restored: false }));
    _storyOrchestratorDeps.runNonBlockingFix = runNonBlockingFix;

    const callOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = mock(async (_ctx, op) => {
      if (op.name === "adversarial-review") {
        return {
          success: true,
          passed: true,
          advisoryFindings: [
            {
              source: "adversarial-review",
              severity: "warning",
              category: "out-of-scope",
              message: "Removed quarantined:0 — correct per Out of Scope #10",
              suggestion: "No action needed; this is the intended behaviour.",
              actionRequired: false,
            },
          ],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const config = makeNaxConfig({
      quality: { autofix: { enabled: true } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
      review: {
        nonBlockingFix: {
          enabled: true,
          scope: "triage",
          regressionAttempts: 1,
          verifierGuard: true,
          sourceDiffCap: { maxFiles: 10, maxLines: 500 },
          sources: ["adversarial"],
        },
        adversarial: {
          model: "balanced",
          diffMode: "ref",
          rules: [],
          timeoutMs: 600_000,
          parallel: false,
          maxConcurrentSessions: 2,
        },
      },
    });
    const story = makeStory({ attempts: 1 });
    runtime = makeTestRuntime({ config });
    const ctx = makeMockCallContext({ runtime });
    const adversarialConfig = config.review.adversarial;
    assertDefined(adversarialConfig, "config.review.adversarial");
    const inputs = makeMockPlanInputs({
      story,
      implementer: { story },
      fullSuiteGate: { story, workdir: "/tmp/test" },
      verifier: { story },
      adversarialReview: {
        story,
        workdir: "/tmp/test",
        adversarialConfig,
        mode: adversarialConfig.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });

    try {
      const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
      await plan.run();
      expect(runNonBlockingFix).not.toHaveBeenCalled();
    } finally {
      _storyOrchestratorDeps.callOp = callOp;
    }
  });

  test("non-blocking fix is SKIPPED when the story is not green (rectification exhausted with unfixed findings)", async () => {
    // Regression: log 2026-06-24 US-001. Adversarial review FAILED (blocking findings)
    // yet its output still carried advisoryFindings. The outer rectification fixed the
    // blocking findings but its revalidation flipped semantic-review red and exhausted
    // (validate-short-circuit, 6 unfixed findings). nbf then read those advisory findings
    // off the still-failing adversarial output, ran on the red tree, kept cosmetic edits,
    // and the story escalated on the real failures. ADR-024 §5: nbf only acts on an
    // already-green (adversarial-passed) story; its restore-to-adversarial-passed floor is
    // meaningless when the entry state is red.
    const runNonBlockingFix = mock(async () => ({ ran: true, kept: true, restored: false }));
    _storyOrchestratorDeps.runNonBlockingFix = runNonBlockingFix;

    // Adversarial review FAILS (blocking findings) but still surfaces advisory findings —
    // so the main loop short-circuits here and the story is red, yet advisoryFindings > 0.
    _storyOrchestratorDeps.callOp = mock(async (_ctx, op) => {
      if (op.name === "adversarial-review") {
        return {
          success: false,
          passed: false,
          normalizedFindings: [
            { source: "adversarial-review", severity: "error", category: "logic", message: "blocking finding" },
          ],
          advisoryFindings: [
            { source: "adversarial-review", severity: "warning", category: "input", message: "advisory finding" },
          ],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    // Outer rectification exhausts with a non-mechanical unfixed finding → story is red.
    _storyOrchestratorDeps.runFixCycle = async <F extends Finding>() =>
      makeFixCycleResult<F>({
        iterations: [makeIteration({ outcome: "unchanged" })],
        finalFindings: [{ source: "semantic-review", severity: "error", category: "logic", message: "unfixable" }],
        exitReason: "max-attempts-total",
      });

    const config = makeNaxConfig({
      quality: { autofix: { enabled: true } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
      review: {
        nonBlockingFix: {
          enabled: true,
          scope: "triage",
          regressionAttempts: 1,
          verifierGuard: true,
          sourceDiffCap: { maxFiles: 10, maxLines: 500 },
          sources: ["adversarial"],
        },
        adversarial: {
          model: "balanced",
          diffMode: "ref",
          rules: [],
          timeoutMs: 600_000,
          parallel: false,
          maxConcurrentSessions: 2,
        },
      },
    });
    const story = makeStory({ attempts: 1 });
    runtime = makeTestRuntime({ config });
    const ctx = makeMockCallContext({ runtime });
    const adversarialConfig = config.review.adversarial;
    assertDefined(adversarialConfig, "config.review.adversarial");
    const inputs = makeMockPlanInputs({
      story,
      implementer: { story },
      fullSuiteGate: { story, workdir: "/tmp/test" },
      verifier: { story },
      adversarialReview: {
        story,
        workdir: "/tmp/test",
        adversarialConfig,
        mode: adversarialConfig.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });

    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();

    expect(runNonBlockingFix).not.toHaveBeenCalled();
  });

  test("non-blocking fix is SKIPPED when every advisory finding is stamped retired (#1966)", async () => {
    // The wiring's own filter (actionableAdvisoryFindings at execution-plan.ts:402)
    // must close the gate, and runNonBlockingFix must never be invoked. The
    // retirement-filter suite below asserts the same shape on the raw helpers;
    // this test pins the production wiring against a future change that bypasses
    // the filter or passes the raw bucket to the gate.
    const runNonBlockingFix = mock(async () => ({ ran: true, kept: true, restored: false }));
    _storyOrchestratorDeps.runNonBlockingFix = runNonBlockingFix;

    const callOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = mock(async (_ctx, op) => {
      if (op.name === "adversarial-review") {
        return {
          success: true,
          passed: true,
          advisoryFindings: [
            // Only retired entries — every one of them would have bought a paid
            // implementer pass if the wiring had not dropped them at the seed.
            {
              source: "adversarial-review",
              severity: "warning",
              category: "input",
              message: "retired advisory",
              meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
            },
          ],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const config = makeNaxConfig({
      quality: { autofix: { enabled: true } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
      review: {
        nonBlockingFix: {
          enabled: true,
          scope: "triage",
          regressionAttempts: 1,
          verifierGuard: true,
          sourceDiffCap: { maxFiles: 10, maxLines: 500 },
          sources: ["adversarial"],
        },
        adversarial: {
          model: "balanced",
          diffMode: "ref",
          rules: [],
          timeoutMs: 600_000,
          parallel: false,
          maxConcurrentSessions: 2,
        },
      },
    });
    const story = makeStory({ attempts: 1 });
    runtime = makeTestRuntime({ config });
    const ctx = makeMockCallContext({ runtime });
    const adversarialConfig = config.review.adversarial;
    assertDefined(adversarialConfig, "config.review.adversarial");
    const inputs = makeMockPlanInputs({
      story,
      implementer: { story },
      fullSuiteGate: { story, workdir: "/tmp/test" },
      verifier: { story },
      adversarialReview: {
        story,
        workdir: "/tmp/test",
        adversarialConfig,
        mode: adversarialConfig.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });

    try {
      const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
      await plan.run();
      expect(runNonBlockingFix).not.toHaveBeenCalled();
    } finally {
      _storyOrchestratorDeps.callOp = callOp;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004 — Render retirement acknowledgements and suppress fix seeds (#1966).
//
// Retired findings stay in the iteration store and in the run-end advisory
// report (they are reported, not acted on) but MUST NOT buy a paid fix pass:
// telling the reviewer "fix this again" is exactly the loop retirement exists
// to break. The carry-forward prompt moves them out of the verdict list into
// an acknowledgement block; the fix lane must move them out of its seed.
// ─────────────────────────────────────────────────────────────────────────────

describe("actionableAdvisoryFindings — retirement filter (US-004)", () => {
  const advisory = (overrides: Partial<Finding> = {}): Finding => ({
    source: "adversarial-review",
    severity: "warning",
    category: "input",
    message: "m",
    ...overrides,
  });

  // AC 8 — retired-stamped advisory is dropped from the actionability filter.
  test("drops a finding stamped meta.recurrence.disposition retired", () => {
    const kept = actionableAdvisoryFindings([
      advisory({ message: "live advisory" }),
      advisory({
        message: "retired advisory",
        meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
      }),
    ]);
    expect(kept.map((f) => f.message)).toEqual(["live advisory"]);
  });

  // AC 9 — non-retired advisory stamp (disposition: advisory) keeps the finding.
  test("keeps a finding stamped meta.recurrence.disposition advisory", () => {
    const kept = actionableAdvisoryFindings([
      advisory({
        message: "live advisory",
        meta: { recurrence: { disposition: "advisory", rounds: 1 } },
      }),
      advisory({
        message: "demoted still",
        meta: { recurrence: { disposition: "demoted", rounds: 4, wasBlocking: true } },
      }),
    ]);
    expect(kept.map((f) => f.message)).toEqual(["live advisory", "demoted still"]);
  });

  // AC 10 — the actionRequired / acDropped filters still apply alongside the
  // retirement filter; they compose, not replace.
  test("continues to drop actionRequired=false and acDropped=true findings", () => {
    const kept = actionableAdvisoryFindings([
      advisory({ message: "live" }),
      advisory({ message: "compliance", actionRequired: false }),
      advisory({ message: "ac-drop", acDropped: true }),
      // All three filter axes on one finding: still dropped.
      advisory({
        message: "triple filtered",
        actionRequired: false,
        acDropped: true,
        meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
      }),
    ]);
    expect(kept.map((f) => f.message)).toEqual(["live"]);
  });
});

describe("runNonBlockingFix — retired-only seed closes the gate (US-004 AC 11)", () => {
  // AC 11 — an advisory bucket of only retired findings closes the NBF gate
  // and no fix pass is dispatched.
  test("an all-retired advisory bucket closes the NBF gate — no fix pass is dispatched", async () => {
    const cfg = {
      enabled: true,
      scope: "both",
      regressionAttempts: 1,
      verifierGuard: true,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
      sources: ["adversarial"],
    } satisfies NonBlockingFixConfig;
    const advisory: readonly Finding[] = [
      {
        source: "adversarial-review",
        severity: "warning",
        category: "input",
        message: "retired advisory",
        meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
      },
    ];
    const actionable = actionableAdvisoryFindings(advisory);
    // Pre-flight gate: NBF must not open with an empty actionable bucket.
    expect(shouldRunNonBlockingFix(cfg, actionable.length)).toBe(false);

    // End-to-end: even if the gate is bypassed somehow, the harness must not be
    // invoked. We drive runNonBlockingFix directly with the raw advisoryFindings
    // field set to the UNFILTERED bucket — the same shape execution-plan.ts
    // passes after running actionableAdvisoryFindings — and assert no
    // snapshot/commit ever happens. If the actionable filter did not drop the
    // retired entries, the pass would be opened (and a snapshot would fire).
    let snapshots = 0;
    let rectified = false;
    const res = await runNonBlockingFix(
      {
        workdir: "/tmp/x",
        storyId: "us-004-retired",
        advisoryFindings: actionable,
        cfg,
        phaseOutputs: {},
        phaseCosts: {},
        runRectify: async () => {
          rectified = true;
          return { rectificationExhausted: false };
        },
      },
      {
        captureSnapshotRef: async () => {
          snapshots += 1;
          return { sha: "snap-sha", untrackedBefore: [] };
        },
        rollbackToRef: async () => {},
      },
    );
    expect(res).toEqual({ ran: false, kept: false, restored: false });
    expect(snapshots).toBe(0);
    expect(rectified).toBe(false);
  });

  // Guard — a mixed bucket where some entries survive the retirement filter
  // must still dispatch. Otherwise the retire-and-keep-stamping loop would
  // zero out the seed wholesale, even when live findings remain.
  test("mixed bucket (live + retired) still dispatches the pass", async () => {
    const cfg = {
      enabled: true,
      scope: "both",
      regressionAttempts: 1,
      verifierGuard: true,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
      sources: ["adversarial"],
    } satisfies NonBlockingFixConfig;
    const advisory: readonly Finding[] = [
      makeFinding({ source: "adversarial-review", severity: "warning", category: "input", message: "live" }),
      {
        source: "adversarial-review",
        severity: "warning",
        category: "input",
        message: "retired",
        meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
      },
    ];
    const actionable = actionableAdvisoryFindings(advisory);
    expect(actionable).toHaveLength(1);
    expect(shouldRunNonBlockingFix(cfg, actionable.length)).toBe(true);
  });
});
