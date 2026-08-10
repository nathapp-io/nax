import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { buildPlanForStrategy, _storyOrchestratorDeps } from "@/execution";
import type { PlanInputs } from "@/execution";
import { makeAutofixTestWriterStrategy, makeDeclarationSink } from "@/operations";
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

describe("buildPlanForStrategy — AC2/AC3/AC4: triage strategy predicate behavior (driven through plan)", () => {
  let capturedStrategiesByCall: Array<Array<import("@/findings").FixStrategy<import("@/findings").Finding, any, any, any>>> = [];
  let origRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
  let origCallOp: typeof _storyOrchestratorDeps.callOp;
  let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
  let origRollbackSpawn: typeof _rollbackDeps.spawn;
  let origRollbackAutoCommit: typeof _rollbackDeps.autoCommitIfDirty;
  let runtime: NaxRuntime | undefined;

  beforeEach(() => {
    capturedStrategiesByCall = [];
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
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.runFixCycle = mock(
      async (cycle: { strategies: Array<import("@/findings").FixStrategy<import("@/findings").Finding, any, any, any>> }) => {
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

  function makeCtxWithRuntime(config = makeNaxConfig()) {
    runtime = makeTestRuntime({ config });
    return makeMockCallContext({ runtime });
  }

  function withTriageNbf(): ReturnType<typeof makeNaxConfig> {
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
          },
        },
      },
    });
  }

  function nbfStrategies(): Array<import("@/findings").FixStrategy<import("@/findings").Finding, any, any, any>> {
    if (capturedStrategiesByCall.length === 0) {
      throw new Error("NBF never fired — capturedStrategiesByCall is empty");
    }
    return capturedStrategiesByCall[capturedStrategiesByCall.length - 1] ?? [];
  }

  function findStrategy(
    name: string,
    set: Array<import("@/findings").FixStrategy<import("@/findings").Finding, any, any, any>>,
  ): import("@/findings").FixStrategy<import("@/findings").Finding, any, any, any> {
    const strategy = set.find((entry) => entry.name === name);
    if (!strategy) {
      throw new Error(`strategy '${name}' not found in captured NBF set: ${set.map((entry) => entry.name).join(", ")}`);
    }
    return strategy;
  }

  async function buildAndRunTriagePlan() {
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
  }

  function makeFinding(overrides: Record<string, unknown> = {}): import("@/findings").Finding {
    return {
      source: "lint",
      severity: "error",
      category: "lint-error",
      message: "msg",
      fixTarget: "source",
      ...overrides,
    };
  }

  test("AC2: triage scope → implementer.appliesTo=true and test-writer.appliesTo=false for adversarial source finding", async () => {
    await buildAndRunTriagePlan();
    const nbfSet = nbfStrategies();
    const implementer = findStrategy("autofix-implementer", nbfSet);
    const testWriter = findStrategy("autofix-test-writer", nbfSet);
    const finding = makeFinding({ source: "adversarial-review", fixTarget: "source" });
    expect(implementer.appliesTo(finding)).toBe(true);
    expect(testWriter.appliesTo(finding)).toBe(false);
  });

  test("AC3: triage scope → test-writer.appliesTo=true and implementer.appliesTo=false for adversarial test finding", async () => {
    await buildAndRunTriagePlan();
    const nbfSet = nbfStrategies();
    const implementer = findStrategy("autofix-implementer", nbfSet);
    const testWriter = findStrategy("autofix-test-writer", nbfSet);
    const finding = makeFinding({ source: "adversarial-review", fixTarget: "test" });
    expect(testWriter.appliesTo(finding)).toBe(true);
    expect(implementer.appliesTo(finding)).toBe(false);
  });

  test("AC4: triage scope → test-writer.appliesTo=true for advisory convention finding with fixTarget=test", async () => {
    await buildAndRunTriagePlan();
    const nbfSet = nbfStrategies();
    const testWriter = findStrategy("autofix-test-writer", nbfSet);
    const finding = makeFinding({
      source: "adversarial-review",
      category: "convention",
      fixTarget: "test",
    });
    expect(testWriter.appliesTo(finding)).toBe(true);
  });
});

describe("buildPlanForStrategy — AC5/AC6: default-preserving factory options + blocking set behaviour", () => {
  test("AC5: default makeAutofixTestWriterStrategy still claims adversarial source finding (preserves blanket behaviour)", () => {
    const testWriter = makeAutofixTestWriterStrategy(makeStory(), makeNaxConfig(), makeDeclarationSink());
    const finding: import("@/findings").Finding = {
      source: "adversarial-review",
      severity: "warning",
      category: "input",
      message: "advisory finding",
      fixTarget: "source",
    };
    expect(testWriter.appliesTo(finding)).toBe(true);
  });

  test("AC6 (#1333): blocking three-session set → implementer claims adversarial SOURCE finding, test-writer claims adversarial TEST finding (driven through plan)", async () => {
    const capturedStrategySets: Array<Array<import("@/findings").FixStrategy<import("@/findings").Finding, any, any, any>>> = [];
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    const origCallOp = _storyOrchestratorDeps.callOp;
    const origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
    const origRollbackSpawn = _rollbackDeps.spawn;
    const origRollbackAutoCommit = _rollbackDeps.autoCommitIfDirty;
    let localRuntime: NaxRuntime | undefined;

    try {
      _storyOrchestratorDeps.captureGitRef = mock(async () => "HEAD");
      _rollbackDeps.autoCommitIfDirty = mock(async () => {});
      _rollbackDeps.spawn = mock((_cmd: string[], _opts: unknown) => ({
        stdout: new Response("abc1234\n").body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
      })) as typeof _rollbackDeps.spawn;
      _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
        if (op.name === "full-suite-gate") {
          return {
            success: false,
            findings: [{ source: "test-runner", severity: "error", message: "test failed" }],
          };
        }
        return { success: true };
      }) as typeof _storyOrchestratorDeps.callOp;
      _storyOrchestratorDeps.runFixCycle = mock(
        async (cycle: { strategies: Array<import("@/findings").FixStrategy<import("@/findings").Finding, any, any, any>> }) => {
          capturedStrategySets.push(cycle.strategies);
          return { iterations: [], finalFindings: [], exitReason: "no-strategy" as const, costUsd: 0 };
        },
      ) as typeof _storyOrchestratorDeps.runFixCycle;

      const config = makeNaxConfig({
        quality: { commands: {}, autofix: { enabled: true } },
        execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
      });
      const story = makeStory({ attempts: 1 });
      localRuntime = makeTestRuntime({ config });
      const ctx = makeMockCallContext({ runtime: localRuntime });
      const inputs = makeTddRetryInputs(story, {
        rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
      });
      const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
      await plan.run();

      const mainRectSet = capturedStrategySets[capturedStrategySets.length - 1] ?? [];
      expect(mainRectSet.length).toBeGreaterThan(0);
      const implementer = mainRectSet.find((strategy) => strategy.name === "autofix-implementer");
      const testWriter = mainRectSet.find((strategy) => strategy.name === "autofix-test-writer");
      expect(implementer).toBeDefined();
      expect(testWriter).toBeDefined();
      // Source-targeted adversarial finding (category ∈ BLOCKING_CATEGORIES) must
      // go to the implementer, which can edit source — NOT the test-writer, which
      // is forbidden from touching source. Prior to #1333 this was inverted and
      // such findings could never be fixed.
      const sourceFinding: import("@/findings").Finding = {
        source: "adversarial-review",
        severity: "error",
        category: "error-path",
        message: "source correctness bug",
        fixTarget: "source",
      };
      expect(implementer!.appliesTo(sourceFinding)).toBe(true);
      expect(testWriter!.appliesTo(sourceFinding)).toBe(false);
      // Test-targeted adversarial finding still goes to the test-writer.
      const testFinding: import("@/findings").Finding = {
        source: "adversarial-review",
        severity: "warning",
        category: "convention",
        message: "missing coverage",
        fixTarget: "test",
      };
      expect(testWriter!.appliesTo(testFinding)).toBe(true);
      expect(implementer!.appliesTo(testFinding)).toBe(false);
    } finally {
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
      _rollbackDeps.spawn = origRollbackSpawn;
      _rollbackDeps.autoCommitIfDirty = origRollbackAutoCommit;
      await localRuntime?.close();
    }
  });
});
