// test/unit/execution/non-blocking-fix-wiring.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _storyOrchestratorDeps, buildPlanForStrategy } from "@/execution";
import type { NonBlockingFixArgs, NonBlockingFixDeps } from "@/execution/non-blocking-fix";
import { shouldRunNonBlockingFix } from "@/execution/non-blocking-fix";
import type { NaxRuntime } from "@/runtime";
import { _rollbackDeps } from "@/tdd";
import {
  makeMockCallContext,
  makeMockPlanInputs,
  makeNaxConfig,
  makeSpawn,
  makeStory,
  makeTestRuntime,
} from "@test/helpers";

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
  let origRunNonBlockingFix: unknown;
  let runtime: NaxRuntime | undefined;

  beforeEach(() => {
    origCallOp = _storyOrchestratorDeps.callOp;
    origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
    origRollbackSpawn = _rollbackDeps.spawn;
    origRollbackAutoCommit = _rollbackDeps.autoCommitIfDirty;
    origRunNonBlockingFix = (_storyOrchestratorDeps as { runNonBlockingFix?: unknown }).runNonBlockingFix;

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
    _storyOrchestratorDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "no-strategy" as const,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;

    _rollbackDeps.autoCommitIfDirty = mock(async () => {});
    _rollbackDeps.spawn = makeSpawn(() => "abc1234\n").spawn;
  });

  afterEach(async () => {
    _storyOrchestratorDeps.callOp = origCallOp;
    _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
    _rollbackDeps.spawn = origRollbackSpawn;
    _rollbackDeps.autoCommitIfDirty = origRollbackAutoCommit;
    if (origRunNonBlockingFix === undefined) {
      delete (_storyOrchestratorDeps as { runNonBlockingFix?: unknown }).runNonBlockingFix;
    } else {
      (_storyOrchestratorDeps as { runNonBlockingFix?: unknown }).runNonBlockingFix = origRunNonBlockingFix;
    }
    await runtime?.close();
    runtime = undefined;
  });

  test("story orchestrator routes non-blocking fix through injected runtime wiring with measureSourceDiff", async () => {
    const runNonBlockingFix = mock(async (_args: NonBlockingFixArgs, _overrides: Partial<NonBlockingFixDeps>) => ({
      ran: true,
      kept: true,
      restored: false,
    }));
    (_storyOrchestratorDeps as { runNonBlockingFix?: typeof runNonBlockingFix }).runNonBlockingFix = runNonBlockingFix;

    const config = makeNaxConfig({
      quality: { autofix: { enabled: true } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
      review: {
        adversarial: {
          model: "balanced",
          diffMode: "ref",
          rules: [],
          timeoutMs: 600_000,
          parallel: false,
          maxConcurrentSessions: 2,
          nonBlockingFix: {
            enabled: true,
            scope: "triage",
            regressionAttempts: 1,
            verifierGuard: true,
            sourceDiffCap: { maxFiles: 10, maxLines: 500 },
          },
        },
      },
    });
    const story = makeStory({ attempts: 1 });
    runtime = makeTestRuntime({ config });
    const ctx = makeMockCallContext({ runtime });
    const inputs = makeMockPlanInputs({
      story,
      implementer: { story },
      fullSuiteGate: { story, workdir: "/tmp/test" },
      verifier: { story },
      adversarialReview: {
        story,
        workdir: "/tmp/test",
        adversarialConfig: config.review.adversarial!,
        mode: config.review.adversarial!.diffMode,
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
    (_storyOrchestratorDeps as { runNonBlockingFix?: typeof runNonBlockingFix }).runNonBlockingFix = runNonBlockingFix;

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
        adversarial: {
          model: "balanced",
          diffMode: "ref",
          rules: [],
          timeoutMs: 600_000,
          parallel: false,
          maxConcurrentSessions: 2,
          nonBlockingFix: {
            enabled: true,
            scope: "triage",
            regressionAttempts: 1,
            verifierGuard: true,
            sourceDiffCap: { maxFiles: 10, maxLines: 500 },
          },
        },
      },
    });
    const story = makeStory({ attempts: 1 });
    runtime = makeTestRuntime({ config });
    const ctx = makeMockCallContext({ runtime });
    const inputs = makeMockPlanInputs({
      story,
      implementer: { story },
      fullSuiteGate: { story, workdir: "/tmp/test" },
      verifier: { story },
      adversarialReview: {
        story,
        workdir: "/tmp/test",
        adversarialConfig: config.review.adversarial!,
        mode: config.review.adversarial!.diffMode,
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
    (_storyOrchestratorDeps as { runNonBlockingFix?: typeof runNonBlockingFix }).runNonBlockingFix = runNonBlockingFix;

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
    _storyOrchestratorDeps.runFixCycle = mock(async () => ({
      iterations: [{}],
      finalFindings: [{ source: "semantic-review", severity: "error", category: "logic", message: "unfixable" }],
      exitReason: "max-attempts-total" as const,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;

    const config = makeNaxConfig({
      quality: { autofix: { enabled: true } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
      review: {
        adversarial: {
          model: "balanced",
          diffMode: "ref",
          rules: [],
          timeoutMs: 600_000,
          parallel: false,
          maxConcurrentSessions: 2,
          nonBlockingFix: {
            enabled: true,
            scope: "triage",
            regressionAttempts: 1,
            verifierGuard: true,
            sourceDiffCap: { maxFiles: 10, maxLines: 500 },
          },
        },
      },
    });
    const story = makeStory({ attempts: 1 });
    runtime = makeTestRuntime({ config });
    const ctx = makeMockCallContext({ runtime });
    const inputs = makeMockPlanInputs({
      story,
      implementer: { story },
      fullSuiteGate: { story, workdir: "/tmp/test" },
      verifier: { story },
      adversarialReview: {
        story,
        workdir: "/tmp/test",
        adversarialConfig: config.review.adversarial!,
        mode: config.review.adversarial!.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });

    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();

    expect(runNonBlockingFix).not.toHaveBeenCalled();
  });
});
