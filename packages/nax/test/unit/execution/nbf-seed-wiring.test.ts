// test/unit/execution/nbf-seed-wiring.test.ts
//
// US-002 — Story-orchestrator wiring for the seed-derivation extraction.
//
// These tests drive the canonical plan-build path through `buildPlanForStrategy`
// and assert that `runNonBlockingFix` is invoked (or NOT invoked) based on the
// `sources` list declared by `review.nonBlockingFix.sources`. They cover:
//   - AC9: passing semantic-review with one actionable advisory, both sources → runNonBlockingFix invoked once with the semantic finding.
//   - AC10: same with `sources=[adversarial]` only → runNonBlockingFix NOT invoked.
//   - AC13: review checks include `semantic` but not `adversarial`, both review phases pass with actionable advisories, `sources=[semantic]` → runNonBlockingFix invoked once.
//   - AC14: same with `sources=[adversarial]` only → runNonBlockingFix NOT invoked (pass is gated by `sources`, not by which slots the config declares).
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
import type { NonBlockingFixArgs } from "@/execution/non-blocking-fix";
import type { Finding } from "@/findings";
import type { UserStory } from "@/prd/types";
import type { NaxRuntime } from "@/runtime";
import { _rollbackDeps } from "@/tdd";

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

/** Capture the `advisoryFindings` argument passed into `runNonBlockingFix`. */
function hasAdvisoryFindings(value: unknown): value is NonBlockingFixArgs {
  return typeof value === "object" && value !== null && "advisoryFindings" in value;
}

function capturedAdvisories(runNonBlockingFix: ReturnType<typeof mock>): readonly Finding[] {
  const call = runNonBlockingFix.mock.calls[0];
  if (!call) throw new Error("runNonBlockingFix was not invoked");
  const args = call[0];
  if (!hasAdvisoryFindings(args)) throw new Error("runNonBlockingFix call did not include advisory findings");
  return args.advisoryFindings;
}

/** Build a config with the requested `sources` and `checks` for the reviewer slots. */
function withNbfSources(
  sources: readonly ("adversarial" | "semantic")[],
  checks: readonly ("semantic" | "adversarial")[],
): ReturnType<typeof makeNaxConfig> {
  return makeNaxConfig({
    quality: { commands: {}, autofix: { enabled: true } },
    execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    review: {
      checks: ["typecheck", "lint", "test", ...checks],
      nonBlockingFix: {
        enabled: true,
        scope: "triage",
        regressionAttempts: 1,
        verifierGuard: true,
        sourceDiffCap: { maxFiles: 10, maxLines: 500 },
        sources: [...sources],
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

describe("nbf-seed wiring — AC9/AC10: semantic-only sources drive runNonBlockingFix", () => {
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
    _rollbackDeps.autoCommitIfDirty = mock(async () => {});
    _rollbackDeps.spawn = makeSpawn(() => "abc1234\n").spawn;
    // Outer rectification is not the path under test: the strategy is a stub
    // that exits "no-strategy" so the orchestrator's main loop runs to the
    // post-rectification nbf gate.
    _storyOrchestratorDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "no-strategy" as const,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;
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

  test("AC9: passing semantic + passing adversarial + sources=[adversarial, semantic] → runNonBlockingFix invoked once with the semantic finding", async () => {
    // The review fixture: semantic passes with one actionable advisory,
    // adversarial passes with no advisories. With `sources=[adversarial,
    // semantic]` and the green precondition holding (every review passed,
    // every prior gate passed), nbf MUST be invoked once — and it MUST be
    // invoked with the semantic finding, not nothing.
    const runNonBlockingFix = mock(async (_args: NonBlockingFixArgs) => ({
      ran: true,
      kept: true,
      restored: false,
    }));
    _storyOrchestratorDeps.runNonBlockingFix = runNonBlockingFix as typeof _storyOrchestratorDeps.runNonBlockingFix;

    _storyOrchestratorDeps.callOp = mock(async (_ctx, op) => {
      if (op.name === "semantic-review") {
        return {
          success: true,
          passed: true,
          advisoryFindings: [
            {
              source: "semantic-review",
              severity: "warning",
              category: "input",
              message: "semantic advisory",
            },
          ],
        };
      }
      if (op.name === "adversarial-review") {
        return { success: true, passed: true, advisoryFindings: [] };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const config = withNbfSources(["adversarial", "semantic"], ["semantic", "adversarial"]);
    const story = makeStory({ attempts: 1 });
    runtime = makeTestRuntime({ config });
    const ctx = makeMockCallContext({ runtime });
    assertDefined(config.review.adversarial, "config.review.adversarial");
    assertDefined(config.review.semantic, "config.review.semantic");
    const inputs = makeTddRetryInputs(story, {
      semanticReview: {
        story,
        workdir: "/tmp/test",
        semanticConfig: config.review.semantic,
        mode: config.review.semantic.diffMode,
      },
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

    expect(runNonBlockingFix).toHaveBeenCalledTimes(1);
    const advisories = capturedAdvisories(runNonBlockingFix);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.source).toBe("semantic-review");
    expect(advisories[0]?.message).toBe("semantic advisory");
  });

  test("AC10: same scenario but sources=[adversarial] only → runNonBlockingFix NOT invoked", () => {
    // The seed derivation drops the semantic advisory bucket when `sources`
    // excludes `semantic`. The pass is gated by `sources`, not by which
    // reviewer slots the config declares — so even with both reviewers
    // passing and a real semantic advisory on the line, `sources=[adversarial]`
    // closes nbf.
    const runNonBlockingFix = mock(async (_args: NonBlockingFixArgs) => ({
      ran: true,
      kept: true,
      restored: false,
    }));
    _storyOrchestratorDeps.runNonBlockingFix = runNonBlockingFix as typeof _storyOrchestratorDeps.runNonBlockingFix;

    _storyOrchestratorDeps.callOp = mock(async (_ctx, op) => {
      if (op.name === "semantic-review") {
        return {
          success: true,
          passed: true,
          advisoryFindings: [
            {
              source: "semantic-review",
              severity: "warning",
              category: "input",
              message: "semantic advisory",
            },
          ],
        };
      }
      if (op.name === "adversarial-review") {
        return { success: true, passed: true, advisoryFindings: [] };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const config = withNbfSources(["adversarial"], ["semantic", "adversarial"]);
    const story = makeStory({ attempts: 1 });
    runtime = makeTestRuntime({ config });
    const ctx = makeMockCallContext({ runtime });
    assertDefined(config.review.adversarial, "config.review.adversarial");
    assertDefined(config.review.semantic, "config.review.semantic");
    const inputs = makeTddRetryInputs(story, {
      semanticReview: {
        story,
        workdir: "/tmp/test",
        semanticConfig: config.review.semantic,
        mode: config.review.semantic.diffMode,
      },
      adversarialReview: {
        story,
        workdir: "/tmp/test",
        adversarialConfig: config.review.adversarial,
        mode: config.review.adversarial.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });

    return (async () => {
      const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
      await plan.run();
      expect(runNonBlockingFix).not.toHaveBeenCalled();
    })();
  });
});

describe("nbf-seed wiring — AC13/AC14: semantic-only reviewer checks drive runNonBlockingFix via sources=[semantic]", () => {
  // The reviewer-slot gating test for the extraction. AC13/AC14 explicitly
  // distinguish "config declares a `semantic` check" from "config names
  // `semantic` in `sources`": only the latter must drive nbf. A wiring
  // regression that read reviewer-slot presence instead of `sources` would
  // open nbf for a semantic-only plan whose `sources` was `[adversarial]`,
  // and that is exactly the false-positive the AC is meant to catch.

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
    _rollbackDeps.autoCommitIfDirty = mock(async () => {});
    _rollbackDeps.spawn = makeSpawn(() => "abc1234\n").spawn;
    _storyOrchestratorDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "no-strategy" as const,
      costUsd: 0,
    })) as typeof _storyOrchestratorDeps.runFixCycle;
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

  test("AC13: checks=[semantic] (no adversarial) + sources=[semantic] → runNonBlockingFix invoked once with the semantic finding", async () => {
    const runNonBlockingFix = mock(async (_args: NonBlockingFixArgs) => ({
      ran: true,
      kept: true,
      restored: false,
    }));
    _storyOrchestratorDeps.runNonBlockingFix = runNonBlockingFix as typeof _storyOrchestratorDeps.runNonBlockingFix;

    _storyOrchestratorDeps.callOp = mock(async (_ctx, op) => {
      if (op.name === "semantic-review") {
        return {
          success: true,
          passed: true,
          advisoryFindings: [
            {
              source: "semantic-review",
              severity: "warning",
              category: "input",
              message: "semantic advisory",
            },
          ],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const config = withNbfSources(["semantic"], ["semantic"]);
    const story = makeStory({ attempts: 1 });
    runtime = makeTestRuntime({ config });
    const ctx = makeMockCallContext({ runtime });
    assertDefined(config.review.semantic, "config.review.semantic");
    const inputs = makeTddRetryInputs(story, {
      semanticReview: {
        story,
        workdir: "/tmp/test",
        semanticConfig: config.review.semantic,
        mode: config.review.semantic.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });

    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();

    expect(runNonBlockingFix).toHaveBeenCalledTimes(1);
    const advisories = capturedAdvisories(runNonBlockingFix);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.source).toBe("semantic-review");
  });

  test("AC14: same semantic-only checks + sources=[adversarial] → runNonBlockingFix NOT invoked", async () => {
    const runNonBlockingFix = mock(async (_args: NonBlockingFixArgs) => ({
      ran: true,
      kept: true,
      restored: false,
    }));
    _storyOrchestratorDeps.runNonBlockingFix = runNonBlockingFix as typeof _storyOrchestratorDeps.runNonBlockingFix;

    _storyOrchestratorDeps.callOp = mock(async (_ctx, op) => {
      if (op.name === "semantic-review") {
        return {
          success: true,
          passed: true,
          advisoryFindings: [
            {
              source: "semantic-review",
              severity: "warning",
              category: "input",
              message: "semantic advisory",
            },
          ],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const config = withNbfSources(["adversarial"], ["semantic"]);
    const story = makeStory({ attempts: 1 });
    runtime = makeTestRuntime({ config });
    const ctx = makeMockCallContext({ runtime });
    assertDefined(config.review.semantic, "config.review.semantic");
    const inputs = makeTddRetryInputs(story, {
      semanticReview: {
        story,
        workdir: "/tmp/test",
        semanticConfig: config.review.semantic,
        mode: config.review.semantic.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });

    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();

    expect(runNonBlockingFix).not.toHaveBeenCalled();
  });
});
