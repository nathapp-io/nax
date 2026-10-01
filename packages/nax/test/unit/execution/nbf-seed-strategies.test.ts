// test/unit/execution/nbf-seed-strategies.test.ts
//
// US-002 — Strategy-set behavior when the seed union includes advisories
// from semantic review.
//
// AC11 — Mixed-threshold safety: when `review.blockingThreshold` is `error`
// and then `warning`, the nbf strategy set's `autofix-implementer` strategy
// must still pass `promptSeverityFloor: "info"` (so advisory findings below
// the run's blocking threshold render into the rectifier prompt). This
// behavior is currently load-bearing but pinned only by a comment about
// empty findings lists; this test pins the floor value itself.
//
// AC12 — Source-target claim: a semantic-review finding with
// `fixTarget: "source"` is claimed by `autofix-implementer` regardless of
// the `adversarialReviewByFixTarget` switch — that switch only narrows the
// adversarial bucket; semantic-review is in the `IMPLEMENTER_SOURCES` set
// unconditionally.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  assertDefined,
  makeMockCallContext,
  makeMockPlanInputs,
  makeNaxConfig,
  makeSpawn,
  makeStory,
  makeTestRuntime,
} from "@test/helpers";
import type { PlanInputs } from "@/execution";
import { _storyOrchestratorDeps, buildPlanForStrategy } from "@/execution";
import type { Finding, FixCycleContext, FixStrategy } from "@/findings";
import type { UserStory } from "@/prd/types";
import type { NaxRuntime } from "@/runtime";
import { _rollbackDeps } from "@/tdd";

type RunFixCycleCycle = Parameters<typeof _storyOrchestratorDeps.runFixCycle>[0];
type CapturedStrategy = RunFixCycleCycle["strategies"][number];

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

function makeFixCycleContext(): FixCycleContext {
  return { ...makeMockCallContext(), storyId: "US-002" };
}

function withTriageNbf(blockingThreshold: "error" | "warning"): ReturnType<typeof makeNaxConfig> {
  return makeNaxConfig({
    quality: { commands: {}, autofix: { enabled: true } },
    execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    review: {
      // AC11 — vary the run's blocking threshold. The nbf strategy set must
      // still pin `promptSeverityFloor: "info"` so advisory findings render.
      blockingThreshold,
      nonBlockingFix: {
        enabled: true,
        scope: "triage",
        regressionAttempts: 1,
        verifierGuard: true,
        sourceDiffCap: { maxFiles: 10, maxLines: 500 },
        sources: ["adversarial", "semantic"],
      },
      adversarial: {
        model: "balanced",
        diffMode: "ref",
        rules: [],
        timeoutMs: 600_000,
      },
      semantic: {
        model: "balanced",
        diffMode: "ref",
        rules: [],
        timeoutMs: 600_000,
      },
    },
  });
}

describe("nbf-seed strategy set — AC11: promptSeverityFloor stays 'info' regardless of run blockingThreshold", () => {
  let capturedStrategiesByCall: Array<Array<CapturedStrategy>> = [];
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
    _rollbackDeps.spawn = makeSpawn(() => "abc1234\n").spawn;
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      // A passing adversarial with one warning advisory → seeded into nbf.
      // The test pins the floor on the WAY IN to the autofix-implementer's
      // prompt, which is where the load-bearing floor happens.
      if (op.name === "adversarial-review") {
        return {
          success: true,
          passed: true,
          advisoryFindings: [
            {
              source: "adversarial-review",
              severity: "warning",
              category: "input",
              message: "warning advisory",
              fixTarget: "source",
            },
          ],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: RunFixCycleCycle) => {
      capturedStrategiesByCall.push(cycle.strategies);
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

  test("AC11: review.blockingThreshold='error' + warning advisory → autofix-implementer still uses promptSeverityFloor='info'", async () => {
    const story = makeStory({ attempts: 1 });
    const config = withTriageNbf("error");
    runtime = makeTestRuntime({ config });
    const ctx = makeMockCallContext({ runtime });
    assertDefined(config.review.adversarial, "config.review.adversarial");
    const inputs = makeTddRetryInputs(story, {
      adversarialReview: {
        story,
        workdir: "/tmp/test",
        adversarialConfig: config.review.adversarial,
        mode: config.review.adversarial.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();

    const nbfSet = capturedStrategiesByCall[capturedStrategiesByCall.length - 1] ?? [];
    expect(nbfSet.length).toBeGreaterThan(0);
    const implementer = nbfSet.find((s) => s.name === "autofix-implementer");
    assertDefined(implementer, "autofix-implementer");

    // Drive a warning advisory through the strategy's `buildInput` and assert
    // (a) the floor reached the op input as `info` (NOT the run threshold `error`),
    // AND (b) the warning finding is preserved in the rectifier input — the
    // AC11 contract is "render the warning finding into rectifier input", not
    // just "set the threshold". A regression that drops `findings` while
    // keeping the threshold would still pass under the old assertion.
    const advisory: Finding = {
      source: "adversarial-review",
      severity: "warning",
      category: "input",
      message: "warning advisory",
      fixTarget: "source",
    };
    const input = implementer.buildInput([advisory], [], makeFixCycleContext());
    expect(input.blockingThreshold).toBe("info");
    expect(input.findings).toEqual([advisory]);
  });

  test("AC11: review.blockingThreshold='warning' + warning advisory → autofix-implementer still uses promptSeverityFloor='info'", async () => {
    // The stricter mode: even when the run's blocking threshold is "warning"
    // (so warning advisories are filtered out of the BLOCKING bucket but the
    // strategy set is still pinning the floor to "info" so they RENDER), the
    // nbf strategy set must keep the "info" floor for the prompt builder.
    const story = makeStory({ attempts: 1 });
    const config = withTriageNbf("warning");
    runtime = makeTestRuntime({ config });
    const ctx = makeMockCallContext({ runtime });
    assertDefined(config.review.adversarial, "config.review.adversarial");
    const inputs = makeTddRetryInputs(story, {
      adversarialReview: {
        story,
        workdir: "/tmp/test",
        adversarialConfig: config.review.adversarial,
        mode: config.review.adversarial.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();

    const nbfSet = capturedStrategiesByCall[capturedStrategiesByCall.length - 1] ?? [];
    expect(nbfSet.length).toBeGreaterThan(0);
    const implementer = nbfSet.find((s) => s.name === "autofix-implementer");
    assertDefined(implementer, "autofix-implementer");

    const advisory: Finding = {
      source: "adversarial-review",
      severity: "warning",
      category: "input",
      message: "warning advisory",
      fixTarget: "source",
    };
    const input = implementer.buildInput([advisory], [], makeFixCycleContext());
    expect(input.blockingThreshold).toBe("info");
    // AC11 contract: the warning finding renders into the rectifier input.
    // The run threshold is `warning`, so without the "info" floor the
    // prompt builder would filter the warning finding out by severity.
    // Asserting on `findings` is what pins that contract — a regression
    // that drops `findings` while keeping the threshold would otherwise
    // pass under the threshold-only assertion.
    expect(input.findings).toEqual([advisory]);
  });
});

describe("nbf-seed strategy set — AC12: semantic-review source with fixTarget='source' is claimed by autofix-implementer", () => {
  // The strategy predicate table. The autofix-implementer's `appliesTo` lets
  // `lint`, `typecheck`, `semantic-review`, and `tdd-verifier` through
  // unconditionally when `fixTarget === "source"` (or `fixTarget === null`).
  // The `adversarialReviewByFixTarget: "source"` switch only narrows the
  // adversarial bucket, so a semantic-review source finding should ALWAYS be
  // claimed — not gated by that switch. This test pins that behavior so a
  // future refactor that conflates the two doesn't silently strand
  // source-targeted semantic advisories.
  let capturedStrategiesByCall: Array<Array<CapturedStrategy>> = [];
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
    _rollbackDeps.spawn = makeSpawn(() => "abc1234\n").spawn;
    // Surface an advisory so the nbf cycle runs and the strategy set gets
    // captured. AC12 is about appliesTo predicate wiring, not the
    // actionability filter — a single warning advisory passes the gate.
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "adversarial-review") {
        return {
          success: true,
          passed: true,
          advisoryFindings: [
            {
              source: "adversarial-review",
              severity: "warning",
              category: "input",
              message: "warning advisory",
              fixTarget: "source",
            },
          ],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: RunFixCycleCycle) => {
      capturedStrategiesByCall.push(cycle.strategies);
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

  test("AC12: triage scope + semantic-review finding with fixTarget='source' → autofix-implementer.appliesTo === true", async () => {
    const story = makeStory({ attempts: 1 });
    const config = withTriageNbf("error");
    runtime = makeTestRuntime({ config });
    const ctx = makeMockCallContext({ runtime });
    assertDefined(config.review.adversarial, "config.review.adversarial");
    const inputs = makeTddRetryInputs(story, {
      adversarialReview: {
        story,
        workdir: "/tmp/test",
        adversarialConfig: config.review.adversarial,
        mode: config.review.adversarial.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();

    const nbfSet = capturedStrategiesByCall[capturedStrategiesByCall.length - 1] ?? [];
    const implementer = nbfSet.find((s) => s.name === "autofix-implementer");
    assertDefined(implementer, "autofix-implementer");

    // Source-targeted semantic-review finding. In the triage scope the
    // `adversarialReviewByFixTarget: "source"` switch narrows the ADVERSARIAL
    // bucket; the semantic-review source is in `IMPLEMENTER_SOURCES` and is
    // claimed by the implementer whenever `fixTarget === "source"` or null.
    const semanticSourceFinding: Finding = {
      source: "semantic-review",
      severity: "info",
      category: "input",
      message: "source-targeted semantic finding",
      fixTarget: "source",
    };
    expect(implementer.appliesTo(semanticSourceFinding)).toBe(true);

    // The test-writer MUST NOT claim it — autofix-test-writer only owns test
    // edits, and this finding is fixTarget="source".
    const testWriter = nbfSet.find((s) => s.name === "autofix-test-writer");
    if (testWriter) {
      expect(testWriter.appliesTo(semanticSourceFinding)).toBe(false);
    }
  });
});

// `_deps` use-only (no `await`): the strict TS check that `FixStrategy` is
// still imported (the type alias above). Without this the build would drop
// the import for tree-shaking.
const _fixStrategyTakesSourceFinding: FixStrategy<Finding, unknown, unknown, unknown> | undefined = undefined;
void _fixStrategyTakesSourceFinding;
