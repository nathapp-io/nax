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

import { afterEach, describe, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CallContext, DeterministicOperation } from "@/operations";
import { pickSelector } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import { makeMockAgentManager, makeTestRuntime, makeNaxConfig } from "@test/helpers";
import type { NaxRuntime } from "@/runtime";
import type { Finding } from "@/findings";
import {
  _storyOrchestratorDeps,
  EXHAUSTED_EXIT_REASONS,
  StoryOrchestratorBuilder,
} from "@/execution";
import type { RunOperation } from "@/operations";

// ============================================================================
// Shared helpers
// ============================================================================

const testSel = pickSelector("test-resume-guard-selector", "execution");

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
  parse: (output) => {
    try { return JSON.parse(output); } catch { return { success: false }; }
  },
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
      runAsSessionFn: async (_req, onSuccess) =>
        onSuccess({
          turnId: randomUUID(),
          output: JSON.stringify({ success: true }),
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          estimatedCostUsd: 0.001,
        }),
    });
    runtime = makeTestRuntime({ config, agentManager });

    // Gate fails with source-tagged finding → initialFindings non-empty → runFixCycle called.
    const gateOp = makeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [GATE_FINDING],
    });

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };
    // Simulate cycle exiting with validate-short-circuit + no remaining findings.
    _storyOrchestratorDeps.runFixCycle = async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "validate-short-circuit" as const,
      costUsd: 0,
    });

    try {
      const ctx: CallContext = {
        runtime: runtime!,
        packageView: runtime!.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-ac3",
      } as any;

      const result = await new StoryOrchestratorBuilder()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-ac3" } as any, workdir: "/tmp" } })
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
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };
    // Simulate cycle exiting with validate-short-circuit but still has unfixed findings.
    const unfixed: Finding[] = [GATE_FINDING];
    _storyOrchestratorDeps.runFixCycle = async () => ({
      iterations: [],
      finalFindings: unfixed,
      exitReason: "validate-short-circuit" as const,
      costUsd: 0,
    });

    try {
      const ctx: CallContext = {
        runtime: runtime!,
        packageView: runtime!.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-ac4",
      } as any;

      const result = await new StoryOrchestratorBuilder()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-ac4" } as any, workdir: "/tmp" } })
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
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      opRunCount[op.name] = (opRunCount[op.name] ?? 0) + 1;
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };
    // validate-short-circuit + non-empty → runRectification should return rectificationExhausted: true
    _storyOrchestratorDeps.runFixCycle = async () => ({
      iterations: [],
      finalFindings: [GATE_FINDING],
      exitReason: "validate-short-circuit" as const,
      costUsd: 0,
    });

    try {
      const ctx: CallContext = {
        runtime: runtime!,
        packageView: runtime!.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-ac5",
      } as any;

      await new StoryOrchestratorBuilder()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-ac5" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
        .build(ctx)
        .run();

      // AC5: verifier was never dispatched — resume block skipped because rectificationExhausted=true.
      // Verifier is absent from phaseOutputs (main loop short-circuited at gate, resume NOT entered).
      // With current code, runRectification returns {} (not rectificationExhausted: true) → resume ENTERS → verifier RUNS → test FAILS.
      expect(opRunCount["verifier"] ?? 0).toBe(0);
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
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      opRunCount[op.name] = (opRunCount[op.name] ?? 0) + 1;
      if (op.name === "full-suite-gate") {
        // Gate passes after rectification (so resume continues past it).
        if (opRunCount["full-suite-gate"] > 1) {
          return { success: true, findings: [], estimatedCostUsd: 0 };
        }
      }
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };
    // validate-short-circuit + empty → runRectification should return liteScopeIncomplete: true
    _storyOrchestratorDeps.runFixCycle = async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "validate-short-circuit" as const,
      costUsd: 0,
    });

    try {
      const ctx: CallContext = {
        runtime: runtime!,
        packageView: runtime!.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-ac6",
      } as any;

      const result = await new StoryOrchestratorBuilder()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-ac6" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
        .build(ctx)
        .run();

      // AC6: resume block IS entered → verifier is dispatched (it was absent from phaseOutputs).
      // With current code, runRectification returns {} → liteScopeIncomplete is undefined → test FAILS on that.
      expect(result.liteScopeIncomplete).toBe(true);
      // Resume IS entered → verifier ran.
      expect(opRunCount["verifier"] ?? 0).toBeGreaterThan(0);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });
});
