/**
 * Integration tests: nbf (non-blocking-fix) declaration wiring (#1227).
 *
 * AC-NBF1: mock_structure declaration emitted during the nbf cycle is validated and
 *          applied via nbPostValidate — autofix-test-writer picks up the handoff.
 * AC-NBF2: nbSink is drained by nbPostValidate; the main sink (empty at this point)
 *          is not double-drained.
 * AC-NBF3: invalid mock_structure files in the nbf cycle → reported as a log diagnostic,
 *          never as a finding; nbPostValidate's output stays claimable (#1327).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { buildPlanForStrategy, _storyOrchestratorDeps } from "@/execution";
import type { FixCycle, FixCycleContext, FixCycleExitReason } from "@/findings/cycle-types";
import type { Finding } from "@/findings/types";
import type { FullSuiteRectifyInput, FullSuiteRectifyOutput } from "@/operations/full-suite-rectify-op";
import { _rollbackDeps } from "@/tdd";
import {
  makeMockCallContext,
  makeMockPlanInputs,
  makeNaxConfig,
  makeStory,
  makeTestRuntime,
  withTempDir,
} from "@test/helpers";
import type { NaxRuntime } from "@/runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Shared setup/teardown
// ─────────────────────────────────────────────────────────────────────────────

let origCallOp: typeof _storyOrchestratorDeps.callOp;
let origRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
let origRollbackSpawn: typeof _rollbackDeps.spawn;
let origRollbackAutoCommit: typeof _rollbackDeps.autoCommitIfDirty;
let runtime: NaxRuntime | undefined;

beforeEach(() => {
  origCallOp = _storyOrchestratorDeps.callOp;
  origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
  origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
  origRollbackSpawn = _rollbackDeps.spawn;
  origRollbackAutoCommit = _rollbackDeps.autoCommitIfDirty;
  _storyOrchestratorDeps.captureGitRef = mock(async () => "HEAD");
  // captureSnapshotRef uses _rollbackDeps.spawn for git rev-parse HEAD.
  _rollbackDeps.autoCommitIfDirty = mock(async () => {});
  _rollbackDeps.spawn = mock((_cmd: string[], _opts: unknown) => ({
    stdout: new Response("abc1234\n").body,
    stderr: new Response("").body,
    exited: Promise.resolve(0),
  })) as typeof _rollbackDeps.spawn;
});

afterEach(async () => {
  _storyOrchestratorDeps.callOp = origCallOp;
  _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
  _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
  _rollbackDeps.spawn = origRollbackSpawn;
  _rollbackDeps.autoCommitIfDirty = origRollbackAutoCommit;
  await runtime?.close();
  runtime = undefined;
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeAdvisoryFinding(): Finding {
  return {
    source: "adversarial-review",
    severity: "warning",
    category: "style",
    message: "Advisory: consider refactoring mock setup",
  };
}

function makeNbfConfig() {
  return makeNaxConfig({
    quality: { autofix: { enabled: true } },
    execution: { rectification: { enabled: true, maxAttemptsTotal: 3 } },
    review: {
      adversarial: {
        model: "balanced",
        diffMode: "ref",
        rules: [],
        timeoutMs: 600_000,
        parallel: false,
        maxConcurrentSessions: 2,
        nonBlockingFix: { enabled: true, scope: "both", regressionAttempts: 1, verifierGuard: false, sourceDiffCap: { maxFiles: 10, maxLines: 500 } },
      },
    },
  });
}

function makeNbfCtx(packageDir: string, config = makeNbfConfig()) {
  runtime = makeTestRuntime({ config });
  return {
    runtime,
    packageView: runtime!.packages.repo(),
    packageDir,
    agentName: "claude",
    storyId: "US-nbf",
  } as ReturnType<typeof makeMockCallContext>;
}

function makeNbfInputs(story: ReturnType<typeof makeStory>, packageDir: string, config = makeNbfConfig()) {
  return makeMockPlanInputs({
    story,
    implementer: { story },
    fullSuiteGate: { story, workdir: packageDir },
    adversarialReview: {
      workdir: packageDir,
      story,
      adversarialConfig: config.review.adversarial!,
      mode: config.review.adversarial!.diffMode,
    },
    rectification: { maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-NBF1: mock_structure handoff during nbf → test-writer picks it up
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-NBF1: nbf cycle drains nbSink — test-writer receives mock-structure handoff", () => {
  test(
    "AC-NBF1: after extractApplied + nbPostValidate, autofix-test-writer appliesTo returns true",
    async () => {
      await withTempDir(async (tmpDir) => {
        const testFilePath = join(tmpDir, "test/unit/service.test.ts");
        await mkdir(dirname(testFilePath), { recursive: true });
        await Bun.write(testFilePath, "// test file for nbf integration test");

        const story = makeStory({ id: "US-nbf1", attempts: 1 });
        const config = makeNbfConfig();
        const ctx = makeNbfCtx(tmpDir, config);
        const inputs = makeNbfInputs(story, tmpDir, config);

        // All phases pass; adversarial review emits advisory findings (no blocking).
        _storyOrchestratorDeps.callOp = mock(async (_ctx, op) => {
          if (op.name === "adversarial-review") {
            return { passed: true, blockingFindings: [], advisoryFindings: [makeAdvisoryFinding()] };
          }
          return { success: true };
        }) as typeof _storyOrchestratorDeps.callOp;

        // Capture the FixCycle constructed by runRectification for the nbf path.
        // The main rectification has no findings (all phases pass), so runFixCycle
        // is called exactly once — from the nbf path.
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

        // The nbf cycle contains the full-suite-rectify strategy.
        const fullSuiteStrategy = capturedCycle!.strategies.find((s) => s.name === "full-suite-rectify");
        expect(fullSuiteStrategy).toBeDefined();

        // Simulate the strategy emitting a mock_structure declaration.
        const mockOutput: FullSuiteRectifyOutput = {
          applied: true,
          testEditDeclarations: [
            {
              reason: "mock_structure",
              file: "test/unit/service.test.ts",
              files: ["test/unit/service.test.ts"],
              reasonDetail: "Mock setup needs restructuring in nbf cycle",
            },
          ],
        };
        const mockInput: FullSuiteRectifyInput = { story, findings: [] };
        await fullSuiteStrategy!.extractApplied!(mockOutput as any, mockInput as any);

        _storyOrchestratorDeps.callOp = mock(async () => ({ success: true })) as typeof _storyOrchestratorDeps.callOp;

        // Call validate — this triggers nbPostValidate which drains nbSink (#1227 fix).
        await capturedCycle!.validate(capturedCycleCtx!, {
          mode: "full",
          strategiesRun: ["full-suite-rectify"],
        });

        // AC-NBF1: autofix-test-writer must apply now that nbSink.mockHandoffs is populated.
        const testWriterStrategy = capturedCycle!.strategies.find((s) => s.name === "autofix-test-writer");
        expect(testWriterStrategy).toBeDefined();

        const dummyFinding: Finding = { source: "lint", severity: "error", category: "style", message: "dummy" };
        expect(testWriterStrategy!.appliesTo(dummyFinding)).toBe(true);

        const builtInput = testWriterStrategy!.buildInput([dummyFinding], [], capturedCycleCtx!);
        expect((builtInput as any).mode).toBe("mock-restructure");
        expect((builtInput as any).handoffFiles).toContain("test/unit/service.test.ts");
      });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-NBF2: nbf cycle validate uses nbPostValidate (bound to nbSink, not main sink)
// ─────────────────────────────────────────────────────────────────────────────
//
// Symmetric complement to AC-NBF1: when nbSink is empty, nbPostValidate is a
// no-op, so the autofix-test-writer does not become eligible after validate.
//
// This verifies the fix routing: overrides?.postValidate ?? rectification.postValidate
// selects nbPostValidate for the nbf cycle.  If the old code ran rectification.postValidate
// (draining the empty main sink) instead, the result is identical in this scenario — so
// the value of the test is catching any future regression that wires a non-empty sink
// through the wrong postValidate.

describe("AC-NBF2: nbf cycle validate uses nbPostValidate bound to nbSink", () => {
  test(
    "AC-NBF2: empty nbSink → nbPostValidate is a no-op → autofix-test-writer does not apply",
    async () => {
      await withTempDir(async (tmpDir) => {
        const testFilePath = join(tmpDir, "test/unit/service.test.ts");
        await mkdir(dirname(testFilePath), { recursive: true });
        await Bun.write(testFilePath, "// test file for AC-NBF2");

        const story = makeStory({ id: "US-nbf2", attempts: 1 });
        const config = makeNbfConfig();
        const ctx = makeNbfCtx(tmpDir, config);
        const inputs = makeNbfInputs(story, tmpDir, config);

        // Gate passes on all calls → main rect does not fire.
        // Adversarial review emits advisory findings → only the NBF cycle fires.
        // (When gate fails the main loop short-circuits before adversarial-review
        //  runs, so advisory findings are never set and NBF never fires — hence
        //  we keep gate green for this test.)
        _storyOrchestratorDeps.callOp = mock(async (_ctx, op) => {
          if (op.name === "adversarial-review") {
            return { passed: true, blockingFindings: [], advisoryFindings: [makeAdvisoryFinding()] };
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

        // Only the NBF cycle should have fired.
        expect(capturedCycle).not.toBeNull();
        expect(capturedCycleCtx).not.toBeNull();

        _storyOrchestratorDeps.callOp = mock(async () => ({ success: true })) as typeof _storyOrchestratorDeps.callOp;

        // Call validate without injecting anything into nbSink.
        await capturedCycle!.validate(capturedCycleCtx!, {
          mode: "full",
          strategiesRun: ["full-suite-rectify"],
        });

        // AC-NBF2: empty nbSink → nbPostValidate is a no-op → test-writer must not apply.
        const testWriterStrategy = capturedCycle!.strategies.find((s) => s.name === "autofix-test-writer");
        expect(testWriterStrategy).toBeDefined();
        const dummyFinding: Finding = { source: "lint", severity: "error", category: "style", message: "dummy" };
        expect(testWriterStrategy!.appliesTo(dummyFinding)).toBe(false);
      });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-NBF3: invalid mock_structure in nbf cycle → no unclaimable finding minted (#1327)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-NBF3: invalid mock_structure in nbf cycle → diagnostic only, no unclaimable finding", () => {
  test(
    "AC-NBF3: nbPostValidate mints no finding when declared test file does not exist",
    async () => {
      const packageDir = "/tmp/nax-test-nbf-ac3-nonexistent";
      const story = makeStory({ id: "US-nbf3", attempts: 1 });
      const config = makeNbfConfig();
      const ctx = makeNbfCtx(packageDir, config);
      const inputs = makeNbfInputs(story, packageDir, config);

      _storyOrchestratorDeps.callOp = mock(async (_ctx, op) => {
        if (op.name === "adversarial-review") {
          return { passed: true, blockingFindings: [], advisoryFindings: [makeAdvisoryFinding()] };
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

      // Declare a mock_structure referencing a file that does not exist.
      const invalidOutput: FullSuiteRectifyOutput = {
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
      await fullSuiteStrategy!.extractApplied!(invalidOutput as any, mockInput as any);

      const testWriterStrategy = capturedCycle!.strategies.find((s) => s.name === "autofix-test-writer");
      expect(testWriterStrategy).toBeDefined();
      const dummyFinding: Finding = { source: "lint", severity: "error", category: "style", message: "dummy" };

      // Precondition: extractApplied populated nbSink, so the test-writer claims
      // via its `sink.mockHandoffs.length > 0` clause. This also proves the
      // captured cycle is the nbf one (it shares nbSink). Without it, the
      // assertions below would also hold on nbPostValidate's early-return path.
      expect(testWriterStrategy!.appliesTo(dummyFinding)).toBe(true);

      _storyOrchestratorDeps.callOp = mock(async () => ({ success: true })) as typeof _storyOrchestratorDeps.callOp;

      const validateResult = await capturedCycle!.validate(capturedCycleCtx!, {
        mode: "full",
        strategiesRun: ["full-suite-rectify"],
      });

      const findings = Array.isArray(validateResult) ? validateResult : validateResult.findings;

      // nbPostValidate reached the validation branch and rejected the handoff:
      // nbSink is drained, so the test-writer no longer claims.
      expect(testWriterStrategy!.appliesTo(dummyFinding)).toBe(false);

      // AC-NBF3 (#1327): the rejected handoff is reported as a log diagnostic, not
      // appended as a finding. An appended advisory is claimed by no nbf strategy,
      // so the cycle would exit "no-strategy" on a story whose every phase passed.
      expect(findings).toEqual([]);
    },
  );
});
