/**
 * Verifier-SSOT carve-out staleness fix.
 *
 * The carve-out exempts the full-suite gate from the story verdict when the
 * verifier passed (treating gate failures as pre-existing/unrelated). But the
 * verifier judged the *pre-rectification* tree. When a review-fix run during
 * rectification introduces a NEW gate failure, the verdict is stale and must no
 * longer exempt the gate — otherwise the regression is silently laundered into
 * a pass and leaks to the deferred regression sweep.
 *
 * Covers:
 * - gateFailureKeys (pure): failing-test identity extraction
 * - deriveTddFailureCategory: stale verdict routes to `tests-failing`
 * - ExecutionPlan.run: verifier-pass + gate-regressed-during-rect → success=false
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import { StoryOrchestratorBuilder, _storyOrchestratorDeps, gateFailureKeys } from "@/execution";
import { deriveTddFailureCategory } from "@/execution";
import type { CallContext, DeterministicOperation, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { makeNaxConfig, makeTestRuntime } from "@test/helpers";

const testSel = pickSelector("carveout-staleness-selector", "execution");

const mockImplementerOp: RunOperation<{ code: string }, { success: boolean }, typeof DEFAULT_CONFIG> = {
  kind: "run",
  name: "mock-implementer",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "warm" },
  build: (input) => ({
    role: { id: "r1", content: "Implement", overridable: false },
    task: { id: "t1", content: input.code, overridable: false },
  }),
  parse: () => ({ success: true }),
};

function makeDeterministicOp(
  name: string,
  result: { success: boolean; findings?: unknown[] },
): DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG> {
  return {
    kind: "deterministic",
    name,
    stage: "verify",
    config: testSel,
    execute: async () => ({ ...result, estimatedCostUsd: 0, passed: result.success }),
  };
}

const testFinding = (file: string, rule: string) => ({
  source: "test-runner",
  category: "failed-test",
  severity: "error",
  message: "boom",
  rule,
  file,
});

// ─────────────────────────────────────────────────────────────────────────────
// gateFailureKeys — pure
// ─────────────────────────────────────────────────────────────────────────────

describe("gateFailureKeys", () => {
  test("returns empty set for a passing gate output", () => {
    expect(gateFailureKeys({ success: true, passed: true, findings: [] }).size).toBe(0);
  });

  test("extracts file::testName keys from failing-test findings", () => {
    const out = {
      success: false,
      passed: false,
      findings: [testFinding("foo.test.ts", "t-a"), testFinding("bar.test.ts", "t-b")],
    };
    expect([...gateFailureKeys(out)].sort()).toEqual(["bar.test.ts::t-b", "foo.test.ts::t-a"]);
  });

  test("ignores non-test-runner findings", () => {
    const out = {
      success: false,
      passed: false,
      findings: [
        testFinding("foo.test.ts", "t-a"),
        { source: "lint", category: "style", severity: "error", message: "x", rule: "r", file: "y.ts" },
      ],
    };
    expect([...gateFailureKeys(out)]).toEqual(["foo.test.ts::t-a"]);
  });

  test("returns empty set for undefined / non-object output", () => {
    expect(gateFailureKeys(undefined).size).toBe(0);
    expect(gateFailureKeys("nope").size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveTddFailureCategory — staleness param
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveTddFailureCategory — carve-out staleness", () => {
  const verifierPassed = { "mock-verifier": { success: true } } as Record<string, unknown>;
  const phaseOutputs = {
    verifier: { success: true },
    "full-suite-gate": { success: false, passed: false },
  } as Record<string, unknown>;

  test("verifier passed + gate failing + NOT regressed → undefined (carve-out preserved)", () => {
    expect(deriveTddFailureCategory(phaseOutputs, undefined, false)).toBeUndefined();
  });

  test("verifier passed + gate failing + regressed-during-rect → tests-failing (escalates)", () => {
    expect(deriveTddFailureCategory(phaseOutputs, undefined, true)).toBe("tests-failing");
  });

  // Guard against the verifierPassed-key name drift; the canonical verifier op
  // name is "verifier" in this fixture.
  test("default (no flag) preserves prior behaviour", () => {
    expect(deriveTddFailureCategory(phaseOutputs)).toBeUndefined();
    void verifierPassed;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ExecutionPlan.run — end-to-end
// ─────────────────────────────────────────────────────────────────────────────

describe("ExecutionPlan.run — carve-out staleness", () => {
  let rt: NaxRuntime | undefined;
  afterEach(async () => {
    await rt?.close();
  });

  function buildPlan(
    ctx: CallContext,
    gateOp: DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG>,
    reviewOp: DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG>,
  ) {
    return new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as never, workdir: "/tmp" } })
      .addVerifier({ op: makeDeterministicOp("verifier", { success: true }), input: {} })
      .addSemanticReview({ op: reviewOp, input: {} })
      .addRectification({ maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false })
      .build(ctx);
  }

  test("verifier passed but rectification introduced a new gate failure → story fails", async () => {
    const config = makeNaxConfig({
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2, abortOnIncreasingFailures: false } },
    });
    rt = makeTestRuntime({ config });

    // Gate: green on the main-loop run, red (new failing test) on every re-run.
    let gateCalls = 0;
    const gateOp: DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG> = {
      kind: "deterministic",
      name: "full-suite-gate",
      stage: "verify",
      config: testSel,
      execute: async () => {
        gateCalls++;
        const ok = gateCalls === 1;
        return {
          success: ok,
          passed: ok,
          estimatedCostUsd: 0,
          findings: ok ? [] : [testFinding("foo.test.ts", "introduced")],
        };
      },
    };
    // Semantic review: fails first (seeds rectification), passes on re-run.
    let reviewCalls = 0;
    const reviewOp: DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG> = {
      kind: "deterministic",
      name: "semantic-review",
      stage: "verify",
      config: testSel,
      execute: async () => {
        reviewCalls++;
        const ok = reviewCalls > 1;
        return {
          success: ok,
          passed: ok,
          estimatedCostUsd: 0,
          findings: ok
            ? []
            : [{ source: "semantic", category: "x", severity: "error", message: "r", rule: "r", file: "a.ts" }],
        };
      },
    };

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = (async (
      _ctx: unknown,
      op: { kind?: string; execute?: (i: unknown, c: unknown) => unknown },
      input: unknown,
    ) => {
      if (op.kind === "deterministic" && op.execute) return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    }) as typeof _storyOrchestratorDeps.callOp;
    // Simulate a fix iteration's revalidation, which re-runs the gate (now red).
    _storyOrchestratorDeps.runFixCycle = (async (cycle: { validate: (c: unknown, o: unknown) => Promise<unknown> }) => {
      await cycle.validate({}, { mode: "full", strategiesRun: ["autofix-implementer"] });
      return { iterations: [], finalFindings: [], exitReason: "resolved" as const, costUsd: 0 };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    try {
      const ctx = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as unknown as CallContext;
      const result = await buildPlan(ctx, gateOp, reviewOp).run();
      // Without the fix the carve-out would exempt the gate → success=true.
      expect(result.success).toBe(false);
      expect(result.gateRegressedDuringRect).toBe(true);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });

  test("verifier passed and gate stays green through rectification → story passes (no false positive)", async () => {
    const config = makeNaxConfig({
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2, abortOnIncreasingFailures: false } },
    });
    rt = makeTestRuntime({ config });

    const gateOp = makeDeterministicOp("full-suite-gate", { success: true });
    let reviewCalls = 0;
    const reviewOp: DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG> = {
      kind: "deterministic",
      name: "semantic-review",
      stage: "verify",
      config: testSel,
      execute: async () => {
        reviewCalls++;
        const ok = reviewCalls > 1;
        return {
          success: ok,
          passed: ok,
          estimatedCostUsd: 0,
          findings: ok
            ? []
            : [{ source: "semantic", category: "x", severity: "error", message: "r", rule: "r", file: "a.ts" }],
        };
      },
    };

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = (async (
      _ctx: unknown,
      op: { kind?: string; execute?: (i: unknown, c: unknown) => unknown },
      input: unknown,
    ) => {
      if (op.kind === "deterministic" && op.execute) return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    }) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.runFixCycle = (async (cycle: { validate: (c: unknown, o: unknown) => Promise<unknown> }) => {
      await cycle.validate({}, { mode: "full", strategiesRun: ["autofix-implementer"] });
      return { iterations: [], finalFindings: [], exitReason: "resolved" as const, costUsd: 0 };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    try {
      const ctx = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as unknown as CallContext;
      const result = await buildPlan(ctx, gateOp, reviewOp).run();
      expect(result.success).toBe(true);
      expect(result.gateRegressedDuringRect).toBe(false);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ExecutionPlan.run — completeness guard: carve-out must NOT pass a story when a
// configured review phase never ran (US-002 regression).
//
// Repro: full-suite-gate stays red with the SAME finding through rectification
// (subset of baseline → NOT regressed → carve-out would normally exempt it).
// verifier + semantic-review pass during the lite revalidation under a strategy whose
// scope excludes adversarial-review (mechanical-lintfix — since audit #2, full-suite-rectify
// DOES re-run adversarial, so a mechanical strategy is now the realistic way a review is
// skipped). The post-rectification resume loop breaks at the still-red gate (canonical
// pos 4) before reaching adversarial-review (pos 10), so adversarial-review never runs —
// yet the verifier-SSOT carve-out exempts the gate. The completeness guard must still fail
// the story rather than pass it WITHOUT adversarial judgment.
// ─────────────────────────────────────────────────────────────────────────────

describe("ExecutionPlan.run — completeness guard (configured review must run)", () => {
  let rt: NaxRuntime | undefined;
  afterEach(async () => {
    await rt?.close();
  });

  test("carve-out exempts red gate but adversarial-review never ran → story fails (not silent pass)", async () => {
    const config = makeNaxConfig({
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2, abortOnIncreasingFailures: false } },
    });
    rt = makeTestRuntime({ config });

    // Gate: red with the SAME finding on every run (main loop + every re-run).
    // Identical finding → post-rect keys ⊆ baseline → gateRegressedDuringRect=false.
    const gateOp: DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG> = {
      kind: "deterministic",
      name: "full-suite-gate",
      stage: "verify",
      config: testSel,
      execute: async () => ({
        success: false,
        passed: false,
        estimatedCostUsd: 0,
        findings: [testFinding("foo.test.ts", "persistent")],
      }),
    };
    const semanticOp = makeDeterministicOp("semantic-review", { success: true });

    let adversarialRuns = 0;
    const adversarialOp: DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG> = {
      kind: "deterministic",
      name: "adversarial-review",
      stage: "verify",
      config: testSel,
      execute: async () => {
        adversarialRuns++;
        return { success: true, passed: true, estimatedCostUsd: 0, findings: [] };
      },
    };

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = (async (
      _ctx: unknown,
      op: { kind?: string; execute?: (i: unknown, c: unknown) => unknown },
      input: unknown,
    ) => {
      if (op.kind === "deterministic" && op.execute) return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    }) as typeof _storyOrchestratorDeps.callOp;
    // Lite revalidation under mechanical-lintfix scope: revalidates lint-check only, so
    // adversarial-review is excluded (full-suite-rectify now includes it — audit #2 — so a
    // mechanical strategy is the realistic way a configured review is skipped). Exit "resolved".
    _storyOrchestratorDeps.runFixCycle = (async (cycle: {
      validate: (c: unknown, o: unknown) => Promise<unknown>;
    }) => {
      await cycle.validate({}, { mode: "lite", strategiesRun: ["mechanical-lintfix"] });
      return { iterations: [], finalFindings: [], exitReason: "resolved" as const, costUsd: 0 };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    try {
      const ctx = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-adv",
      } as unknown as CallContext;

      const result = await new StoryOrchestratorBuilder()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-adv" } as never, workdir: "/tmp" } })
        .addVerifier({ op: makeDeterministicOp("verifier", { success: true }), input: {} })
        .addSemanticReview({ op: semanticOp, input: {} })
        .addAdversarialReview({ op: adversarialOp, input: {} })
        .addRectification({ maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false })
        .build(ctx)
        .run();

      // Precondition: this is the carve-out path, not the staleness path.
      expect(result.gateRegressedDuringRect).toBe(false);
      // The bug: adversarial-review never executed (resume broke at the red gate).
      expect(adversarialRuns).toBe(0);
      expect("adversarial-review" in result.phaseOutputs).toBe(false);
      // The fix: a configured review that never ran must NOT yield a passing story.
      expect(result.success).toBe(false);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });
});
