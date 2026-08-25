/**
 * Integration tests: verifier-findings flow (AC7 and AC8)
 *
 * Covers integration scenarios introduced by the story
 * "Resume guard and RectificationResult: wire validate-short-circuit to liteScopeIncomplete":
 *
 * AC7: verifier findings (tdd-verifier source) route to autofix-implementer and
 *      the prompt built by build() uses RectifierPromptBuilder.verifierContext —
 *      not the legacy reviewRectification path.
 *
 * AC8: validate-short-circuit + empty normalizedFindings → liteScopeIncomplete: true
 *      AND the resume block re-dispatches full-suite-gate (it was failing in phaseOutputs).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeNaxConfig, makeStory, makeTestRuntime } from "@test/helpers";
import { type NaxConfig, pickSelector } from "@/config";
import { _storyOrchestratorDeps, StoryOrchestratorBuilder } from "@/execution";
import type { FixStrategy } from "@/findings";
import type { Finding } from "@/findings/types";
import type { AutofixImplementerInput, CallContext, DeterministicOperation, RunOperation } from "@/operations";
import { implementerRectifyOp, makeAutofixImplementerStrategy, makeDeclarationSink } from "@/operations";
import type { NaxRuntime } from "@/runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

type TestSlice = Pick<NaxConfig, "execution">;

const testSel = pickSelector("test-verifier-flow-sel", "execution");

/** User-defined predicate: the dispatched fix input is the strategy's real buildInput shape. */
function isAutofixImplementerInput(v: unknown): v is AutofixImplementerInput {
  return typeof v === "object" && v !== null && "story" in v && "failedChecks" in v;
}

const mockImplementerOp: RunOperation<{ code: string }, { success: boolean }, TestSlice> = {
  kind: "run",
  name: "implementer",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "warm" },
  build: () => ({
    role: { id: "r", content: "Implement", overridable: false },
    task: { id: "t", content: "", overridable: false },
  }),
  parse: () => ({ success: true }),
};

function makeDeterministicOp(
  name: string,
  result: { success: boolean; findings?: Finding[]; normalizedFindings?: Finding[] },
): DeterministicOperation<unknown, unknown, TestSlice> {
  return {
    kind: "deterministic",
    name,
    stage: "verify",
    config: testSel,
    execute: async () => ({ ...result, estimatedCostUsd: 0 }),
  };
}

/**
 * A tdd-verifier finding with fixTarget="source" — matches the autofix-implementer
 * strategy's appliesTo predicate (source in IMPLEMENTER_SOURCES, fixTarget === "source").
 */
const VERIFIER_FINDING: Finding = {
  source: "tdd-verifier",
  category: "tests-failed",
  severity: "error",
  fixTarget: "source",
  message: "1 story-scoped test(s) failed (verifier)",
};

const GATE_FINDING: Finding = {
  source: "test-runner",
  category: "failed-test",
  severity: "error",
  message: "suite failed",
  file: "test/foo.test.ts",
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared test state
// ─────────────────────────────────────────────────────────────────────────────

let origCallOp: typeof _storyOrchestratorDeps.callOp;
let origRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
let runtime: NaxRuntime;

function makeCtx(storyId: string): CallContext {
  runtime = makeTestRuntime();
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId,
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
// AC7: verifier findings → autofix-implementer prompt uses verifierContext
// ─────────────────────────────────────────────────────────────────────────────

describe("AC7: verifier findings route to autofix-implementer via verifierContext prompt", () => {
  test("AC7: autofix-implementer build() prompt contains verifierContext text when fixing tdd-verifier findings", async () => {
    const opCounts: Record<string, number> = {};
    let capturedPrompt: string | undefined;

    // Verifier fails on first dispatch (main loop); passes on resume re-dispatch.
    // Full-suite-gate always passes so gate findings don't dominate rectification.
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }, input: unknown) => {
      const name = op.name;
      opCounts[name] = (opCounts[name] ?? 0) + 1;

      if (name === "implementer") {
        return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
      }
      if (name === "full-suite-gate") {
        return { success: true, findings: [], normalizedFindings: [], estimatedCostUsd: 0 };
      }
      if (name === "verifier") {
        // First dispatch: fail with tdd-verifier finding → enters rectification.
        // Subsequent dispatches (resume block): pass so story terminates cleanly.
        if (opCounts.verifier === 1) {
          return {
            success: false,
            normalizedFindings: [VERIFIER_FINDING],
            filesChanged: [],
            estimatedCostUsd: 0,
            durationMs: 0,
            output: "",
          };
        }
        return {
          success: true,
          normalizedFindings: [],
          filesChanged: [],
          estimatedCostUsd: 0,
          durationMs: 0,
          output: "",
        };
      }
      if (name === "autofix-implementer") {
        // Capture the prompt by calling the strategy's real fixOp (implementerRectifyOp)
        // directly. After implementation, build() should use verifierContext for
        // tdd-verifier findings.
        try {
          if (!isAutofixImplementerInput(input)) throw new Error("unexpected autofix input shape");
          const built = implementerRectifyOp.build(input, {
            packageView: runtime.packages.repo(),
            config: makeNaxConfig(),
          });
          capturedPrompt = built.task?.content ?? "";
        } catch {
          capturedPrompt = "";
        }
        return { applied: true, testEditDeclarations: [] };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const story = makeStory({ id: "US-ac7" });
    const sink = makeDeclarationSink();
    const verifierOp = makeDeterministicOp("verifier", { success: false, normalizedFindings: [VERIFIER_FINDING] });
    const gateOp = makeDeterministicOp("full-suite-gate", { success: true });

    const ctx = makeCtx("US-ac7");

    await new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .addFullSuiteGate({ op: gateOp, input: { story, workdir: "/tmp" } })
      .addVerifier({ op: verifierOp, input: { story, workdir: "/tmp" } })
      .addRectification({
        maxAttempts: 3,
        strategies: [makeAutofixImplementerStrategy(story, makeNaxConfig(), sink)],
        abortOnIncreasingFailures: false,
      })
      .build(ctx)
      .run();

    // AC7a: autofix-implementer was dispatched (tdd-verifier findings routed to it).
    expect(opCounts["autofix-implementer"] ?? 0).toBeGreaterThan(0);

    // AC7b (failing assertion before implementation): the prompt built by
    // autofix-implementer.build() must contain text produced by verifierContext,
    // not just the reviewRectification path which lacks this phrase.
    // Before implementation: capturedPrompt uses reviewRectification → no "verifier finding" text → FAILS.
    // After implementation: capturedPrompt uses verifierContext → contains "verifier finding" → PASSES.
    expect(capturedPrompt).toBeDefined();
    expect(capturedPrompt).toContain("verifier finding");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8: validate-short-circuit + empty normalizedFindings → liteScopeIncomplete + resume dispatches gate
// ─────────────────────────────────────────────────────────────────────────────

describe("AC8: validate-short-circuit + empty findings → liteScopeIncomplete and resume dispatches full-suite-gate", () => {
  test("AC8: real runFixCycle path sets liteScopeIncomplete=true and resume re-dispatches full-suite-gate", async () => {
    const opCounts: Record<string, number> = {};

    // Gate fails on first dispatch (main loop), passes on resume re-dispatch.
    // Verifier fails during lite validate with empty normalizedFindings, which
    // should produce validate-short-circuit (not resolved) in the cycle.
    // Resume then re-dispatches gate/verifier; both pass on those later calls.
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }, _input: unknown) => {
      const name = op.name;
      opCounts[name] = (opCounts[name] ?? 0) + 1;

      if (name === "implementer") {
        return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
      }
      if (name === "full-suite-gate") {
        // Fail on first call (main loop triggers rectification).
        // Pass on subsequent calls (resume re-dispatch succeeds).
        if (opCounts["full-suite-gate"] === 1) {
          return { success: false, findings: [GATE_FINDING], normalizedFindings: [], estimatedCostUsd: 0 };
        }
        return { success: true, findings: [], normalizedFindings: [], estimatedCostUsd: 0 };
      }
      if (name === "verifier") {
        // First verifier run happens in lite validate after full-suite-rectify.
        // Return failure + empty findings to force short-circuit signalling.
        if (opCounts.verifier === 1) {
          return {
            success: false,
            normalizedFindings: [],
            filesChanged: [],
            estimatedCostUsd: 0,
            durationMs: 0,
            output: "",
          };
        }
        return {
          success: true,
          normalizedFindings: [],
          filesChanged: [],
          estimatedCostUsd: 0,
          durationMs: 0,
          output: "",
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const gateOp = makeDeterministicOp("full-suite-gate", { success: false, findings: [GATE_FINDING] });
    const verifierOp = makeDeterministicOp("verifier", { success: true });
    const noopRectifyOp: RunOperation<{ story: { id: string } }, { success: boolean }, TestSlice> = {
      kind: "run",
      name: "full-suite-rectify-op",
      stage: "rectification",
      config: testSel,
      session: { role: "implementer", lifetime: "warm" },
      build: () => ({
        role: { id: "r-rect", content: "Rectify", overridable: false },
        task: { id: "t-rect", content: "Fix tests", overridable: false },
      }),
      parse: () => ({ success: true }),
    };
    const fullSuiteStrategy: FixStrategy<Finding, { story: { id: string } }, { success: boolean }> = {
      name: "full-suite-rectify",
      appliesTo: (f) => f.source === "test-runner",
      fixOp: noopRectifyOp,
      buildInput: () => ({ story: { id: "US-ac8" } }),
      maxAttempts: 1,
      coRun: "exclusive",
    };

    const ctx = makeCtx("US-ac8");

    const result = await new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .addFullSuiteGate({ op: gateOp, input: { story: makeStory({ id: "US-ac8" }), workdir: "/tmp" } })
      .addVerifier({ op: verifierOp, input: { story: makeStory({ id: "US-ac8" }), workdir: "/tmp" } })
      .addRectification({ maxAttempts: 3, strategies: [fullSuiteStrategy], abortOnIncreasingFailures: false })
      .build(ctx)
      .run();

    expect(result.liteScopeIncomplete).toBe(true);

    expect(opCounts["full-suite-gate"] ?? 0).toBeGreaterThanOrEqual(2);
    expect(opCounts.verifier ?? 0).toBeGreaterThanOrEqual(2);
  });
});
