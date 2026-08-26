/**
 * Integration tests: full-suite declarations wired into the main rectification cycle.
 *
 * AC8: full-suite-rectify strategy (with sink) pushes mock_structure declarations to
 *      sink.mockHandoffs; after postValidate validates the files, autofix-test-writer
 *      picks up the handoff.
 * AC9: invalid mock_structure files → reported as a log diagnostic, never as a finding;
 *      postValidate's output stays fully claimable by the cycle's strategies (#1327).
 * AC11: single-session story with mock_structure output → cycle completes without throwing,
 *       no autofix-test-writer strategy dispatched.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeMockPlanInputs, makeNaxConfig, makeStory, makeTestRuntime, withTempDir } from "@test/helpers";
import { _storyOrchestratorDeps, buildPlanForStrategy } from "@/execution";
import type { FixCycle, FixCycleContext, FixCycleExitReason } from "@/findings/cycle-types";
import type { Finding } from "@/findings/types";
import type { FullSuiteRectifyInput, FullSuiteRectifyOutput } from "@/operations/full-suite-rectify-op";
import type { CallContext } from "@/operations/types";
import type { NaxRuntime } from "@/runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Shared setup/teardown
// ─────────────────────────────────────────────────────────────────────────────

let origCallOp: typeof _storyOrchestratorDeps.callOp;
let origRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
let runtime: NaxRuntime;

function makeTestRunnerFinding(): Finding {
  return {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    message: "Expected mock to be called",
    file: "test/unit/service.test.ts",
  };
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
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeCtxWithRuntime(packageDir: string, config = makeNaxConfig()): CallContext {
  runtime = makeTestRuntime({ config });
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir,
    agentName: "claude",
    storyId: "US-decl",
  } as CallContext;
}

function makeRetryInputs(story: ReturnType<typeof makeStory>, packageDir: string) {
  return makeMockPlanInputs({
    story,
    implementer: { story },
    fullSuiteGate: { story, workdir: packageDir },
    verifier: { story },
    rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AC8: full-suite-rectify → extractApplied → sink.mockHandoffs → test-writer dispatched
// ─────────────────────────────────────────────────────────────────────────────

describe("AC8: full-suite-rectify sink integration — test-writer receives mock-restructure handoff", () => {
  test("AC8: after extractApplied + postValidate, autofix-test-writer appliesTo returns true and buildInput has mock-restructure mode", async () => {
    await withTempDir(async (tmpDir) => {
      // Create the test file that will be referenced in the mock_structure declaration.
      const testFilePath = join(tmpDir, "test/unit/service.test.ts");
      await mkdir(dirname(testFilePath), { recursive: true });
      await Bun.write(testFilePath, "// test file for integration test");

      const story = makeStory({ id: "US-decl", attempts: 1 }); // retry: no test-writer phase
      const config = makeNaxConfig({
        quality: { autofix: { enabled: true } },
        execution: { rectification: { enabled: true, maxAttemptsTotal: 3 } },
      });
      const ctx = makeCtxWithRuntime(tmpDir, config);
      const inputs = makeRetryInputs(story, tmpDir);

      // Mock callOp: full-suite-gate fails with a test-runner finding; other ops pass.
      _storyOrchestratorDeps.callOp = mock(async (_ctx, op) => {
        if (op.name === "full-suite-gate") {
          return { success: false, findings: [makeTestRunnerFinding()] };
        }
        return { success: true };
      }) as typeof _storyOrchestratorDeps.callOp;

      let capturedCycle: FixCycle<Finding> | null = null;
      let capturedCycleCtx: FixCycleContext | null = null;
      _storyOrchestratorDeps.runFixCycle = mock(async (cycle, cycleCtx) => {
        capturedCycle = cycle as FixCycle<Finding>;
        capturedCycleCtx = cycleCtx as FixCycleContext;
        return {
          iterations: [],
          finalFindings: [],
          exitReason: "no-strategy" as FixCycleExitReason,
          costUsd: 0,
        };
      }) as typeof _storyOrchestratorDeps.runFixCycle;

      const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
      await plan.run();

      expect(capturedCycle).not.toBeNull();
      expect(capturedCycleCtx).not.toBeNull();

      // Find the full-suite-rectify strategy in the cycle.
      const fullSuiteStrategy = capturedCycle!.strategies.find((s) => s.name === "full-suite-rectify");
      expect(fullSuiteStrategy).toBeDefined();

      // Simulate extractApplied with a mock_structure declaration referencing the real test file.
      const mockOutput: FullSuiteRectifyOutput = {
        applied: true,
        testEditDeclarations: [
          {
            reason: "mock_structure",
            file: "test/unit/service.test.ts",
            files: ["test/unit/service.test.ts"],
            reasonDetail: "Mock setup needs restructuring to use factory pattern",
          },
        ],
      };
      const mockInput: FullSuiteRectifyInput = { story, findings: [] };
      await fullSuiteStrategy!.extractApplied!(mockOutput, mockInput);

      // Set up callOp for the validate re-run (all phases pass).
      _storyOrchestratorDeps.callOp = mock(async () => ({
        success: true,
      })) as typeof _storyOrchestratorDeps.callOp;

      // Call validate to trigger postValidate, which validates the file and updates the sink.
      await capturedCycle!.validate(capturedCycleCtx!, {
        mode: "full",
        strategiesRun: ["full-suite-rectify"],
      });

      // After postValidate, autofix-test-writer should apply (sink.mockHandoffs has valid entry).
      const testWriterStrategy = capturedCycle!.strategies.find((s) => s.name === "autofix-test-writer");
      expect(testWriterStrategy).toBeDefined();

      const dummyFinding: Finding = {
        source: "lint",
        severity: "error",
        category: "style",
        message: "dummy",
      };
      // AC8: appliesTo returns true because sink.mockHandoffs has the validated entry.
      expect(testWriterStrategy!.appliesTo(dummyFinding)).toBe(true);

      // AC8: buildInput reflects mock-restructure mode with the handoff file.
      const builtInput = testWriterStrategy!.buildInput([dummyFinding], [], capturedCycleCtx!);
      expect(builtInput.mode).toBe("mock-restructure");
      expect(builtInput.handoffFiles).toContain("test/unit/service.test.ts");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9: invalid mock_structure files → no unclaimable finding minted (#1327)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC9: invalid mock_structure files → diagnostic only, no unclaimable finding", () => {
  test("AC9: postValidate mints no finding when mock_structure files do not exist or do not match test patterns", async () => {
    // Use a packageDir where the declared test file does not exist.
    const packageDir = "/tmp/nax-test-ac9-nonexistent-dir";
    const story = makeStory({ id: "US-decl-ac9", attempts: 1 });
    const config = makeNaxConfig({
      quality: { autofix: { enabled: true } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 3 } },
    });
    const ctx = makeCtxWithRuntime(packageDir, config);
    const inputs = makeRetryInputs(story, packageDir);

    _storyOrchestratorDeps.callOp = mock(async (_ctx, op) => {
      if (op.name === "full-suite-gate") {
        return { success: false, findings: [makeTestRunnerFinding()] };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    let capturedCycle: FixCycle<Finding> | null = null;
    let capturedCycleCtx: FixCycleContext | null = null;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle, cycleCtx) => {
      capturedCycle = cycle as FixCycle<Finding>;
      capturedCycleCtx = cycleCtx as FixCycleContext;
      return {
        iterations: [],
        finalFindings: [],
        exitReason: "no-strategy" as FixCycleExitReason,
        costUsd: 0,
      };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();

    expect(capturedCycle).not.toBeNull();

    const fullSuiteStrategy = capturedCycle!.strategies.find((s) => s.name === "full-suite-rectify");
    expect(fullSuiteStrategy).toBeDefined();

    // Declare a mock_structure that references a file that does not exist.
    const invalidMockOutput: FullSuiteRectifyOutput = {
      applied: true,
      testEditDeclarations: [
        {
          reason: "mock_structure",
          file: "test/unit/nonexistent.test.ts",
          files: ["test/unit/nonexistent.test.ts"],
          reasonDetail: "This file does not exist on disk",
        },
      ],
    };
    const mockInput: FullSuiteRectifyInput = { story, findings: [] };
    await fullSuiteStrategy!.extractApplied!(invalidMockOutput, mockInput);

    const testWriterStrategy = capturedCycle!.strategies.find((s) => s.name === "autofix-test-writer");
    expect(testWriterStrategy).toBeDefined();
    const dummyFinding: Finding = { source: "lint", severity: "error", category: "style", message: "dummy" };

    // Precondition: extractApplied populated the sink, so the test-writer's
    // `sink.mockHandoffs.length > 0` clause claims. Without this, the
    // assertions below would also hold on the `postValidate` early-return
    // path (empty sink → returns findings untouched) and prove nothing.
    expect(testWriterStrategy!.appliesTo(dummyFinding)).toBe(true);

    // Set up callOp for validate re-run.
    _storyOrchestratorDeps.callOp = mock(async () => ({ success: true })) as typeof _storyOrchestratorDeps.callOp;

    // Call validate to trigger postValidate.
    const validateResult = await capturedCycle!.validate(capturedCycleCtx!, {
      mode: "full",
      strategiesRun: ["full-suite-rectify"],
    });

    const findings = Array.isArray(validateResult) ? validateResult : validateResult.findings;

    // postValidate reached the validation branch and rejected the handoff: the
    // sink is now drained, so the test-writer no longer claims. This is the
    // positive artifact that the invalid-declaration path actually ran.
    expect(testWriterStrategy!.appliesTo(dummyFinding)).toBe(false);

    // AC9 (#1327): every phase passed, so validate yields no findings — and the
    // rejected handoff must not add one. It is reported as a log diagnostic
    // instead. An appended advisory here is claimed by no strategy's appliesTo,
    // so the cycle would exit "no-strategy" and fail this green story.
    expect(findings).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC11: single-session story with mock_structure output → no test-writer strategy, no throw
// ─────────────────────────────────────────────────────────────────────────────

describe("AC11: single-session story with mock_structure output → no test-writer dispatched, no throw", () => {
  test("AC11: single-session (regressionGate.mode=per-story) cycle has no autofix-test-writer strategy", async () => {
    const packageDir = "/tmp/nax-test-ac11";
    const story = makeStory({ id: "US-decl-ac11", attempts: 1 });
    // tdd-simple is a single-session strategy: isThreeSession = false
    // regressionGate.mode=per-story forces fullSuiteGate (and thus full-suite-rectify) into plan
    const config = makeNaxConfig({
      execution: {
        regressionGate: { mode: "per-story" },
        rectification: { enabled: true, maxAttemptsTotal: 3 },
      },
      quality: { autofix: { enabled: true } },
    });
    const ctx = makeCtxWithRuntime(packageDir, config);
    const inputs = makeMockPlanInputs({
      story,
      implementer: { story },
      fullSuiteGate: { story, workdir: packageDir },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });

    _storyOrchestratorDeps.callOp = mock(async (_ctx, op) => {
      if (op.name === "full-suite-gate") {
        return { success: false, findings: [makeTestRunnerFinding()] };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    let capturedCycle: FixCycle<Finding> | null = null;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle) => {
      capturedCycle = cycle as FixCycle<Finding>;
      return {
        iterations: [],
        finalFindings: [],
        exitReason: "no-strategy" as FixCycleExitReason,
        costUsd: 0,
      };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    // Should not throw even with mock_structure output
    const plan = await buildPlanForStrategy(ctx, story, config, "tdd-simple", inputs);
    await plan.run();

    expect(capturedCycle).not.toBeNull();

    // AC11: no autofix-test-writer strategy in the single-session cycle.
    const hasTestWriter = capturedCycle!.strategies.some((s) => s.name === "autofix-test-writer");
    expect(hasTestWriter).toBe(false);
  });
});
