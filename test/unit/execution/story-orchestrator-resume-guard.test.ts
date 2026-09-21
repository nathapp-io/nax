/**
 * Story-Orchestrator Resume-Guard Tests
 *
 * Covers the new behaviour introduced by the story
 * "Resume guard and RectificationResult: wire validate-short-circuit to liteScopeIncomplete":
 *
 * AC1: EXHAUSTED_EXIT_REASONS contains "validate-short-circuit"
 * AC2: RectificationResult has liteScopeIncomplete?: boolean (verified via AC3/AC4)
 * AC3: validate-short-circuit + empty findings  → { liteScopeIncomplete: true }
 * AC4: validate-short-circuit + non-empty findings → { rectificationExhausted: true, unfixedFindings }
 * AC5: rectResult { rectificationExhausted: true } → resume block NOT entered
 * AC6: rectResult { liteScopeIncomplete: true }   → resume block IS entered
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  assertDefined,
  makeAdversarialReviewConfig,
  makeCallOp,
  makeFixCycleResult,
  makeMockAgentManager,
  makeNaxConfig,
  makeSemanticReviewConfig,
  makeStory,
  makeTestRuntime,
  makeTurnResult,
} from "@test/helpers";
import { pickSelector } from "@/config";
import { _storyOrchestratorDeps, EXHAUSTED_EXIT_REASONS, StoryOrchestratorBuilder } from "@/execution";
import type { Finding } from "@/findings";
import type { CallContext, DeterministicOperation, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";

// ============================================================================
// Shared helpers
// ============================================================================

const testSel = pickSelector("test-resume-guard-selector", "execution");

/** The op fixtures' config slice, derived from the selector so the two cannot drift. */
type TestOpConfig = ReturnType<(typeof testSel)["select"]>;

const mockImplementerOp: RunOperation<{ code: string }, { success: boolean }, TestOpConfig> = {
  kind: "run",
  name: "mock-implementer",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "warm" },
  build: (input) => ({
    role: { id: "r1", content: "Implement", overridable: false },
    task: { id: "t1", content: input.code, overridable: false },
  }),
  parse: (output) => {
    try {
      return JSON.parse(output);
    } catch {
      return { success: false };
    }
  },
};

function makeDeterministicOp(
  name: string,
  result: { success: boolean; findings?: unknown[] },
): DeterministicOperation<unknown, unknown, TestOpConfig> {
  return {
    kind: "deterministic",
    name,
    stage: "verify",
    config: testSel,
    execute: async () => ({ ...result, estimatedCostUsd: 0 }),
  };
}

const GATE_FINDING: Finding = {
  source: "test-runner",
  category: "failed-test",
  severity: "error",
  message: "suite failed",
  rule: "test",
  file: "test/foo.test.ts",
};

let runtime: NaxRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

// ============================================================================
// AC1: EXHAUSTED_EXIT_REASONS contains "validate-short-circuit"
// ============================================================================

describe("AC1: EXHAUSTED_EXIT_REASONS", () => {
  test('AC1: contains "validate-short-circuit"', () => {
    // Fails until "validate-short-circuit" is added to the set.
    expect(EXHAUSTED_EXIT_REASONS.has("validate-short-circuit")).toBe(true);
  });

  test('AC1 boundary: "resolved" is NOT in EXHAUSTED_EXIT_REASONS (sanity)', () => {
    expect(EXHAUSTED_EXIT_REASONS.has("resolved")).toBe(false);
  });
});

// ============================================================================
// AC3 & AC4: runRectification exit logic for validate-short-circuit
// Tested via ExecutionPlan.run with mocked runFixCycle.
// ============================================================================

describe("AC3: validate-short-circuit + empty findings → liteScopeIncomplete", () => {
  test("AC3: returns liteScopeIncomplete: true when exitReason=validate-short-circuit and finalFindings.length=0", async () => {
    const config = makeNaxConfig();
    const agentManager = makeMockAgentManager({
      runWithFallbackTransportFn: async (_req, onSuccess) =>
        onSuccess(
          makeTurnResult({
            output: JSON.stringify({ success: true }),
            tokenUsage: { inputTokens: 10, outputTokens: 5 },
            estimatedCostUsd: 0.001,
          }),
        ),
    });
    runtime = makeTestRuntime({ config, agentManager });

    // Gate fails with source-tagged finding → initialFindings non-empty → runFixCycle called.
    const gateOp = makeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [GATE_FINDING],
    });

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = makeCallOp();
    // Simulate cycle exiting with validate-short-circuit + no remaining findings.
    _storyOrchestratorDeps.runFixCycle = async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "validate-short-circuit" as const,
      costUsd: 0,
    });

    try {
      assertDefined(runtime, "runtime");
      const ctx: CallContext = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-ac3",
      };

      const result = await new StoryOrchestratorBuilder()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: makeStory({ id: "US-ac3" }), workdir: "/tmp" } })
        .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
        .build(ctx)
        .run();

      // AC3: liteScopeIncomplete must be true; rectificationExhausted must be absent.
      expect(result.liteScopeIncomplete).toBe(true);
      expect(result.rectificationExhausted).toBeUndefined();
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });
});

describe("AC4: validate-short-circuit + non-empty findings → rectificationExhausted", () => {
  test("AC4: returns rectificationExhausted: true when exitReason=validate-short-circuit and finalFindings.length>0", async () => {
    const config = makeNaxConfig();
    runtime = makeTestRuntime({ config });

    const gateOp = makeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [GATE_FINDING],
    });

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = makeCallOp();
    // Simulate cycle exiting with validate-short-circuit but still has unfixed findings.
    const unfixed: Finding[] = [GATE_FINDING];
    _storyOrchestratorDeps.runFixCycle = async <F extends Finding>() =>
      makeFixCycleResult<F>({
        iterations: [],
        finalFindings: unfixed,
        exitReason: "validate-short-circuit" as const,
        costUsd: 0,
      });

    try {
      assertDefined(runtime, "runtime");
      const ctx: CallContext = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-ac4",
      };

      const result = await new StoryOrchestratorBuilder()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: makeStory({ id: "US-ac4" }), workdir: "/tmp" } })
        .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
        .build(ctx)
        .run();

      // AC4: rectificationExhausted=true; unfixedFindings contains the same finding; liteScopeIncomplete absent.
      expect(result.rectificationExhausted).toBe(true);
      expect(result.unfixedFindings).toEqual(unfixed);
      expect(result.liteScopeIncomplete).toBeUndefined();
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });
});

// ============================================================================
// AC5: rectificationExhausted: true → resume block NOT entered
// ============================================================================

describe("AC5: rectificationExhausted: true → resume NOT entered", () => {
  test("AC5: verifier not dispatched when rectResult.rectificationExhausted=true (validate-short-circuit + non-empty findings)", async () => {
    const config = makeNaxConfig();
    runtime = makeTestRuntime({ config });

    const opRunCount: Record<string, number> = {};
    const gateOp = makeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [GATE_FINDING],
    });
    const verOp = makeDeterministicOp("verifier", { success: true });

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = makeCallOp({
      onDispatch: (op) => {
        opRunCount[op.name] = (opRunCount[op.name] ?? 0) + 1;
      },
    });
    // validate-short-circuit + non-empty → runRectification should return rectificationExhausted: true
    _storyOrchestratorDeps.runFixCycle = async <F extends Finding>() =>
      makeFixCycleResult<F>({
        iterations: [],
        finalFindings: [GATE_FINDING],
        exitReason: "validate-short-circuit" as const,
        costUsd: 0,
      });

    try {
      assertDefined(runtime, "runtime");
      const ctx: CallContext = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-ac5",
      };

      await new StoryOrchestratorBuilder()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: makeStory({ id: "US-ac5" }), workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
        .build(ctx)
        .run();

      // AC5: verifier was never dispatched — resume block skipped because rectificationExhausted=true.
      // Verifier is absent from phaseOutputs (main loop short-circuited at gate, resume NOT entered).
      // With current code, runRectification returns {} (not rectificationExhausted: true) → resume ENTERS → verifier RUNS → test FAILS.
      expect(opRunCount.verifier ?? 0).toBe(0);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });
});

// ============================================================================
// AC6: liteScopeIncomplete: true → resume block IS entered
// ============================================================================

describe("AC6: liteScopeIncomplete: true → resume IS entered", () => {
  test("AC6: verifier dispatched in resume block when rectResult.liteScopeIncomplete=true (validate-short-circuit + empty findings)", async () => {
    const config = makeNaxConfig();
    runtime = makeTestRuntime({ config });

    const opRunCount: Record<string, number> = {};
    const gateOp = makeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [GATE_FINDING],
    });
    // Verifier will pass when resume runs it.
    const verOp = makeDeterministicOp("verifier", { success: true });

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = makeCallOp({
      onDispatch: (op) => {
        opRunCount[op.name] = (opRunCount[op.name] ?? 0) + 1;
      },
    });
    // Gate passes after rectification (so resume continues past it) — the
    // deterministic execute carries the count-based override instead of the mock.
    const gateExecute = gateOp.execute;
    let gateRuns = 0;
    gateOp.execute = async (input, ctx) => {
      gateRuns++;
      if (gateRuns > 1) return { success: true, findings: [], estimatedCostUsd: 0 };
      return gateExecute(input, ctx);
    };
    // validate-short-circuit + empty → runRectification should return liteScopeIncomplete: true
    _storyOrchestratorDeps.runFixCycle = async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "validate-short-circuit" as const,
      costUsd: 0,
    });

    try {
      assertDefined(runtime, "runtime");
      const ctx: CallContext = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-ac6",
      };

      const result = await new StoryOrchestratorBuilder()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: makeStory({ id: "US-ac6" }), workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
        .build(ctx)
        .run();

      // AC6: resume block IS entered → verifier is dispatched (it was absent from phaseOutputs).
      // With current code, runRectification returns {} → liteScopeIncomplete is undefined → test FAILS on that.
      expect(result.liteScopeIncomplete).toBe(true);
      // Resume IS entered → verifier ran.
      expect(opRunCount.verifier ?? 0).toBeGreaterThan(0);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });
});

// ============================================================================
// AC7: rectificationExhausted=true + mechanical-only unfixedFindings → resume IS entered
// ============================================================================

describe("AC7: mechanical-only rectificationExhausted → resume IS entered for review phases", () => {
  test("AC7: verifier dispatched in resume block when rectificationExhausted=true and unfixedFindings are all lint/typecheck", async () => {
    // Reproduces the E501 scenario: lint-check fails, ruff --fix can't fix it,
    // rectification exhausts with lint-only findings. semantic/adversarial reviews
    // should still run — skipping them means the story passes without LLM review.
    const config = makeNaxConfig();
    runtime = makeTestRuntime({ config });

    const LINT_FINDING: Finding = {
      source: "lint",
      category: "style",
      severity: "error",
      message: "E501 Line too long",
      rule: "E501",
      file: "tests/unit/test_foo.py",
    };

    const opRunCount: Record<string, number> = {};
    const gateOp = makeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [LINT_FINDING],
    });
    const verOp = makeDeterministicOp("verifier", { success: true });

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = makeCallOp({
      onDispatch: (op) => {
        opRunCount[op.name] = (opRunCount[op.name] ?? 0) + 1;
      },
    });
    // rectificationExhausted=true with mechanical-only unfixedFindings
    _storyOrchestratorDeps.runFixCycle = async <F extends Finding>() =>
      makeFixCycleResult<F>({
        iterations: [
          {
            iterationNum: 1,
            findingsBefore: [LINT_FINDING],
            fixesApplied: [
              { strategyName: "mechanical-lintfix", op: "mechanical-lintfix", targetFiles: [], summary: "" },
            ],
            findingsAfter: [LINT_FINDING],
            outcome: "unchanged" as const,
            startedAt: "",
            finishedAt: "",
          },
        ],
        finalFindings: [LINT_FINDING],
        exitReason: "validate-short-circuit" as const,
        costUsd: 0,
      });

    try {
      assertDefined(runtime, "runtime");
      const ctx: CallContext = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-ac7",
      };

      const semOp = makeDeterministicOp("semantic-review", { success: true });
      const advOp = makeDeterministicOp("adversarial-review", { success: true });

      await new StoryOrchestratorBuilder()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: makeStory({ id: "US-ac7" }), workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addSemanticReview({
          op: semOp,
          input: {
            workdir: "/tmp",
            story: makeStory({ id: "US-ac7" }),
            semanticConfig: makeSemanticReviewConfig(),
            mode: "ref",
          },
        })
        .addAdversarialReview({
          op: advOp,
          input: {
            workdir: "/tmp",
            story: makeStory({ id: "US-ac7" }),
            adversarialConfig: makeAdversarialReviewConfig(),
            mode: "ref",
          },
        })
        .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
        .build(ctx)
        .run();

      // AC7: resume block IS entered because unfixedFindings are all lint.
      // Verifier and reviews run even though the lint gate stays failing.
      expect(opRunCount.verifier ?? 0).toBeGreaterThan(0);
      expect(opRunCount["semantic-review"] ?? 0).toBeGreaterThan(0);
      expect(opRunCount["adversarial-review"] ?? 0).toBeGreaterThan(0);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });

  test("AC7b: resume NOT entered when rectificationExhausted=true with non-mechanical unfixedFindings (AC5 unchanged)", async () => {
    // Existing AC5 contract: test-runner findings are not mechanical → no resume.
    const config = makeNaxConfig();
    runtime = makeTestRuntime({ config });

    const opRunCount: Record<string, number> = {};
    const gateOp = makeDeterministicOp("full-suite-gate", { success: false, findings: [GATE_FINDING] });
    const verOp = makeDeterministicOp("verifier", { success: true });

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = makeCallOp({
      onDispatch: (op) => {
        opRunCount[op.name] = (opRunCount[op.name] ?? 0) + 1;
      },
    });
    _storyOrchestratorDeps.runFixCycle = async <F extends Finding>() =>
      makeFixCycleResult<F>({
        iterations: [],
        finalFindings: [GATE_FINDING],
        exitReason: "validate-short-circuit" as const,
        costUsd: 0,
      });

    try {
      assertDefined(runtime, "runtime");
      const ctx: CallContext = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-ac7b",
      };

      await new StoryOrchestratorBuilder()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: makeStory({ id: "US-ac7b" }), workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
        .build(ctx)
        .run();

      expect(opRunCount.verifier ?? 0).toBe(0);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });
});

// ===========================================================================
// Review-Continuation (#1666 Parts A & B) (absorbed from
// story-orchestrator-review-continuation.test.ts)
// ===========================================================================

const rcTestSel = pickSelector("test-review-continuation-selector", "execution");
type rcTestOpConfig = ReturnType<(typeof rcTestSel)["select"]>;

const rcMockImplementerOp: RunOperation<{ code: string }, { success: boolean }, rcTestOpConfig> = {
  kind: "run",
  name: "mock-implementer",
  stage: "run",
  config: rcTestSel,
  session: { role: "implementer", lifetime: "warm" },
  build: (input) => ({
    role: { id: "r1", content: "Implement", overridable: false },
    task: { id: "t1", content: input.code, overridable: false },
  }),
  parse: (output) => {
    try {
      return JSON.parse(output);
    } catch {
      return { success: false };
    }
  },
};

function rcMakeDeterministicOp(
  name: string,
  result: { success: boolean; findings?: unknown[] },
): DeterministicOperation<unknown, unknown, rcTestOpConfig> {
  return {
    kind: "deterministic",
    name,
    stage: "verify",
    config: rcTestSel,
    execute: async () => ({ ...result, estimatedCostUsd: 0 }),
  };
}

let rcRuntime: NaxRuntime | undefined;
const origCallOp = _storyOrchestratorDeps.callOp;
afterEach(async () => {
  _storyOrchestratorDeps.callOp = origCallOp;
  await rcRuntime?.close();
  rcRuntime = undefined;
});

function buildCtx(rt: NaxRuntime, storyId: string): CallContext {
  return {
    runtime: rt,
    packageView: rt.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId,
  };
}

describe("Part B (#1666): semantic-review failure continues to adversarial-review", () => {
  test("adversarial-review DOES run after semantic-review fails, and the story still fails", async () => {
    rcRuntime = makeTestRuntime({ config: makeNaxConfig() });
    const opRunCount: Record<string, number> = {};
    _storyOrchestratorDeps.callOp = makeCallOp({
      onDispatch: (op) => {
        opRunCount[op.name] = (opRunCount[op.name] ?? 0) + 1;
      },
    });

    const semOp = rcMakeDeterministicOp("semantic-review", { success: false, findings: [] });
    const advOp = rcMakeDeterministicOp("adversarial-review", { success: true, findings: [] });
    const story = makeStory({ id: "US-b1" });

    const result = await new StoryOrchestratorBuilder()
      .addImplementer({ op: rcMockImplementerOp, input: { code: "" } })
      .addSemanticReview({
        op: semOp,
        input: { workdir: "/tmp", story, semanticConfig: makeSemanticReviewConfig(), mode: "ref" },
      })
      .addAdversarialReview({
        op: advOp,
        input: { workdir: "/tmp", story, adversarialConfig: makeAdversarialReviewConfig(), mode: "ref" },
      })
      .build(buildCtx(rcRuntime, "US-b1"))
      .run();

    // adversarial-review must run even though semantic-review failed.
    expect(opRunCount["adversarial-review"] ?? 0).toBeGreaterThan(0);
    // Both outputs land in phaseOutputs (rectification still needs both sets of findings).
    expect(result.phaseOutputs["semantic-review"]).toBeDefined();
    expect(result.phaseOutputs["adversarial-review"]).toBeDefined();
    // The story still fails on semantic-review's own finding — Part B changes
    // what runs, not the verdict.
    expect(result.success).toBe(false);
    // Both configured reviews ran, so there is nothing missing to report.
    expect(result.missingRequiredReviewPhases).toBeUndefined();
  });

  test("semantic-review's failure is not silently upgraded to a pass by continuing", async () => {
    rcRuntime = makeTestRuntime({ config: makeNaxConfig() });
    _storyOrchestratorDeps.callOp = makeCallOp();

    const semOp = rcMakeDeterministicOp("semantic-review", { success: false, findings: [] });
    const advOp = rcMakeDeterministicOp("adversarial-review", { success: true, findings: [] });
    const story = makeStory({ id: "US-b2" });

    const result = await new StoryOrchestratorBuilder()
      .addImplementer({ op: rcMockImplementerOp, input: { code: "" } })
      .addSemanticReview({
        op: semOp,
        input: { workdir: "/tmp", story, semanticConfig: makeSemanticReviewConfig(), mode: "ref" },
      })
      .addAdversarialReview({
        op: advOp,
        input: { workdir: "/tmp", story, adversarialConfig: makeAdversarialReviewConfig(), mode: "ref" },
      })
      .build(buildCtx(rcRuntime, "US-b2"))
      .run();

    const semanticOutput = result.phaseOutputs["semantic-review"] as { success?: boolean };
    expect(semanticOutput.success).toBe(false);
    expect(result.success).toBe(false);
  });
});

describe("Part A (#1666): every OTHER phase still halts the loop unconditionally", () => {
  test("full-suite-gate failure still short-circuits before reaching reviews (no rectification configured)", async () => {
    rcRuntime = makeTestRuntime({ config: makeNaxConfig() });
    const opRunCount: Record<string, number> = {};
    _storyOrchestratorDeps.callOp = makeCallOp({
      onDispatch: (op) => {
        opRunCount[op.name] = (opRunCount[op.name] ?? 0) + 1;
      },
    });

    const gateOp = rcMakeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [
        { source: "test-runner", category: "failed-test", severity: "error", message: "f", rule: "r", file: "f.ts" },
      ],
    });
    const semOp = rcMakeDeterministicOp("semantic-review", { success: true, findings: [] });
    const advOp = rcMakeDeterministicOp("adversarial-review", { success: true, findings: [] });
    const story = makeStory({ id: "US-a1" });

    const result = await new StoryOrchestratorBuilder()
      .addImplementer({ op: rcMockImplementerOp, input: { code: "" } })
      .addFullSuiteGate({ op: gateOp, input: { story, workdir: "/tmp" } })
      .addSemanticReview({
        op: semOp,
        input: { workdir: "/tmp", story, semanticConfig: makeSemanticReviewConfig(), mode: "ref" },
      })
      .addAdversarialReview({
        op: advOp,
        input: { workdir: "/tmp", story, adversarialConfig: makeAdversarialReviewConfig(), mode: "ref" },
      })
      .build(buildCtx(rcRuntime, "US-a1"))
      .run();

    // Neither review ran — the gate failure halts unconditionally, no exemption
    // was introduced for phases other than the semantic->adversarial transition.
    expect(opRunCount["semantic-review"] ?? 0).toBe(0);
    expect(opRunCount["adversarial-review"] ?? 0).toBe(0);
    expect(result.success).toBe(false);
    // Still reported so escalation fires (the field itself is unaffected by
    // Part A — only how the *reason* is surfaced changes).
    expect(result.missingRequiredReviewPhases).toEqual(["semantic-review", "adversarial-review"]);
  });

  test("verifier failure still short-circuits before reaching reviews", async () => {
    rcRuntime = makeTestRuntime({ config: makeNaxConfig() });
    const opRunCount: Record<string, number> = {};
    _storyOrchestratorDeps.callOp = makeCallOp({
      onDispatch: (op) => {
        opRunCount[op.name] = (opRunCount[op.name] ?? 0) + 1;
      },
    });

    const verOp = rcMakeDeterministicOp("verifier", { success: false });
    const semOp = rcMakeDeterministicOp("semantic-review", { success: true, findings: [] });
    const advOp = rcMakeDeterministicOp("adversarial-review", { success: true, findings: [] });
    const story = makeStory({ id: "US-a2" });

    const result = await new StoryOrchestratorBuilder()
      .addImplementer({ op: rcMockImplementerOp, input: { code: "" } })
      .addVerifier({ op: verOp, input: { code: "" } })
      .addSemanticReview({
        op: semOp,
        input: { workdir: "/tmp", story, semanticConfig: makeSemanticReviewConfig(), mode: "ref" },
      })
      .addAdversarialReview({
        op: advOp,
        input: { workdir: "/tmp", story, adversarialConfig: makeAdversarialReviewConfig(), mode: "ref" },
      })
      .build(buildCtx(rcRuntime, "US-a2"))
      .run();

    expect(opRunCount["semantic-review"] ?? 0).toBe(0);
    expect(opRunCount["adversarial-review"] ?? 0).toBe(0);
    expect(result.success).toBe(false);
  });
});
