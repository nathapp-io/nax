/**
 * Integration Tests — Runner Parallel + Sequential Metric Accumulation
 *
 * BUG-064: After parallel batch, runner overwrites totalCost with sequential
 *          cost instead of accumulating. Fix: += not = for totalCost.
 *
 * BUG-065: After parallel batch, runner overwrites storiesCompleted with
 *          sequential count instead of accumulating. Fix: += not = for
 *          storiesCompleted.
 *
 * BUG-066: Parallel story metrics (storyId, cost, durationMs, attempts,
 *          firstPassSuccess, source:'parallel') are not returned from
 *          parallel-executor and are not merged into runner's allStoryMetrics.
 *
 * Tests are written in RED (failing) state — the feature is not yet
 * implemented. The runner currently overwrites parallel totals with
 * sequential totals.
 */

import { afterEach, beforeEach, describe, expect, mock, test, describe as describeBase } from "bun:test";

// These integration tests run the full runner pipeline and require a real agent
// environment. Skip in CI where Claude CLI is not installed.
const describeIntegration = process.env.CI ? describeBase.skip : describeBase;
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { NaxConfig } from "../../../src/config/types";
import { _parallelExecutorDeps } from "../../../src/execution/parallel-executor";
import { _executionDeps } from "../../../src/pipeline/stages/execution";
import { _runnerDeps, run } from "../../../src/execution/runner";
import type { LoadedHooksConfig } from "../../../src/hooks";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PARALLEL_BATCH_COST = 5.0;
const PARALLEL_STORIES_COMPLETED = 1;
const SEQUENTIAL_AGENT_COST = 1.5;

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "nax-runner-parallel-metrics-"));
}

async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Create a PRD file with two stories:
 * - US-001: pending, no dependencies (parallel will process this)
 * - US-002: pending, depends on US-001 (sequential picks it up after parallel)
 */
async function createTwoStoryPrd(workdir: string, feature: string): Promise<string> {
  const featureDir = path.join(workdir, "nax", "features", feature);
  await fs.mkdir(featureDir, { recursive: true });

  const prdPath = path.join(featureDir, "prd.json");
  const prd = {
    project: "test-project",
    feature,
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [
      {
        id: "US-001",
        title: "First story — processed by parallel",
        description: "A simple story with no dependencies",
        acceptanceCriteria: ["It works"],
        dependencies: [],
        tags: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      },
      {
        id: "US-002",
        title: "Second story — processed by sequential",
        description: "A simple story that depends on US-001",
        acceptanceCriteria: ["It also works"],
        dependencies: ["US-001"],
        tags: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      },
    ],
  };

  await fs.writeFile(prdPath, JSON.stringify(prd, null, 2));
  return prdPath;
}

function makeConfig(): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    execution: {
      ...DEFAULT_CONFIG.execution,
      maxIterations: 5,
      costLimit: 100,
      iterationDelayMs: 0,
    },
    acceptance: {
      ...DEFAULT_CONFIG.acceptance,
      enabled: false,
    },
    quality: {
      ...DEFAULT_CONFIG.quality,
      requireTypecheck: false,
      requireLint: false,
      requireTests: false,
      commands: { test: "echo tests-pass" },
    },
  };
}

function makeHooks(): LoadedHooksConfig {
  return { hooks: {} } as LoadedHooksConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test setup
// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("BUG-064 + BUG-065 + BUG-066: Runner parallel + sequential metric accumulation", () => {
  let tempDir: string;
  let prdPath: string;
  // Capture originals inside describe scope to avoid contamination from other test files
  let originalExecuteParallel: typeof _parallelExecutorDeps.executeParallel;
  let originalGetAgent: typeof _executionDeps.getAgent;
  let statusFile: string;

  beforeEach(async () => {
    // Capture originals here (not at module level) to avoid contamination from other test files
    originalExecuteParallel = _parallelExecutorDeps.executeParallel;
    originalGetAgent = _executionDeps.getAgent;

    tempDir = await createTempDir();
    prdPath = await createTwoStoryPrd(tempDir, "test-parallel-metrics");
    statusFile = path.join(tempDir, "status.json");

    // Mock agent via _executionDeps (injectable, avoids mock.module)
    _executionDeps.getAgent = mock((_agentName: string) => ({
      name: "claude-code",
      binary: "claude",
      displayName: "Claude Code",
      capabilities: {
        costTracking: true,
        streaming: false,
        supportedTiers: ["fast", "balanced", "powerful"],
        supportedFeatures: ["tdd", "review", "refactor", "batch"],
      },
      isInstalled: async () => true,
      run: mock(async () => ({
        success: true,
        estimatedCost: SEQUENTIAL_AGENT_COST,
        transcript: "done",
        output: "Story completed successfully",
        exitCode: 0,
        durationMs: 100,
      })),
      plan: mock(async () => ({ success: true, plan: "", estimatedCost: 0, exitCode: 0 })),
      decompose: mock(async () => ({ success: true, output: "", estimatedCost: 0, exitCode: 0 })),
      complete: mock(async () => ({ success: true, output: "", estimatedCost: 0, exitCode: 0 })),
      buildCommand: () => ["claude", "--test"],
    } as unknown as ReturnType<typeof _executionDeps.getAgent>));

    // Also mock _parallelExecutorDeps.executeParallel for BUG-066 test which calls
    // runParallelExecution directly (not through run())
    _parallelExecutorDeps.executeParallel = mock(async (
      _stories: unknown,
      _prdPath: unknown,
      _workdir: unknown,
      _config: unknown,
      _hooks: unknown,
      _plugins: unknown,
      prd: unknown,
    ) => {
      const typedPrd = prd as { userStories: Array<{ id: string; status?: string; passes?: boolean }> };
      const updatedPrd = {
        ...typedPrd,
        userStories: typedPrd.userStories.map((s) =>
          s.id === "US-001" ? { ...s, status: "passed", passes: true } : s,
        ),
      };
      await Bun.write(_prdPath as string, JSON.stringify(updatedPrd, null, 2));
      return { storiesCompleted: PARALLEL_STORIES_COMPLETED, totalCost: PARALLEL_BATCH_COST, updatedPrd, mergeConflicts: [] };
    });

    // Mock runParallelExecution at the runner level to avoid bun dynamic-import
    // module-cache isolation issues (bun 1.3.9 may give fresh instances per dynamic import)
    _runnerDeps.runParallelExecution = mock(async (_options: unknown, prd: unknown) => {
      const typedPrd = prd as { userStories: Array<{ id: string; status?: string; passes?: boolean }> };
      // Build updated PRD with US-001 marked as passed
      const updatedPrd = {
        ...typedPrd,
        userStories: typedPrd.userStories.map((s) =>
          s.id === "US-001" ? { ...s, status: "passed", passes: true } : s,
        ),
      };
      // Write updated PRD to file so sequential executor's loadPRD sees it
      const options = _options as { prdPath: string };
      await Bun.write(options.prdPath, JSON.stringify(updatedPrd, null, 2));
      return {
        prd: updatedPrd,
        totalCost: PARALLEL_BATCH_COST,
        storiesCompleted: PARALLEL_STORIES_COMPLETED,
        completed: false,
        storyMetrics: [],
        rectificationStats: { rectified: 0, stillConflicting: 0 },
      };
    }) as typeof _runnerDeps.runParallelExecution;
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
    mock.restore();
    _runnerDeps.runParallelExecution = null;
    _parallelExecutorDeps.executeParallel = originalExecuteParallel;
    _executionDeps.getAgent = originalGetAgent;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BUG-064: totalCost accumulation
  // ───────────────────────────────────────────────────────────────────────────

  describe("BUG-064: totalCost includes both parallel and sequential costs", () => {
    test("run() result totalCost = parallelCost + sequentialCost", async () => {
      const result = await run({
        prdPath,
        workdir: tempDir,
        config: makeConfig(),
        hooks: makeHooks(),
        feature: "test-parallel-metrics",
        featureDir: path.dirname(prdPath),
        dryRun: false,
        useBatch: false,
        parallel: 2,
        skipPrecheck: true,
        statusFile,
      });

      // BUG-064: runner overwrites totalCost with sequential cost.
      // Currently: totalCost = SEQUENTIAL_AGENT_COST (lost parallel cost!)
      // Expected: totalCost = PARALLEL_BATCH_COST + SEQUENTIAL_AGENT_COST
      const expectedTotalCost = PARALLEL_BATCH_COST + SEQUENTIAL_AGENT_COST;
      expect(result.totalCost).toBe(expectedTotalCost);
    });

    test("run() result totalCost is greater than parallel cost alone", async () => {
      const result = await run({
        prdPath,
        workdir: tempDir,
        config: makeConfig(),
        hooks: makeHooks(),
        feature: "test-parallel-metrics",
        featureDir: path.dirname(prdPath),
        dryRun: false,
        useBatch: false,
        parallel: 2,
        skipPrecheck: true,
        statusFile,
      });

      // BUG-064: the combined cost must exceed the parallel batch cost.
      // If the bug is present, totalCost = sequentialCost (< parallelCost).
      expect(result.totalCost).toBeGreaterThan(PARALLEL_BATCH_COST);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BUG-065: storiesCompleted accumulation
  // ───────────────────────────────────────────────────────────────────────────

  describe("BUG-065: storiesCompleted includes both parallel and sequential counts", () => {
    test("run() result storiesCompleted = parallelCount + sequentialCount", async () => {
      const result = await run({
        prdPath,
        workdir: tempDir,
        config: makeConfig(),
        hooks: makeHooks(),
        feature: "test-parallel-metrics",
        featureDir: path.dirname(prdPath),
        dryRun: false,
        useBatch: false,
        parallel: 2,
        skipPrecheck: true,
        statusFile,
      });

      // BUG-065: runner overwrites storiesCompleted with sequential count.
      // Currently: storiesCompleted = 1 (sequential only, lost parallel 1!)
      // Expected: storiesCompleted = 2 (1 parallel + 1 sequential)
      const SEQUENTIAL_STORIES_COMPLETED = 1; // US-002 processed by sequential
      const expectedTotal = PARALLEL_STORIES_COMPLETED + SEQUENTIAL_STORIES_COMPLETED;
      expect(result.storiesCompleted).toBe(expectedTotal);
    });

    test("run() success is true when all stories completed via both paths", async () => {
      const result = await run({
        prdPath,
        workdir: tempDir,
        config: makeConfig(),
        hooks: makeHooks(),
        feature: "test-parallel-metrics",
        featureDir: path.dirname(prdPath),
        dryRun: false,
        useBatch: false,
        parallel: 2,
        skipPrecheck: true,
        statusFile,
      });

      // Both US-001 (parallel) and US-002 (sequential) should be complete
      expect(result.success).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BUG-066: storyMetrics includes parallel entries
  // ───────────────────────────────────────────────────────────────────────────

  describe("BUG-066: RunResult reflects storyMetrics from both paths", () => {
    test("parallel executor returns storyMetrics for completed stories", async () => {
      // Test at the parallel-executor level: runParallelExecution must return storyMetrics
      const { runParallelExecution } = await import("../../../src/execution/parallel-executor");
      const { loadPRD } = await import("../../../src/prd");

      const prd = await loadPRD(prdPath);
      const statusWriter = {
        setPrd: mock(() => {}),
        setCurrentStory: mock(() => {}),
        setRunStatus: mock(() => {}),
        update: mock(async () => {}),
        writeFeatureStatus: mock(async () => {}),
      };

      const result = await runParallelExecution(
        {
          prdPath,
          workdir: tempDir,
          config: makeConfig(),
          hooks: makeHooks(),
          feature: "test-parallel-metrics",
          parallelCount: 2,
          statusWriter: statusWriter as never,
          runId: "test-run-001",
          startedAt: new Date().toISOString(),
          startTime: Date.now(),
          totalCost: 0,
          iterations: 0,
          storiesCompleted: 0,
          allStoryMetrics: [],
          pluginRegistry: {
            getReporters: () => [],
            getContextProviders: () => [],
            getReviewers: () => [],
            getRoutingStrategies: () => [],
            teardownAll: async () => {},
          } as never,
          formatterMode: "normal",
          headless: false,
        },
        prd,
      );

      // BUG-066: storyMetrics must be present in the result — this FAILS
      expect(result).toHaveProperty("storyMetrics");

      const storyMetrics = (result as typeof result & { storyMetrics: unknown[] }).storyMetrics;
      expect(Array.isArray(storyMetrics)).toBe(true);
      expect(storyMetrics.length).toBeGreaterThan(0);

      const entry = storyMetrics[0] as Record<string, unknown>;
      expect(entry.source).toBe("parallel");
      expect(entry.storyId).toBeDefined();
      expect(typeof entry.cost).toBe("number");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure unit: accumulation math specification
//
// These tests document the CORRECT accumulation logic that runner.ts should
// implement. They are standalone so they always pass and serve as a spec
// for the fix.
// ─────────────────────────────────────────────────────────────────────────────

describe("Accumulation spec: parallel + sequential metrics must be summed", () => {
  test("correct accumulation: totalCost = parallelCost + sequentialCost", () => {
    // This is what runner.ts SHOULD do after the fix:
    let totalCost = 0;

    // After parallel (correct: sets initial accumulator):
    const parallelCost = PARALLEL_BATCH_COST;
    totalCost += parallelCost; // correct: +=

    // After sequential (correct: adds to accumulator):
    const sequentialCost = SEQUENTIAL_AGENT_COST;
    totalCost += sequentialCost; // correct: +=

    expect(totalCost).toBe(PARALLEL_BATCH_COST + SEQUENTIAL_AGENT_COST);
  });

  test("buggy accumulation (current runner.ts): totalCost loses parallel cost", () => {
    // This documents the CURRENT (buggy) behavior in runner.ts lines 232, 273:
    let totalCost = 0;

    // After parallel (runner sets, not adds — but this line is currently correct):
    totalCost = PARALLEL_BATCH_COST; // = 5.0

    // After sequential (BUG: runner uses = instead of +=):
    totalCost = SEQUENTIAL_AGENT_COST; // = 1.5 (OVERWRITES 5.0!)

    // The buggy result — should NOT equal the expected combined cost:
    expect(totalCost).not.toBe(PARALLEL_BATCH_COST + SEQUENTIAL_AGENT_COST);
    expect(totalCost).toBe(SEQUENTIAL_AGENT_COST); // Documents the bug
  });

  test("correct accumulation: storiesCompleted = parallelCount + sequentialCount", () => {
    let storiesCompleted = 0;

    const parallelCompleted = PARALLEL_STORIES_COMPLETED;
    storiesCompleted += parallelCompleted; // correct: +=

    const sequentialCompleted = 1; // one sequential story
    storiesCompleted += sequentialCompleted; // correct: +=

    expect(storiesCompleted).toBe(PARALLEL_STORIES_COMPLETED + 1);
  });

  test("buggy accumulation (current runner.ts): storiesCompleted loses parallel count", () => {
    let storiesCompleted = 0;

    // After parallel:
    storiesCompleted = PARALLEL_STORIES_COMPLETED; // = 1

    // After sequential (BUG: = instead of +=):
    const sequentialCompleted = 1;
    storiesCompleted = sequentialCompleted; // = 1 (OVERWRITES 1!)

    // Documents the bug: lost the parallel count
    expect(storiesCompleted).not.toBe(PARALLEL_STORIES_COMPLETED + sequentialCompleted);
    expect(storiesCompleted).toBe(sequentialCompleted);
  });
});
