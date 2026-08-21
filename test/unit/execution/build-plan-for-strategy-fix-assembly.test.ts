import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { buildPlanForStrategy, _storyOrchestratorDeps } from "@/execution";
import type { PlanInputs } from "@/execution";
import type { UserStory } from "@/prd/types";
import type { NaxRuntime } from "@/runtime";
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

function makeNonTddInputs(story: UserStory, extra: Partial<PlanInputs> = {}): PlanInputs {
  return makeMockPlanInputs({
    story,
    implementer: makeImplementerInput(story),
    ...extra,
  });
}

describe("buildPlanForStrategy — AC4: fix strategy assembly (US-005)", () => {
  let capturedStrategyNames: string[] = [];
  let origRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
  let origCallOp: typeof _storyOrchestratorDeps.callOp;
  let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
  let runtime: NaxRuntime | undefined;

  beforeEach(() => {
    capturedStrategyNames = [];
    origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    origCallOp = _storyOrchestratorDeps.callOp;
    origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;

    _storyOrchestratorDeps.captureGitRef = mock(async () => "HEAD");
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "verifier") {
        return { success: false, findings: [{ source: "test-runner", severity: "error", message: "test failed" }] };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: { strategies: Array<{ name: string }> }) => {
      capturedStrategyNames = cycle.strategies.map((s) => s.name);
      return { iterations: [], finalFindings: [], exitReason: "no-strategy" as const, costUsd: 0 };
    }) as typeof _storyOrchestratorDeps.runFixCycle;
  });

  afterEach(async () => {
    _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    _storyOrchestratorDeps.callOp = origCallOp;
    _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
    await runtime?.close();
    runtime = undefined;
  });

  function makeCtxWithRuntime(config = makeNaxConfig()) {
    runtime = makeTestRuntime({ config });
    return makeMockCallContext({ runtime });
  }

  test("AC4: lintFix command configured → mechanical-lintfix strategy assembled in rectification", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig({
      quality: { commands: { lintFix: "bun run lint:fix" } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNames).toContain("mechanical-lintfix");
  });

  test("AC4: formatFix command configured → mechanical-formatfix strategy assembled in rectification", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig({
      quality: { commands: { formatFix: "bun run format:fix" } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNames).toContain("mechanical-formatfix");
  });

  test("AC4: non-TDD verify-scoped failure still enters rectification", async () => {
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "verify-scoped") {
        return {
          success: false,
          findings: [{ source: "test-runner", severity: "error", message: "scoped test failed" }],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const story = makeStory();
    const config = makeNaxConfig({
      quality: { commands: { lintFix: "bun run lint:fix" } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeNonTddInputs(story, {
      verifyScoped: { workdir: "/tmp/test", storyId: story.id },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    await plan.run();
    expect(capturedStrategyNames.length).toBeGreaterThan(0);
  });

  test("AC4: autofix enabled → autofix-implementer strategy assembled in rectification", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig({
      quality: { autofix: { enabled: true } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNames).toContain("autofix-implementer");
  });

  test("AC4: autofix enabled → autofix-test-writer strategy assembled in rectification", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig({
      quality: { autofix: { enabled: true } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNames).toContain("autofix-test-writer");
  });

  test("AC4: no fix commands + autofix disabled → no mechanical or autofix strategies assembled", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig({
      quality: { commands: {}, autofix: { enabled: false } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNames).not.toContain("mechanical-lintfix");
    expect(capturedStrategyNames).not.toContain("mechanical-formatfix");
    expect(capturedStrategyNames).not.toContain("autofix-implementer");
    expect(capturedStrategyNames).not.toContain("autofix-test-writer");
  });

  test("regression: single-session + verifyScoped phase → full-suite-rectify assembled (was no-strategy)", async () => {
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "verify-scoped") {
        return {
          success: false,
          findings: [
            { source: "test-runner", severity: "error", category: "failed-test", message: "scoped test failed" },
          ],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const story = makeStory();
    const config = makeNaxConfig({
      quality: { commands: {}, autofix: { enabled: false } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeNonTddInputs(story, {
      verifyScoped: { workdir: "/tmp/test", storyId: story.id },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    await plan.run();
    // #1654 registers the repo-scoped fallthrough alongside the story-scoped
    // strategy, and the ORDER is load-bearing: selectExecutionGroup takes the
    // first exclusive claimant, so the scoped strategy must be tried first and
    // the fallthrough reached only after it declines.
    expect(capturedStrategyNames).toEqual(["full-suite-rectify", "regression-fix"]);
  });

  test("#1654: repoScopedFallback: false leaves the story-scoped strategy alone", async () => {
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "verify-scoped") {
        return {
          success: false,
          findings: [
            { source: "test-runner", severity: "error", category: "failed-test", message: "scoped test failed" },
          ],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const story = makeStory();
    const config = makeNaxConfig({
      quality: { commands: {}, autofix: { enabled: false } },
      execution: {
        rectification: { enabled: true, maxAttemptsTotal: 2, repoScopedFallback: false },
      },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeNonTddInputs(story, {
      verifyScoped: { workdir: "/tmp/test", storyId: story.id },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    await plan.run();
    expect(capturedStrategyNames).toEqual(["full-suite-rectify"]);
  });

  test("single-session without verifyScoped phase → full-suite-rectify NOT assembled", async () => {
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "lint-check") {
        return { success: false, findings: [{ source: "lint", severity: "error", message: "lint failed" }] };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const story = makeStory();
    const config = makeNaxConfig({
      quality: { commands: { lintFix: "bun run lint:fix" }, autofix: { enabled: false } },
      execution: { regressionGate: { mode: "deferred" }, rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeNonTddInputs(story, {
      lintCheck: { workdir: "/tmp/test", storyId: story.id },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    await plan.run();
    expect(capturedStrategyNames).toContain("mechanical-lintfix");
    expect(capturedStrategyNames).not.toContain("full-suite-rectify");
  });

  test("no-regression: three-session TDD still assembles full-suite-rectify", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig({
      quality: { commands: {}, autofix: { enabled: false } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNames).toContain("full-suite-rectify");
  });
});
