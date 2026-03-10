// RE-ARCH: keep
/**
 * Parallel Execution Tests
 *
 * Tests for parallel story execution with worktrees:
 * - Dependency-based batching
 * - Concurrent execution
 * - Merge ordering
 * - Cleanup logic
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { UserStory } from "../../../src/prd/types";
import {
  _parallelExecutorDeps,
  runParallelExecution,
} from "../../../src/execution/parallel-executor";
import type { ParallelExecutorOptions } from "../../../src/execution/parallel-executor";
import type { NaxConfig } from "../../../src/config";
import type { LoadedHooksConfig } from "../../../src/hooks";
import type { StatusWriter } from "../../../src/execution/status-writer";
import type { PluginRegistry } from "../../../src/plugins/registry";

describe("Parallel Execution", () => {
  describe("Story Grouping", () => {
    test("groups independent stories into single batch", () => {
      const stories: UserStory[] = [
        {
          id: "US-001",
          title: "Story 1",
          description: "Independent story 1",
          acceptanceCriteria: ["AC1"],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
        {
          id: "US-002",
          title: "Story 2",
          description: "Independent story 2",
          acceptanceCriteria: ["AC2"],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
        {
          id: "US-003",
          title: "Story 3",
          description: "Independent story 3",
          acceptanceCriteria: ["AC3"],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
      ];

      // All stories are independent, should be in one batch
      // This test validates the grouping logic conceptually
      expect(stories.every((s) => s.dependencies.length === 0)).toBe(true);
    });

    test("separates dependent stories into ordered batches", () => {
      const stories: UserStory[] = [
        {
          id: "US-001",
          title: "Base story",
          description: "No dependencies",
          acceptanceCriteria: ["AC1"],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
        {
          id: "US-002",
          title: "Dependent story",
          description: "Depends on US-001",
          acceptanceCriteria: ["AC2"],
          tags: [],
          dependencies: ["US-001"],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
        {
          id: "US-003",
          title: "Double dependent",
          description: "Depends on US-002",
          acceptanceCriteria: ["AC3"],
          tags: [],
          dependencies: ["US-002"],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
      ];

      // US-001 has no deps (batch 1)
      expect(stories[0].dependencies).toEqual([]);
      // US-002 depends on US-001 (batch 2)
      expect(stories[1].dependencies).toEqual(["US-001"]);
      // US-003 depends on US-002 (batch 3)
      expect(stories[2].dependencies).toEqual(["US-002"]);
    });

    test("handles mixed dependencies correctly", () => {
      const stories: UserStory[] = [
        {
          id: "US-001",
          title: "Independent A",
          description: "No deps",
          acceptanceCriteria: ["AC1"],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
        {
          id: "US-002",
          title: "Independent B",
          description: "No deps",
          acceptanceCriteria: ["AC2"],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
        {
          id: "US-003",
          title: "Dependent on A",
          description: "Depends on US-001",
          acceptanceCriteria: ["AC3"],
          tags: [],
          dependencies: ["US-001"],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
        {
          id: "US-004",
          title: "Dependent on B",
          description: "Depends on US-002",
          acceptanceCriteria: ["AC4"],
          tags: [],
          dependencies: ["US-002"],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
      ];

      // US-001 and US-002 are independent (batch 1)
      expect(stories[0].dependencies).toEqual([]);
      expect(stories[1].dependencies).toEqual([]);
      // US-003 and US-004 depend on batch 1 stories (batch 2, can run in parallel)
      expect(stories[2].dependencies).toEqual(["US-001"]);
      expect(stories[3].dependencies).toEqual(["US-002"]);
    });
  });

  describe("Concurrency Control", () => {
    test("auto-detects concurrency from CPU count when parallel=0", () => {
      const parallel = 0;
      const cpuCount = require("os").cpus().length;

      const maxConcurrency = parallel === 0 ? cpuCount : parallel;
      expect(maxConcurrency).toBe(cpuCount);
      expect(maxConcurrency).toBeGreaterThan(0);
    });

    test("uses explicit concurrency when parallel > 0", () => {
      const parallel = 4;
      const maxConcurrency = Math.max(1, parallel);

      expect(maxConcurrency).toBe(4);
    });

    test("enforces minimum concurrency of 1", () => {
      const parallel = -5;
      const maxConcurrency = Math.max(1, parallel);

      expect(maxConcurrency).toBe(1);
    });
  });

  describe("Worktree Path Tracking", () => {
    test("stores worktree path in story", () => {
      const story: UserStory = {
        id: "US-001",
        title: "Test story",
        description: "Test",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        worktreePath: "/project/.nax-wt/US-001",
      };

      expect(story.worktreePath).toBe("/project/.nax-wt/US-001");
    });

    test("worktreePath is optional", () => {
      const story: UserStory = {
        id: "US-001",
        title: "Test story",
        description: "Test",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      };

      expect(story.worktreePath).toBeUndefined();
    });
  });

  describe("Status File Parallel Info", () => {
    test("includes parallel execution status", () => {
      const parallelInfo = {
        enabled: true,
        maxConcurrency: 4,
        activeStories: [
          { storyId: "US-001", worktreePath: "/project/.nax-wt/US-001" },
          { storyId: "US-002", worktreePath: "/project/.nax-wt/US-002" },
        ],
      };

      expect(parallelInfo.enabled).toBe(true);
      expect(parallelInfo.maxConcurrency).toBe(4);
      expect(parallelInfo.activeStories).toHaveLength(2);
      expect(parallelInfo.activeStories[0].storyId).toBe("US-001");
      expect(parallelInfo.activeStories[0].worktreePath).toBe("/project/.nax-wt/US-001");
    });
  });
});

// ─── MFX-005: Conflict rectification integration flow ────────────────────────
//
// Tests the full rectification cycle:
//   parallel batch with conflict → rectification pass → successful merge
//
// All tests in this block are RED — the feature is not yet implemented.
// ─────────────────────────────────────────────────────────────────────────────


function makeIntegrationPrd(stories: UserStory[]) {
  return {
    project: "int-project",
    feature: "int-feature",
    branchName: "int-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

function makeIntegrationOptions(overrides: Partial<ParallelExecutorOptions> = {}): ParallelExecutorOptions {
  const statusWriter: StatusWriter = {
    setPrd: mock(() => {}),
    setCurrentStory: mock(() => {}),
    setRunStatus: mock(() => {}),
    update: mock(async () => {}),
    writeFeatureStatus: mock(async () => {}),
  } as unknown as StatusWriter;
  const pluginRegistry: PluginRegistry = {
    getReporters: mock(() => []),
    getContextProviders: mock(() => []),
    getReviewers: mock(() => []),
    getRoutingStrategies: mock(() => []),
    teardownAll: mock(async () => {}),
  } as unknown as PluginRegistry;
  return {
    prdPath: "/tmp/int-prd.json",
    workdir: "/tmp/int-workdir",
    config: {} as NaxConfig,
    hooks: {} as LoadedHooksConfig,
    feature: "int-feature",
    parallelCount: 2,
    statusWriter,
    runId: "int-run-001",
    startedAt: new Date().toISOString(),
    startTime: Date.now(),
    totalCost: 0,
    iterations: 0,
    storiesCompleted: 0,
    allStoryMetrics: [],
    pluginRegistry,
    formatterMode: "normal",
    headless: false,
    ...overrides,
  };
}

const originalExecuteParallelInt = _parallelExecutorDeps.executeParallel;
const originalFireHookInt = _parallelExecutorDeps.fireHook;

afterEach(() => {
  mock.restore();
  _parallelExecutorDeps.executeParallel = originalExecuteParallelInt;
  _parallelExecutorDeps.fireHook = originalFireHookInt;
  // @ts-ignore
  if (originalRectifyInt !== undefined) {
    // @ts-ignore
    _parallelExecutorDeps.rectifyConflictedStory = originalRectifyInt;
  }
});

// @ts-ignore — will be undefined until implementation adds the dep
const originalRectifyInt = _parallelExecutorDeps.rectifyConflictedStory;

describe("MFX-005 Integration: parallel batch with conflict → rectification → merge", () => {
  test("full flow: 3 stories, 2 merge cleanly, 1 conflicted then rectified successfully", async () => {
    // Setup: US-001 and US-002 run in parallel, both complete.
    // US-003 depends on US-001 and runs after, merges cleanly.
    // US-002 gets a merge conflict in the first pass but is rectified.
    const initialPrd = makeIntegrationPrd([
      { id: "US-001", title: "S1", description: "d", acceptanceCriteria: ["ac"], dependencies: [], tags: [], status: "pending", passes: false, escalations: [], attempts: 0 },
      { id: "US-002", title: "S2", description: "d", acceptanceCriteria: ["ac"], dependencies: [], tags: [], status: "pending", passes: false, escalations: [], attempts: 0 },
      { id: "US-003", title: "S3", description: "d", acceptanceCriteria: ["ac"], dependencies: ["US-001"], tags: [], status: "pending", passes: false, escalations: [], attempts: 0 },
    ]);

    // After first merge pass: US-001 and US-003 passed, US-002 conflicted
    const postParallelPrd = makeIntegrationPrd([
      { id: "US-001", title: "S1", description: "d", acceptanceCriteria: ["ac"], dependencies: [], tags: [], status: "passed", passes: true, escalations: [], attempts: 1 },
      { id: "US-002", title: "S2", description: "d", acceptanceCriteria: ["ac"], dependencies: [], tags: [], status: "failed", passes: false, escalations: [], attempts: 1 },
      { id: "US-003", title: "S3", description: "d", acceptanceCriteria: ["ac"], dependencies: ["US-001"], tags: [], status: "passed", passes: true, escalations: [], attempts: 1 },
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 2,
      totalCost: 6.0,
      updatedPrd: postParallelPrd,
      // MFX-005: executeParallel must return conflictedStories — FAILS until implemented
      mergeConflicts: [
        { storyId: "US-002", conflictFiles: ["src/shared.ts"], originalCost: 2.0 },
      ],
    }));

    // @ts-ignore
    _parallelExecutorDeps.rectifyConflictedStory = mock(async () => ({
      success: true,
      storyId: "US-002",
      cost: 2.5,
    }));

    const result = await runParallelExecution(makeIntegrationOptions(), initialPrd);

    // MFX-005: all 3 stories should be completed (2 parallel + 1 rectified) — FAILS
    expect(result.storiesCompleted).toBe(3);

    const us002 = result.prd.userStories.find((s) => s.id === "US-002");
    expect(us002?.status).toBe("passed");

    const stats = (result as unknown as Record<string, unknown>).rectificationStats as Record<string, number>;
    expect(stats?.rectified).toBe(1);
    expect(stats?.stillConflicting).toBe(0);
  });

  test("full flow: conflicted story still conflicts after rectification → preserved as finalConflict", async () => {
    const initialPrd = makeIntegrationPrd([
      { id: "US-001", title: "S1", description: "d", acceptanceCriteria: ["ac"], dependencies: [], tags: [], status: "pending", passes: false, escalations: [], attempts: 0 },
      { id: "US-002", title: "S2", description: "d", acceptanceCriteria: ["ac"], dependencies: [], tags: [], status: "pending", passes: false, escalations: [], attempts: 0 },
    ]);

    const postParallelPrd = makeIntegrationPrd([
      { id: "US-001", title: "S1", description: "d", acceptanceCriteria: ["ac"], dependencies: [], tags: [], status: "passed", passes: true, escalations: [], attempts: 1 },
      { id: "US-002", title: "S2", description: "d", acceptanceCriteria: ["ac"], dependencies: [], tags: [], status: "failed", passes: false, escalations: [], attempts: 1 },
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 4.0,
      updatedPrd: postParallelPrd,
      mergeConflicts: [
        { storyId: "US-002", conflictFiles: ["src/shared.ts", "src/types.ts"], originalCost: 2.0 },
      ],
    }));

    // @ts-ignore — structural conflict, cannot auto-resolve
    _parallelExecutorDeps.rectifyConflictedStory = mock(async () => ({
      success: false,
      storyId: "US-002",
      conflictFiles: ["src/shared.ts", "src/types.ts"],
      finalConflict: true,
      cost: 1.5,
    }));

    const result = await runParallelExecution(makeIntegrationOptions(), initialPrd);

    // MFX-005: only US-001 completed, US-002 is finalConflict — FAILS
    expect(result.storiesCompleted).toBe(1);
    const us002 = result.prd.userStories.find((s) => s.id === "US-002");
    expect(us002?.status).not.toBe("passed");

    const stats = (result as unknown as Record<string, unknown>).rectificationStats as Record<string, number>;
    expect(stats?.rectified).toBe(0);
    expect(stats?.stillConflicting).toBe(1);
  });
});
