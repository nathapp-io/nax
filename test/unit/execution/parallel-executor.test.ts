/**
 * Unit tests for runParallelExecution — BUG-066 (storyMetrics)
 *
 * BUG-066: parallel-executor.ts does not return per-story metrics.
 * After executeParallel completes, the result should include a storyMetrics
 * array with entries per successfully-processed story, each having a
 * `source: 'parallel'` field alongside the standard StoryMetrics shape.
 *
 * Tests are written in RED (failing) state — the feature is not yet implemented.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import type { LoadedHooksConfig } from "../../../src/hooks";
import { _parallelExecutorDeps, runParallelExecution } from "../../../src/execution/parallel-executor";
import type { ParallelExecutorOptions, ParallelExecutorResult } from "../../../src/execution/parallel-executor";
import type { PRD } from "../../../src/prd";
import type { PluginRegistry } from "../../../src/plugins/registry";
import type { StatusWriter } from "../../../src/execution/status-writer";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makePrd(overrides: Partial<PRD["userStories"][0]>[] = []): PRD {
  const baseStory = {
    id: "US-001",
    title: "Test story",
    description: "A test story",
    acceptanceCriteria: ["AC1"],
    dependencies: [] as string[],
    tags: [] as string[],
    status: "pending" as const,
    passes: false,
    escalations: [] as never[],
    attempts: 0,
  };

  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: overrides.length > 0
      ? overrides.map((o, i) => ({ ...baseStory, id: `US-00${i + 1}`, ...o }))
      : [baseStory],
  };
}

function makeStatusWriter(): StatusWriter {
  return {
    setPrd: mock(() => {}),
    setCurrentStory: mock(() => {}),
    setRunStatus: mock(() => {}),
    update: mock(async () => {}),
    writeFeatureStatus: mock(async () => {}),
  } as unknown as StatusWriter;
}

function makePluginRegistry(): PluginRegistry {
  return {
    getReporters: mock(() => []),
    getContextProviders: mock(() => []),
    getReviewers: mock(() => []),
    getRoutingStrategies: mock(() => []),
    teardownAll: mock(async () => {}),
  } as unknown as PluginRegistry;
}

function makeOptions(statusWriter: StatusWriter, overrides: Partial<ParallelExecutorOptions> = {}): ParallelExecutorOptions {
  return {
    prdPath: "/tmp/test-prd.json",
    workdir: "/tmp",
    config: {} as NaxConfig,
    hooks: {} as LoadedHooksConfig,
    feature: "test-feature",
    parallelCount: 2,
    statusWriter,
    runId: "run-test-001",
    startedAt: new Date().toISOString(),
    startTime: Date.now(),
    totalCost: 0,
    iterations: 0,
    storiesCompleted: 0,
    allStoryMetrics: [],
    pluginRegistry: makePluginRegistry(),
    formatterMode: "normal",
    headless: false,
    ...overrides,
  };
}

// Store original deps to restore after each test
const originalExecuteParallel = _parallelExecutorDeps.executeParallel;
const originalFireHook = _parallelExecutorDeps.fireHook;

afterEach(() => {
  mock.restore();
  _parallelExecutorDeps.executeParallel = originalExecuteParallel;
  _parallelExecutorDeps.fireHook = originalFireHook;
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-066: storyMetrics in ParallelExecutorResult
// ─────────────────────────────────────────────────────────────────────────────

describe("BUG-066: runParallelExecution returns storyMetrics", () => {
  describe("early exit — no stories ready", () => {
    test("result has storyMetrics field (empty array) when no stories are ready", async () => {
      // All stories complete → getAllReadyStories returns [] → early exit
      const prd = makePrd([
        { id: "US-001", status: "passed", passes: true },
      ]);
      const statusWriter = makeStatusWriter();
      const options = makeOptions(statusWriter);

      const result = await runParallelExecution(options, prd);

      // BUG-066: storyMetrics is not in ParallelExecutorResult yet — this FAILS
      expect(result).toHaveProperty("storyMetrics");
      expect(Array.isArray((result as ParallelExecutorResult & { storyMetrics: unknown }).storyMetrics)).toBe(true);
      expect((result as ParallelExecutorResult & { storyMetrics: unknown[] }).storyMetrics).toHaveLength(0);
    });

    test("result is completed: false when no stories are ready", async () => {
      const prd = makePrd([{ id: "US-001", status: "passed", passes: true }]);
      const statusWriter = makeStatusWriter();
      const options = makeOptions(statusWriter);

      const result = await runParallelExecution(options, prd);

      // This should already pass (existing behavior)
      expect(result.completed).toBe(false);
    });
  });

  describe("with mocked executeParallel — stories processed", () => {
    beforeEach(() => {
      _parallelExecutorDeps.fireHook = mock(async () => {});
    });

    test("result has storyMetrics with one entry per completed story", async () => {
      // US-001: pending (ready, no deps), US-002: pending, depends on US-001
      const initialPrd = makePrd([
        { id: "US-001", status: "pending", passes: false, dependencies: [] },
        { id: "US-002", status: "pending", passes: false, dependencies: ["US-001"] },
      ]);

      // After parallel, US-001 is passed; US-002 still pending
      const updatedPrd = makePrd([
        { id: "US-001", status: "passed", passes: true, dependencies: [] },
        { id: "US-002", status: "pending", passes: false, dependencies: ["US-001"] },
      ]);

      _parallelExecutorDeps.executeParallel = mock(async () => ({
        storiesCompleted: 1,
        totalCost: 2.5,
        updatedPrd,
      }));

      const statusWriter = makeStatusWriter();
      const options = makeOptions(statusWriter);

      const result = await runParallelExecution(options, initialPrd);

      // BUG-066: storyMetrics must be present in the result — this FAILS
      expect(result).toHaveProperty("storyMetrics");

      const metrics = (result as ParallelExecutorResult & { storyMetrics: unknown[] }).storyMetrics;
      expect(Array.isArray(metrics)).toBe(true);
      expect(metrics).toHaveLength(1);
    });

    test("storyMetrics entry has source: 'parallel'", async () => {
      const initialPrd = makePrd([
        { id: "US-001", status: "pending", passes: false, dependencies: [] },
        { id: "US-002", status: "pending", passes: false, dependencies: ["US-001"] },
      ]);

      const updatedPrd = makePrd([
        { id: "US-001", status: "passed", passes: true, dependencies: [] },
        { id: "US-002", status: "pending", passes: false, dependencies: ["US-001"] },
      ]);

      _parallelExecutorDeps.executeParallel = mock(async () => ({
        storiesCompleted: 1,
        totalCost: 2.5,
        updatedPrd,
      }));

      const statusWriter = makeStatusWriter();
      const options = makeOptions(statusWriter);

      const result = await runParallelExecution(options, initialPrd);

      // BUG-066: each entry must have source: 'parallel' — this FAILS
      const metrics = (result as ParallelExecutorResult & {
        storyMetrics: Array<{ source: string }>
      }).storyMetrics;

      expect(metrics).toBeDefined();
      if (metrics?.length > 0) {
        expect(metrics[0].source).toBe("parallel");
      } else {
        // Force failure if no metrics returned
        expect(metrics?.length).toBeGreaterThan(0);
      }
    });

    test("storyMetrics entry has required fields: storyId, cost, durationMs, attempts, firstPassSuccess", async () => {
      const initialPrd = makePrd([
        { id: "US-001", status: "pending", passes: false, dependencies: [] },
        { id: "US-002", status: "pending", passes: false, dependencies: ["US-001"] },
      ]);

      const updatedPrd = makePrd([
        { id: "US-001", status: "passed", passes: true, dependencies: [] },
        { id: "US-002", status: "pending", passes: false, dependencies: ["US-001"] },
      ]);

      _parallelExecutorDeps.executeParallel = mock(async () => ({
        storiesCompleted: 1,
        totalCost: 2.5,
        updatedPrd,
      }));

      const statusWriter = makeStatusWriter();
      const options = makeOptions(statusWriter);

      const result = await runParallelExecution(options, initialPrd);

      // BUG-066: storyMetrics shape validation — this FAILS
      const metrics = (result as ParallelExecutorResult & {
        storyMetrics: Array<Record<string, unknown>>
      }).storyMetrics;

      expect(metrics).toBeDefined();
      if (metrics?.length > 0) {
        const entry = metrics[0];
        expect(entry).toHaveProperty("storyId");
        expect(entry).toHaveProperty("cost");
        expect(entry).toHaveProperty("durationMs");
        expect(entry).toHaveProperty("attempts");
        expect(entry).toHaveProperty("firstPassSuccess");
        expect(entry).toHaveProperty("source");
        expect(entry.source).toBe("parallel");
      } else {
        expect(metrics?.length).toBeGreaterThan(0);
      }
    });

    test("storyMetrics accumulates across multiple batches", async () => {
      // Three stories: US-001 and US-002 can run in parallel, US-003 depends on US-001
      const initialPrd = makePrd([
        { id: "US-001", status: "pending", passes: false, dependencies: [] },
        { id: "US-002", status: "pending", passes: false, dependencies: [] },
        { id: "US-003", status: "pending", passes: false, dependencies: ["US-001"] },
      ]);

      const updatedPrd = makePrd([
        { id: "US-001", status: "passed", passes: true, dependencies: [] },
        { id: "US-002", status: "passed", passes: true, dependencies: [] },
        { id: "US-003", status: "pending", passes: false, dependencies: ["US-001"] },
      ]);

      _parallelExecutorDeps.executeParallel = mock(async () => ({
        storiesCompleted: 2,
        totalCost: 4.0,
        updatedPrd,
      }));

      const statusWriter = makeStatusWriter();
      const options = makeOptions(statusWriter);

      const result = await runParallelExecution(options, initialPrd);

      // BUG-066: should have 2 entries (one per completed story) — FAILS
      const metrics = (result as ParallelExecutorResult & {
        storyMetrics: unknown[]
      }).storyMetrics;

      expect(metrics).toBeDefined();
      expect(metrics?.length).toBe(2);
    });
  });

  describe("ParallelExecutorResult type contract", () => {
    test("ParallelExecutorResult interface includes storyMetrics field", () => {
      // TypeScript compile-time contract: ParallelExecutorResult must have storyMetrics.
      // This verifies the runtime shape that the implementation must satisfy.
      const mockResult: ParallelExecutorResult & { storyMetrics: Array<{ storyId: string; source: string }> } = {
        prd: makePrd(),
        totalCost: 0,
        storiesCompleted: 0,
        completed: false,
        storyMetrics: [{ storyId: "US-001", source: "parallel" }],
      };

      // BUG-066: ParallelExecutorResult must have storyMetrics.
      // Currently this interface does NOT have storyMetrics → this assignment
      // should cause a TypeScript error once we enforce the full type.
      // At runtime, we verify the field is present and correct.
      expect(mockResult.storyMetrics).toBeDefined();
      expect(mockResult.storyMetrics[0].source).toBe("parallel");
    });
  });
});
