/**
 * Integration test: rectification routing with verifier-as-SSOT carve-out (AC2.5)
 *
 * Verifies that when:
 * - full-suite-gate fails with 6 test-runner findings
 * - verifier passes (success: true)
 * - semantic-review fails with 3 semantic findings
 *
 * The rectification cycle receives ONLY the 3 semantic findings (not the 6 gate findings),
 * causing autofix-implementer (not full-suite-rectify) to be selected.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _storyOrchestratorDeps, StoryOrchestratorBuilder } from "@/execution";
import type { FixCycle, FixCycleContext, FixCycleExitReason } from "@/findings/cycle-types";
import type { Finding } from "@/findings/types";
import { pickSelector, DEFAULT_CONFIG } from "@/config";
import { makeTestRuntime, makeStory, makeNaxConfig } from "@test/helpers";
import { makeAutofixImplementerStrategy, makeFullSuiteRectifyStrategy } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import type { RunOperation, CallContext } from "@/operations";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const testSel = pickSelector("test-routing-sel", "execution");

const mockImplementerOp: RunOperation<{ story: string }, { success: boolean }, typeof DEFAULT_CONFIG> = {
  kind: "run",
  name: "implementer",
  stage: "run",
  config: testSel as any,
  session: { role: "implementer", lifetime: "warm" },
  build: () => ({
    role: { id: "r", content: "impl", overridable: false },
    task: { id: "t", content: "", overridable: false },
  }),
  parse: () => ({ success: true }),
};

const mockVerifierOp: RunOperation<
  { story: string },
  { success: boolean; findings: Finding[] },
  typeof DEFAULT_CONFIG
> = {
  kind: "run",
  name: "verifier",
  stage: "verify",
  config: testSel as any,
  session: { role: "verifier", lifetime: "fresh" },
  build: () => ({
    role: { id: "r", content: "verify", overridable: false },
    task: { id: "t", content: "", overridable: false },
  }),
  parse: () => ({ success: true, findings: [] }),
};

const mockFullSuiteGateOp: RunOperation<
  { story: string },
  { success: boolean; findings: Finding[] },
  typeof DEFAULT_CONFIG
> = {
  kind: "run",
  name: "full-suite-gate",
  stage: "verify",
  config: testSel as any,
  session: { role: "verifier", lifetime: "fresh" },
  build: () => ({
    role: { id: "r", content: "gate", overridable: false },
    task: { id: "t", content: "", overridable: false },
  }),
  parse: () => ({ success: true, findings: [] }),
};

const mockSemanticReviewOp: RunOperation<
  { story: string },
  { success: boolean; passed: boolean; findings: Finding[] },
  typeof DEFAULT_CONFIG
> = {
  kind: "run",
  name: "semantic-review",
  stage: "review",
  config: testSel as any,
  session: { role: "reviewer-semantic", lifetime: "fresh" },
  build: () => ({
    role: { id: "r", content: "review", overridable: false },
    task: { id: "t", content: "", overridable: false },
  }),
  parse: () => ({ success: false, passed: false, findings: [] }),
};

// ─────────────────────────────────────────────────────────────────────────────
// Findings fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeTestRunnerFindings(count: number): Finding[] {
  return Array.from({ length: count }, (_, i) => ({
    source: "test-runner" as const,
    category: "failed-test",
    severity: "error" as const,
    message: `Test ${i + 1} failed`,
    file: `test/suite-${i + 1}.test.ts`,
    line: 1,
    fixTarget: "test" as const,
  }));
}

function makeSemanticFindings(count: number): Finding[] {
  return Array.from({ length: count }, (_, i) => ({
    source: "semantic-review" as const,
    severity: "error" as const,
    category: "",
    message: `Does not implement AC-00${i + 1}`,
    file: "src/foo.ts",
    line: i + 1,
    fixTarget: "source" as const,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared state
// ─────────────────────────────────────────────────────────────────────────────

let origCallOp: typeof _storyOrchestratorDeps.callOp;
let origRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
let runtime: NaxRuntime;

function makeCtx(): CallContext {
  runtime = makeTestRuntime();
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId: "US-routing",
  } as CallContext;
}

beforeEach(() => {
  origCallOp = _storyOrchestratorDeps.callOp;
  origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
  origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
  _storyOrchestratorDeps.captureGitRef = mock(async () => "HEAD");
});

afterEach(async () => {
  _storyOrchestratorDeps.callOp = origCallOp;
  _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
  _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
  await runtime?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2.5: Integration — gate findings route directly to rectification
// (old verifier-as-SSOT carve-out removed: gate failure halts the main loop
//  before verifier/semantic-review; those phases only run after rectification)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC2.5: rectification routing — gate failure halts loop, gate findings enter cycle", () => {
  test("AC2.5: gate has 6 test-runner findings → loop halts before verifier/semantic, cycle gets 6 gate findings", async () => {
    // New contract: gate failure halts the main loop. Verifier and semantic-review
    // do NOT run in the initial pass — they only run in phasesToRevalidate after
    // rectification drives the gate back to green. The initial cycle findings
    // are therefore the gate's test-runner findings, not semantic findings.
    const gateFindings = makeTestRunnerFindings(6);

    let verifierCalled = false;
    let semanticCalled = false;

    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "implementer") return { success: true };
      if (op.name === "full-suite-gate") return { success: false, findings: gateFindings };
      if (op.name === "verifier") { verifierCalled = true; return { success: true, findings: [] }; }
      if (op.name === "semantic-review") { semanticCalled = true; return { success: false, passed: false, findings: [] }; }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    let capturedCycle: FixCycle<Finding> | null = null;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: FixCycle<Finding>) => {
      capturedCycle = cycle;
      return {
        iterations: [],
        finalFindings: [],
        exitReason: "resolved" as FixCycleExitReason,
        costUsd: 0,
      };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    const story = makeStory({ id: "US-routing" });

    const ctx = makeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { story: "US-routing" } })
      .addFullSuiteGate({ op: mockFullSuiteGateOp, input: { story: "US-routing" } })
      .addVerifier({ op: mockVerifierOp, input: { story: "US-routing" } })
      .addSemanticReview({ op: mockSemanticReviewOp, input: { story: "US-routing" } })
      .addRectification({
        maxAttempts: 3,
        strategies: [
          makeAutofixImplementerStrategy(story, makeNaxConfig()),
          makeFullSuiteRectifyStrategy(story, makeNaxConfig()),
        ],
        abortOnIncreasingFailures: false,
      })
      .build(ctx, { isThreeSession: true });

    await plan.run();

    // Gate halts the loop — verifier and semantic-review must NOT have run.
    expect(verifierCalled).toBe(false);
    expect(semanticCalled).toBe(false);

    // runFixCycle must have been called (gate findings are present)
    expect(capturedCycle).not.toBeNull();

    const cycle = capturedCycle as unknown as FixCycle<Finding>;

    // AC2.5a: exactly 6 findings (gate findings, not semantic)
    expect(cycle.findings).toHaveLength(6);

    // AC2.5b: all findings are from test-runner (gate output)
    const allTestRunner = cycle.findings.every((f) => f.source === "test-runner");
    expect(allTestRunner).toBe(true);

    // AC2.5c: the first matching strategy for test-runner findings is full-suite-rectify
    const matchingStrategies = cycle.strategies.filter((s) =>
      cycle.findings.some((f) => s.appliesTo(f)),
    );
    expect(matchingStrategies.length).toBeGreaterThan(0);
    expect(matchingStrategies[0]?.name).toBe("full-suite-rectify");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3.8: verifier is dispatched during initial run; NOT re-dispatched for autofix-implementer
//        (autofix-implementer addresses review findings, not the TDD isolation boundary)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC3.8: verifier op dispatched during initial run and re-dispatched during validate for code-editing strategies", () => {
  test("AC3.8: semantic findings only — verifier called during initial run, NOT called during capturedCycle.validate with autofix-implementer", async () => {
    const semanticFindings = makeSemanticFindings(3);

    // Track all callOp invocations (phase name → call count)
    const initialCallCounts: Record<string, number> = {};

    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      initialCallCounts[op.name] = (initialCallCounts[op.name] ?? 0) + 1;
      if (op.name === "implementer") return { success: true };
      if (op.name === "full-suite-gate") return { success: true, findings: [] };
      if (op.name === "verifier") return { success: true, findings: [] };
      if (op.name === "semantic-review") return { success: false, passed: false, findings: semanticFindings };
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    let capturedCycle: FixCycle<Finding> | null = null;
    let capturedCtx: FixCycleContext | null = null;

    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: FixCycle<Finding>, cycleCtx: FixCycleContext) => {
      capturedCycle = cycle;
      capturedCtx = cycleCtx;
      return {
        iterations: [],
        finalFindings: [],
        exitReason: "resolved" as FixCycleExitReason,
        costUsd: 0,
      };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    const story = makeStory({ id: "US-routing-ac38" });

    const ctx = makeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { story: "US-routing-ac38" } })
      .addFullSuiteGate({ op: mockFullSuiteGateOp, input: { story: "US-routing-ac38" } })
      .addVerifier({ op: mockVerifierOp, input: { story: "US-routing-ac38" } })
      .addSemanticReview({ op: mockSemanticReviewOp, input: { story: "US-routing-ac38" } })
      .addRectification({
        maxAttempts: 3,
        strategies: [makeAutofixImplementerStrategy(story, makeNaxConfig())],
        abortOnIncreasingFailures: false,
      })
      .build(ctx, { isThreeSession: true });

    await plan.run();

    // Verifier ran exactly once during the initial plan execution
    expect(initialCallCounts["verifier"]).toBe(1);

    expect(capturedCycle).not.toBeNull();
    expect(capturedCtx).not.toBeNull();

    // Now set up tracking for the validate call
    const validateCallCounts: Record<string, number> = {};
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      validateCallCounts[op.name] = (validateCallCounts[op.name] ?? 0) + 1;
      return { success: true, passed: true, findings: [] };
    }) as typeof _storyOrchestratorDeps.callOp;

    // Invoke validate with autofix-implementer strategiesRun
    await (capturedCycle as unknown as FixCycle<Finding>).validate(capturedCtx as unknown as FixCycleContext, {
      mode: "full",
      strategiesRun: ["autofix-implementer"],
    });

    // autofix-implementer addresses review findings, not the TDD isolation boundary.
    // Verifier is a once-per-story phase and is NOT re-dispatched after autofix-implementer.
    expect(validateCallCounts["verifier"] ?? 0).toBe(0);

    // Semantic review MUST be re-run (it's in autofix-implementer's phase set)
    expect(validateCallCounts["semantic-review"] ?? 0).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3.9: after autofix-implementer, full-suite-gate + verifier + semantic-review re-dispatched
// ─────────────────────────────────────────────────────────────────────────────

describe("AC3.9: after autofix-implementer iteration, full-suite-gate and semantic-review re-dispatched; verifier excluded", () => {
  test("AC3.9: validate with strategiesRun=['autofix-implementer'] → full-suite-gate + semantic-review called; verifier excluded", async () => {
    const semanticFindings = makeSemanticFindings(2);

    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "implementer") return { success: true };
      if (op.name === "full-suite-gate") return { success: true, findings: [] };
      if (op.name === "verifier") return { success: true, findings: [] };
      if (op.name === "semantic-review") return { success: false, passed: false, findings: semanticFindings };
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    let capturedCycle: FixCycle<Finding> | null = null;
    let capturedCtx: FixCycleContext | null = null;

    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: FixCycle<Finding>, cycleCtx: FixCycleContext) => {
      capturedCycle = cycle;
      capturedCtx = cycleCtx;
      return {
        iterations: [],
        finalFindings: [],
        exitReason: "resolved" as FixCycleExitReason,
        costUsd: 0,
      };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    const story = makeStory({ id: "US-routing-ac39" });

    const ctx = makeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { story: "US-routing-ac39" } })
      .addFullSuiteGate({ op: mockFullSuiteGateOp, input: { story: "US-routing-ac39" } })
      .addVerifier({ op: mockVerifierOp, input: { story: "US-routing-ac39" } })
      .addSemanticReview({ op: mockSemanticReviewOp, input: { story: "US-routing-ac39" } })
      .addRectification({
        maxAttempts: 3,
        strategies: [makeAutofixImplementerStrategy(story, makeNaxConfig())],
        abortOnIncreasingFailures: false,
      })
      .build(ctx, { isThreeSession: true });

    await plan.run();

    expect(capturedCycle).not.toBeNull();
    expect(capturedCtx).not.toBeNull();

    // Set up tracking callOp for the validate call
    const validateCallCounts: Record<string, number> = {};
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      validateCallCounts[op.name] = (validateCallCounts[op.name] ?? 0) + 1;
      return { success: true, passed: true, findings: [] };
    }) as typeof _storyOrchestratorDeps.callOp;

    // Simulate: after an autofix-implementer iteration, call validate
    await (capturedCycle as unknown as FixCycle<Finding>).validate(capturedCtx as unknown as FixCycleContext, {
      mode: "full",
      strategiesRun: ["autofix-implementer"],
    });

    // full-suite-gate MUST be re-dispatched (it's in autofix-implementer's phase set)
    expect(validateCallCounts["full-suite-gate"] ?? 0).toBeGreaterThan(0);

    // semantic-review MUST be re-dispatched (it's in autofix-implementer's phase set)
    expect(validateCallCounts["semantic-review"] ?? 0).toBeGreaterThan(0);

    // autofix-implementer addresses review findings, not the TDD isolation boundary.
    // Verifier is excluded from autofix-implementer's revalidation set (once-per-story phase).
    expect(validateCallCounts["verifier"] ?? 0).toBe(0);
  });
});
