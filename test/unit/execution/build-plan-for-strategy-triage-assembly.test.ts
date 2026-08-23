import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _storyOrchestratorDeps, buildPlanForStrategy } from "@/execution";
import type { PlanInputs } from "@/execution";
import type { UserStory } from "@/prd/types";
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
  // Full strategy objects from each fix-cycle call, so tests can invoke
  // buildInput and assert the prompt severity floor was wired (not just names).
  let capturedStrategiesByCall: Array<
    Array<{ name: string; buildInput: (...args: never[]) => unknown; appliesTo: (f: never) => boolean }>
  > = [];
  let origRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
  let origCallOp: typeof _storyOrchestratorDeps.callOp;
  let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
  let origRollbackSpawn: typeof _rollbackDeps.spawn;
  let origRollbackAutoCommit: typeof _rollbackDeps.autoCommitIfDirty;
  let runtime: NaxRuntime | undefined;

  beforeEach(() => {
    capturedStrategyNamesByCall = [];
    capturedStrategiesByCall = [];
    origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    origCallOp = _storyOrchestratorDeps.callOp;
    origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
    origRollbackSpawn = _rollbackDeps.spawn;
    origRollbackAutoCommit = _rollbackDeps.autoCommitIfDirty;

    _storyOrchestratorDeps.captureGitRef = mock(async () => "HEAD");
    _rollbackDeps.autoCommitIfDirty = mock(async () => {});
    _rollbackDeps.spawn = makeSpawn(() => "abc1234\n").spawn;
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
    _storyOrchestratorDeps.runFixCycle = mock(
      async (cycle: {
        strategies: Array<{
          name: string;
          buildInput: (...args: never[]) => unknown;
          appliesTo: (f: never) => boolean;
        }>;
      }) => {
        capturedStrategyNamesByCall.push(cycle.strategies.map((s) => s.name));
        capturedStrategiesByCall.push(cycle.strategies);
        return { iterations: [], finalFindings: [], exitReason: "no-strategy" as const, costUsd: 0 };
      },
    ) as typeof _storyOrchestratorDeps.runFixCycle;
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
            sourceDiffCap: { maxFiles: 10, maxLines: 500 },
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
          nonBlockingFix: {
            enabled: true,
            scope,
            regressionAttempts: 1,
            verifierGuard: true,
            sourceDiffCap: { maxFiles: 10, maxLines: 500 },
          },
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
        workdir: "/tmp/test",
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

  test("NBF scope=triage wires promptSeverityFloor='info' so advisory findings render (not just names)", async () => {
    // Green gate (every op except adversarial-review succeeds) so the story is
    // green and the non-blocking fix cycle actually runs — that cycle is the
    // captured set. (A failing gate would instead capture the main rectification
    // cycle, which shares the same strategy names but carries the run threshold.)
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
    const config = withNbfScope("triage");
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
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

    // Drive a sub-error (info) advisory finding through the assembled autofix
    // strategies' buildInput and assert the "info" floor reached the op input.
    // A dropped `promptSeverityFloor: "info"` in either non-blocking branch would
    // surface here as "error" (the run threshold), reproducing the empty-prompt bug.
    const advisory = {
      source: "adversarial-review",
      severity: "info",
      category: "test-gap",
      message: "advisory gap",
      fixTarget: "test",
    } as never;
    const floorOf = (s?: { buildInput: (...args: never[]) => unknown }) =>
      (s?.buildInput([advisory] as never, [] as never, {} as never) as { blockingThreshold?: string } | undefined)
        ?.blockingThreshold;

    const nbfSet = capturedStrategiesByCall[0] ?? [];
    expect(nbfSet.length).toBeGreaterThan(0);
    expect(floorOf(nbfSet.find((s) => s.name === "autofix-test-writer"))).toBe("info");
    expect(floorOf(nbfSet.find((s) => s.name === "autofix-implementer"))).toBe("info");
  });

  test("AC1: NBF scope=triage does NOT regress — scope=both still assembles the same three", async () => {
    const story = makeStory({ attempts: 1 });
    const config = withNbfScope("both");
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
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
        workdir: "/tmp/test",
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

  // Single-session strategies (tdd-simple / test-after / no-test) have no
  // separate test-writer session. The non-blocking fix must route advisory
  // adversarial findings to the warm implementer instead of waking a cold
  // test-writer session — regardless of nbf.scope. (US-003 in 2026-06-23 run log.)
  function makeSingleSessionInputs(story: UserStory, config: ReturnType<typeof makeNaxConfig>): PlanInputs {
    return makeMockPlanInputs({
      story,
      implementer: makeImplementerInput(story),
      verifyScoped: { workdir: "/tmp/test", storyId: story.id },
      adversarialReview: {
        story,
        workdir: "/tmp/test",
        adversarialConfig: config.review.adversarial!,
        mode: config.review.adversarial!.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
  }

  const advisoryAdversarial = {
    source: "adversarial-review",
    severity: "info",
    category: "test-gap",
    message: "advisory gap",
    fixTarget: "test",
  } as never;

  for (const scope of ["both", "triage", "source"] as const) {
    test(`single-session (tdd-simple) NBF scope=${scope} routes adversarial to implementer, never test-writer`, async () => {
      // Green story (every op except adversarial-review succeeds) so the
      // non-blocking fix cycle runs and is the captured strategy set.
      _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
        if (op.name === "adversarial-review") {
          return { success: true, passed: true, advisoryFindings: [advisoryAdversarial] };
        }
        return { success: true };
      }) as typeof _storyOrchestratorDeps.callOp;

      const story = makeStory({ attempts: 1 });
      const config = withNbfScope(scope);
      const ctx = makeCtxWithRuntime(config);
      const inputs = makeSingleSessionInputs(story, config);
      const plan = await buildPlanForStrategy(ctx, story, config, "tdd-simple", inputs);
      await plan.run();

      const nbfSet = capturedStrategiesByCall[0] ?? [];
      const nbfNames = nbfSet.map((s) => s.name);
      // No cold test-writer session for a single-session story.
      expect(nbfNames).not.toContain("autofix-test-writer");
      expect(nbfNames).toContain("autofix-implementer");
      expect(nbfNames).toContain("full-suite-rectify");
      // The implementer must claim the advisory adversarial finding — otherwise it
      // has no owner and the cycle exits "no-strategy" without a single fix attempt.
      const implementer = nbfSet.find((s) => s.name === "autofix-implementer");
      expect(implementer?.appliesTo(advisoryAdversarial)).toBe(true);
      // The "info" floor must reach the op input — advisory findings sit below the
      // run's blocking threshold, so a dropped floor renders an empty prompt.
      const floor = (
        implementer?.buildInput([advisoryAdversarial] as never, [] as never, {} as never) as {
          blockingThreshold?: string;
        }
      )?.blockingThreshold;
      expect(floor).toBe("info");
    });
  }
});
