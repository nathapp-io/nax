import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { buildPlanForStrategy, _storyOrchestratorDeps } from "@/execution";
import type { PlanInputs } from "@/execution";
import type { UserStory } from "@/prd/types";
import type { NaxRuntime } from "@/runtime";
import { _rollbackDeps } from "@/tdd";
import { makeMockCallContext, makeMockPlanInputs, makeNaxConfig, makeStory, makeTestRuntime } from "@test/helpers";

function makeImplementerInput(story: UserStory): import("@/operations").ImplementerInput {
  return { story };
}

function makeVerifierInput(story: UserStory): import("@/operations").VerifierInput {
  return { story };
}

function makeFullSuiteGateInput(story: UserStory): import("@/operations").FullSuiteGateInput {
  return { story, workdir: "/tmp/test" };
}

function makeTddRetryInputs(story: UserStory, extra: Partial<PlanInputs> = {}): PlanInputs {
  return makeMockPlanInputs({
    story,
    implementer: makeImplementerInput(story),
    fullSuiteGate: makeFullSuiteGateInput(story),
    verifier: makeVerifierInput(story),
    ...extra,
  });
}

describe("buildPlanForStrategy — AC1: triage scope NBF strategy assembly (US-006)", () => {
  let capturedStrategyNamesByCall: string[][] = [];
  let origRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
  let origCallOp: typeof _storyOrchestratorDeps.callOp;
  let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
  let origRollbackSpawn: typeof _rollbackDeps.spawn;
  let origRollbackAutoCommit: typeof _rollbackDeps.autoCommitIfDirty;
  let runtime: NaxRuntime | undefined;

  beforeEach(() => {
    capturedStrategyNamesByCall = [];
    origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    origCallOp = _storyOrchestratorDeps.callOp;
    origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
    origRollbackSpawn = _rollbackDeps.spawn;
    origRollbackAutoCommit = _rollbackDeps.autoCommitIfDirty;

    _storyOrchestratorDeps.captureGitRef = mock(async () => "HEAD");
    _rollbackDeps.autoCommitIfDirty = mock(async () => {});
    _rollbackDeps.spawn = mock((_cmd: string[], _opts: unknown) => ({
      stdout: new Response("abc1234\n").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
    })) as typeof _rollbackDeps.spawn;
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "adversarial-review") {
        return {
          success: true,
          passed: true,
          advisoryFindings: [
            {
              source: "adversarial-review",
              severity: "info",
              category: "test-gap",
              message: "advisory gap",
              fixTarget: "test",
            },
          ],
        };
      }
      if (op.name === "full-suite-gate") {
        return {
          success: false,
          findings: [{ source: "test-runner", severity: "error", message: "test failed" }],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: { strategies: Array<{ name: string }> }) => {
      capturedStrategyNamesByCall.push(cycle.strategies.map((s) => s.name));
      return { iterations: [], finalFindings: [], exitReason: "no-strategy" as const, costUsd: 0 };
    }) as typeof _storyOrchestratorDeps.runFixCycle;
  });

  afterEach(async () => {
    _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    _storyOrchestratorDeps.callOp = origCallOp;
    _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
    _rollbackDeps.spawn = origRollbackSpawn;
    _rollbackDeps.autoCommitIfDirty = origRollbackAutoCommit;
    await runtime?.close();
    runtime = undefined;
  });

  function lastCaptured(): string[] {
    return capturedStrategyNamesByCall[capturedStrategyNamesByCall.length - 1] ?? [];
  }

  function makeCtxWithRuntime(config = makeNaxConfig()) {
    runtime = makeTestRuntime({ config });
    return makeMockCallContext({ runtime });
  }

  function withTriageNbf(extra: Record<string, unknown> = {}): ReturnType<typeof makeNaxConfig> {
    return makeNaxConfig({
      quality: { commands: {}, autofix: { enabled: true } },
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
            ...extra,
          },
        },
      },
    });
  }

  function withNbfScope(scope: "source" | "both" | "triage"): ReturnType<typeof makeNaxConfig> {
    return makeNaxConfig({
      quality: { commands: {}, autofix: { enabled: true } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
      review: {
        adversarial: {
          model: "balanced",
          diffMode: "ref",
          rules: [],
          timeoutMs: 600_000,
          parallel: false,
          maxConcurrentSessions: 2,
          nonBlockingFix: { enabled: true, scope, regressionAttempts: 1, verifierGuard: true },
        },
      },
    });
  }

  test("AC1: NBF scope=triage assembles autofix-implementer, autofix-test-writer, full-suite-rectify", async () => {
    const story = makeStory({ attempts: 1 });
    const config = withTriageNbf();
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      adversarialReview: {
        story,
        adversarialConfig: config.review.adversarial!,
        mode: config.review.adversarial!.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNamesByCall.length).toBeGreaterThanOrEqual(2);
    const nbfNames = lastCaptured();
    expect(nbfNames).toContain("autofix-implementer");
    expect(nbfNames).toContain("autofix-test-writer");
    expect(nbfNames).toContain("full-suite-rectify");
  });

  test("AC1: NBF scope=triage does NOT regress — scope=both still assembles the same three", async () => {
    const story = makeStory({ attempts: 1 });
    const config = withNbfScope("both");
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      adversarialReview: {
        story,
        adversarialConfig: config.review.adversarial!,
        mode: config.review.adversarial!.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNamesByCall.length).toBeGreaterThanOrEqual(2);
    const nbfNames = lastCaptured();
    expect(nbfNames).toContain("autofix-implementer");
    expect(nbfNames).toContain("autofix-test-writer");
    expect(nbfNames).toContain("full-suite-rectify");
  });

  test("AC1: NBF scope=source still assembles only autofix-implementer + full-suite-rectify", async () => {
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "adversarial-review") {
        return {
          success: true,
          passed: true,
          advisoryFindings: [
            {
              source: "adversarial-review",
              severity: "info",
              category: "test-gap",
              message: "advisory gap",
              fixTarget: "test",
            },
          ],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const story = makeStory({ attempts: 1 });
    const config = withNbfScope("source");
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      adversarialReview: {
        story,
        adversarialConfig: config.review.adversarial!,
        mode: config.review.adversarial!.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNamesByCall.length).toBeGreaterThanOrEqual(1);
    const nbfNames = capturedStrategyNamesByCall[0] ?? [];
    expect(nbfNames).toContain("autofix-implementer");
    expect(nbfNames).toContain("full-suite-rectify");
    expect(nbfNames).not.toContain("autofix-test-writer");
  });
});
