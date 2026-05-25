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
// AC2.5: Integration — semantic findings route to autofix-implementer
// ─────────────────────────────────────────────────────────────────────────────

describe("AC2.5: rectification routing — verifier-as-SSOT carve-out with semantic findings", () => {
  test("AC2.5: gate has 6 test-runner findings, verifier passes, semantic has 3 → cycle gets only 3 semantic findings", async () => {
    const gateFindings = makeTestRunnerFindings(6);
    const semanticFindings = makeSemanticFindings(3);

    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "implementer") return { success: true };
      if (op.name === "full-suite-gate") return { success: false, findings: gateFindings };
      if (op.name === "verifier") return { success: true, findings: [] };
      if (op.name === "semantic-review") return { success: false, passed: false, findings: semanticFindings };
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
    const config = makeNaxConfig();

    const ctx = makeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { story: "US-routing" } })
      .addFullSuiteGate({ op: mockFullSuiteGateOp, input: { story: "US-routing" } })
      .addVerifier({ op: mockVerifierOp, input: { story: "US-routing" } })
      .addSemanticReview({ op: mockSemanticReviewOp, input: { story: "US-routing" } })
      .addRectification({
        maxAttempts: 3,
        strategies: [
          makeAutofixImplementerStrategy(story),
          makeFullSuiteRectifyStrategy(story),
        ],
        abortOnIncreasingFailures: false,
      })
      .build(ctx, { isThreeSession: true });

    await plan.run();

    // runFixCycle must have been called (there are semantic findings)
    expect(capturedCycle).not.toBeNull();

    const cycle = capturedCycle as unknown as FixCycle<Finding>;

    // AC2.5a: exactly 3 findings (semantic only, not the 6 gate findings)
    expect(cycle.findings).toHaveLength(3);

    // AC2.5b: no test-runner findings in the cycle
    const hasTestRunnerFinding = cycle.findings.some((f) => f.source === "test-runner");
    expect(hasTestRunnerFinding).toBe(false);

    // AC2.5c: all findings are from semantic-review
    const allSemantic = cycle.findings.every((f) => f.source === "semantic-review");
    expect(allSemantic).toBe(true);

    // AC2.5d: the first matching strategy for these findings is autofix-implementer, not full-suite-rectify
    const matchingStrategies = cycle.strategies.filter((s) =>
      cycle.findings.some((f) => s.appliesTo(f)),
    );
    expect(matchingStrategies.length).toBeGreaterThan(0);
    expect(matchingStrategies[0]?.name).toBe("autofix-implementer");
  });
});
