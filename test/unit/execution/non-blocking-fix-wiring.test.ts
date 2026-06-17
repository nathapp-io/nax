// test/unit/execution/non-blocking-fix-wiring.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { buildPlanForStrategy, _storyOrchestratorDeps } from "@/execution";
import { shouldRunNonBlockingFix } from "../../../src/execution/non-blocking-fix";
import type { NaxRuntime } from "@/runtime";
import { _rollbackDeps } from "@/tdd";
import { makeMockCallContext, makeMockPlanInputs, makeNaxConfig, makeStory, makeTestRuntime } from "@test/helpers";

describe("non-blocking-fix wiring gate", () => {
  test("gate is off without config", () => {
    expect(shouldRunNonBlockingFix(undefined, 5)).toBe(false);
  });
  test("gate is on when enabled with advisory findings", () => {
    expect(
      shouldRunNonBlockingFix({ enabled: true, scope: "both", regressionAttempts: 1, verifierGuard: true }, 5),
    ).toBe(true);
  });
  test("gate is off when enabled but zero advisory findings", () => {
    expect(
      shouldRunNonBlockingFix({ enabled: true, scope: "source", regressionAttempts: 1, verifierGuard: false }, 0),
    ).toBe(false);
  });
  test("gate is off when config present but disabled", () => {
    expect(
      shouldRunNonBlockingFix({ enabled: false, scope: "both", regressionAttempts: 1, verifierGuard: true }, 3),
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
    _rollbackDeps.spawn = mock((_cmd: string[], _opts: unknown) => ({
      stdout: new Response("abc1234\n").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
    })) as typeof _rollbackDeps.spawn;
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
    const runNonBlockingFix = mock(async () => ({ ran: true, kept: true, restored: false }));
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
          nonBlockingFix: { enabled: true, scope: "triage", regressionAttempts: 1, verifierGuard: true },
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
});
