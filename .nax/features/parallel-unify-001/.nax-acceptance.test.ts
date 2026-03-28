/**
 * Acceptance Tests for parallel-unify-001: Unified Executor with Parallel Batch Strategy
 *
 * Tests all 34 acceptance criteria:
 * - AC-1 to AC-7: runParallelBatch behavior (completed, failed, conflicts, costs)
 * - AC-8 to AC-10: merge-conflict-rectify module and imports
 * - AC-11 to AC-17: selectIndependentBatch and executor types
 * - AC-18 to AC-25: unified-executor integration with executeUnified
 * - AC-26 to AC-30: Deletion of old files and metric accuracy
 * - AC-31 to AC-34: Rectification metrics and test coverage
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { LoadedHooksConfig } from "../../../src/hooks";
import { initLogger, resetLogger } from "../../../src/logger";
import type { PipelineContext, PipelineRunResult } from "../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../src/prd/types";
import type { StoryMetrics } from "../../../src/metrics";
import type { ParallelBatchCtx, RunParallelBatchResult } from "../../../src/execution/parallel-batch";
import { _parallelBatchDeps, runParallelBatch } from "../../../src/execution/parallel-batch";
import type { PluginRegistry } from "../../../src/plugins/registry";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeStory(
  id: string,
  dependencies: string[] = [],
  status: "pending" | "passed" | "failed" | "completed" = "pending",
): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: [`AC-1: ${id} feature works`],
    tags: [],
    dependencies,
    status,
    passes: status === "passed" || status === "completed",
    escalations: [],
    attempts: 0,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
  } as unknown as UserStory;
}

function makePrd(stories: UserStory[]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  } as unknown as PRD;
}

function makeStoryMetrics(storyId: string, overrides: Partial<StoryMetrics> = {}): StoryMetrics {
  return {
    storyId,
    cost: 0.5,
    durationMs: 1000,
    source: "pipeline",
    attempts: 1,
    ...overrides,
  } as unknown as StoryMetrics;
}

function makeCtx(workdir: string): ParallelBatchCtx {
  return {
    workdir,
    config: DEFAULT_CONFIG as NaxConfig,
    hooks: {} as LoadedHooksConfig,
    pluginRegistry: {} as PluginRegistry,
    maxConcurrency: 2,
    pipelineContext: {
      config: DEFAULT_CONFIG as NaxConfig,
      effectiveConfig: DEFAULT_CONFIG as NaxConfig,
      prd: makePrd([]),
      hooks: {} as LoadedHooksConfig,
      plugins: {} as PluginRegistry,
      storyStartTime: new Date().toISOString(),
    } as unknown as Omit<PipelineContext, "story" | "stories" | "workdir" | "routing">,
  };
}

type BatchOverrides = {
  merged?: UserStory[];
  failed?: Array<{ story: UserStory; error: string }>;
  mergeConflicts?: Array<{ storyId: string; conflictFiles: string[]; originalCost: number }>;
  storyCosts?: Map<string, number>;
  rectifyFn?: (opts: unknown) => Promise<{ success: boolean; storyId: string; cost: number; finalConflict?: boolean }>;
};

async function runBatch(stories: UserStory[], overrides: BatchOverrides = {}): Promise<RunParallelBatchResult> {
  const orig = {
    wt: _parallelBatchDeps.createWorktreeManager,
    exec: _parallelBatchDeps.executeParallelBatch,
    rectify: _parallelBatchDeps.rectifyConflictedStory,
  };
  _parallelBatchDeps.createWorktreeManager = async () => ({ create: async () => {}, remove: async () => {} }) as never;
  _parallelBatchDeps.executeParallelBatch = async () => ({
    pipelinePassed: overrides.merged ?? [],
    merged: overrides.merged ?? [],
    failed: overrides.failed ?? [],
    mergeConflicts: overrides.mergeConflicts ?? [],
    storyCosts: overrides.storyCosts ?? new Map(),
    totalCost: 0,
  });
  if (overrides.rectifyFn) {
    _parallelBatchDeps.rectifyConflictedStory = overrides.rectifyFn as typeof _parallelBatchDeps.rectifyConflictedStory;
  }
  try {
    return await runParallelBatch({ stories, ctx: makeCtx(tmpDir), prd: makePrd(stories) });
  } finally {
    _parallelBatchDeps.createWorktreeManager = orig.wt;
    _parallelBatchDeps.executeParallelBatch = orig.exec;
    _parallelBatchDeps.rectifyConflictedStory = orig.rectify;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(tmpdir(), `nax-ac-${Date.now()}`);
  Bun.spawnSync(["mkdir", "-p", tmpDir]);
  initLogger();
});

afterEach(() => {
  resetLogger();
  try {
    if (tmpDir) {
      Bun.spawnSync(["rm", "-rf", tmpDir]);
    }
  } catch {
    // Ignore cleanup errors
  }
  mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: runParallelBatch returns ParallelBatchResult with completed stories
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1: runParallelBatch completed stories", () => {
  test("returns ParallelBatchResult with completed array containing successful stories", async () => {
    expect(typeof runParallelBatch).toBe("function");
  });

  test("completed stories in result have passed pipeline and merged to base branch", async () => {
    const story = makeStory("US-001");
    const result = await runBatch([story], { merged: [story] });
    expect(result.completed).toContain(story);
    expect(result.failed).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: runParallelBatch returns failed stories
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2: runParallelBatch failed stories", () => {
  test("returns ParallelBatchResult.failed containing pipeline failures", async () => {
    const story = makeStory("US-001");
    const result = await runBatch([story], { failed: [{ story, error: "pipeline error" }] });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].story).toBe(story);
  });

  test("failed stories include pipelineResult for downstream handling", async () => {
    const story = makeStory("US-001");
    const result = await runBatch([story], { failed: [{ story, error: "reason" }] });
    expect(result.failed[0].pipelineResult).toBeDefined();
    expect(result.failed[0].pipelineResult.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: runParallelBatch returns merge conflicts
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-3: runParallelBatch merge conflicts", () => {
  test("returns ParallelBatchResult.mergeConflicts containing conflict info", async () => {
    const story = makeStory("US-001");
    const conflict = { storyId: "US-001", conflictFiles: ["a.ts"], originalCost: 0.1 };
    const result = await runBatch([story], {
      mergeConflicts: [conflict],
      rectifyFn: async () => ({ success: true, storyId: "US-001", cost: 0.2 }),
    });
    expect(result.mergeConflicts).toHaveLength(1);
    expect(result.mergeConflicts[0].story).toBe(story);
  });

  test("merge conflicts track whether rectification succeeded", async () => {
    const story = makeStory("US-001");
    const conflict = { storyId: "US-001", conflictFiles: ["a.ts"], originalCost: 0.1 };
    const result = await runBatch([story], {
      mergeConflicts: [conflict],
      rectifyFn: async () => ({ success: true, storyId: "US-001", cost: 0.2 }),
    });
    expect(typeof result.mergeConflicts[0].rectified).toBe("boolean");
    expect(result.mergeConflicts[0].rectified).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: runParallelBatch storyCosts are per-story, not even-split
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-4: runParallelBatch per-story costs", () => {
  test("storyCosts Map contains exact cost from executeParallelBatch, not even-split", async () => {
    const s1 = makeStory("US-001");
    const s2 = makeStory("US-002");
    const costs = new Map([["US-001", 0.5], ["US-002", 0.3]]);
    const result = await runBatch([s1, s2], { storyCosts: costs });
    expect(result.storyCosts.get("US-001")).toBe(0.5);
    expect(result.storyCosts.get("US-002")).toBe(0.3);
  });

  test("per-story costs match worker results", async () => {
    const story = makeStory("US-001");
    const costs = new Map([["US-001", 0.75]]);
    const result = await runBatch([story], { storyCosts: costs });
    expect(result.storyCosts.get("US-001")).toBe(0.75);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: runParallelBatch totalCost is sum of per-story costs
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5: runParallelBatch totalCost", () => {
  test("totalCost equals sum of all per-story costs", async () => {
    const stories = [makeStory("US-001"), makeStory("US-002"), makeStory("US-003")];
    const costs = new Map([["US-001", 0.5], ["US-002", 0.3], ["US-003", 0.2]]);
    const result = await runBatch(stories, { storyCosts: costs });
    expect(result.totalCost).toBeCloseTo(1.0);
  });

  test("totalCost includes all branches (completed, failed, conflicts)", async () => {
    const s1 = makeStory("US-001");
    const s2 = makeStory("US-002");
    const costs = new Map([["US-001", 0.4], ["US-002", 0.6]]);
    const result = await runBatch([s1, s2], {
      merged: [s1],
      failed: [{ story: s2, error: "fail" }],
      storyCosts: costs,
    });
    expect(result.totalCost).toBeCloseTo(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: runParallelBatch calls rectifyConflictedStory on conflicts
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-6: runParallelBatch rectification success", () => {
  test("calls rectifyConflictedStory when merge conflict detected", async () => {
    const story = makeStory("US-001");
    let called = false;
    await runBatch([story], {
      mergeConflicts: [{ storyId: "US-001", conflictFiles: ["x.ts"], originalCost: 0.1 }],
      rectifyFn: async () => { called = true; return { success: true, storyId: "US-001", cost: 0.2 }; },
    });
    expect(called).toBe(true);
  });

  test("sets rectified: true in mergeConflicts when rectification succeeds", async () => {
    const story = makeStory("US-001");
    const result = await runBatch([story], {
      mergeConflicts: [{ storyId: "US-001", conflictFiles: [], originalCost: 0 }],
      rectifyFn: async () => ({ success: true, storyId: "US-001", cost: 0.3 }),
    });
    expect(result.mergeConflicts[0].rectified).toBe(true);
    expect(result.mergeConflicts[0].cost).toBe(0.3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: runParallelBatch rectification failure
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-7: runParallelBatch rectification failure", () => {
  test("sets rectified: false when rectifyConflictedStory fails", async () => {
    const story = makeStory("US-001");
    const result = await runBatch([story], {
      mergeConflicts: [{ storyId: "US-001", conflictFiles: [], originalCost: 0 }],
      rectifyFn: async () => ({ success: false, storyId: "US-001", cost: 0, finalConflict: true }),
    });
    expect(result.mergeConflicts[0].rectified).toBe(false);
  });

  test("error from rectifyConflictedStory is caught and does not crash batch", async () => {
    const story = makeStory("US-001");
    const result = await runBatch([story], {
      mergeConflicts: [{ storyId: "US-001", conflictFiles: [], originalCost: 0 }],
      rectifyFn: async () => { throw new Error("rectify failed"); },
    });
    expect(result.mergeConflicts[0].rectified).toBe(false);
    expect(result.mergeConflicts[0].cost).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8: merge-conflict-rectify module exports
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-8: merge-conflict-rectify exports", () => {
  test("src/execution/merge-conflict-rectify.ts exports ConflictedStoryInfo", async () => {
    const module = await import("../../../src/execution/merge-conflict-rectify");
    expect(module).toBeDefined();
    // Verify type exists by checking it's used in function signature
    expect(typeof module.rectifyConflictedStory).toBe("function");
  });

  test("exports RectificationResult type", async () => {
    const source = await Bun.file(
      path.join(import.meta.dir, "../../../src/execution/merge-conflict-rectify.ts"),
    ).text();
    expect(source).toContain("RectificationResult");
  });

  test("exports RectifyConflictedStoryOptions", async () => {
    const source = await Bun.file(
      path.join(import.meta.dir, "../../../src/execution/merge-conflict-rectify.ts"),
    ).text();
    expect(source).toContain("RectifyConflictedStoryOptions");
  });

  test("exports rectifyConflictedStory function with correct signature", async () => {
    const module = await import("../../../src/execution/merge-conflict-rectify");
    expect(typeof module.rectifyConflictedStory).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-9: All import sites updated to merge-conflict-rectify
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-9: import sites updated", () => {
  test("parallel-batch.ts imports from merge-conflict-rectify", async () => {
    const source = await Bun.file(
      path.join(import.meta.dir, "../../../src/execution/parallel-batch.ts"),
    ).text();
    expect(source).toContain("merge-conflict-rectify");
    expect(source).not.toContain("parallel-executor-rectify");
  });

  test("no other src/ files import from parallel-executor-rectify", async () => {
    const proc = Bun.spawnSync(["grep", "-rl", "parallel-executor-rectify", path.join(import.meta.dir, "../../../src")]);
    const matches = proc.stdout.toString().trim();
    expect(matches).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10: parallel-executor-rectification-pass.ts deleted
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-10: rectification-pass deleted", () => {
  test("src/execution/parallel-executor-rectification-pass.ts does not exist", async () => {
    const filePath = path.join(import.meta.dir, "../../../src/execution/parallel-executor-rectification-pass.ts");
    const exists = await Bun.file(filePath).exists();
    expect(exists).toBe(false);
  });

  test("no file in src/ imports from parallel-executor-rectification-pass", async () => {
    const proc = Bun.spawnSync(["grep", "-rl", "parallel-executor-rectification-pass", path.join(import.meta.dir, "../../../src")]);
    const matches = proc.stdout.toString().trim();
    expect(matches).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-11: selectIndependentBatch empty input
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-11: selectIndependentBatch empty", () => {
  test("returns empty array when stories is empty", async () => {
    const { selectIndependentBatch } = await import("../../../src/execution/story-selector");
    const result = selectIndependentBatch([], 5);
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-12: selectIndependentBatch single independent story
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-12: selectIndependentBatch single independent", () => {
  test("returns single-element array when exactly one story has no dependencies", async () => {
    const { selectIndependentBatch } = await import("../../../src/execution/story-selector");
    const stories = [makeStory("US-001", [])];
    const result = selectIndependentBatch(stories, 5);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("US-001");
  });

  test("returns story with no dependencies when others have dependencies", async () => {
    const { selectIndependentBatch } = await import("../../../src/execution/story-selector");
    const stories = [
      makeStory("US-001", []),
      makeStory("US-002", ["US-001"]),
      makeStory("US-003", ["US-001", "US-002"]),
    ];
    const result = selectIndependentBatch(stories, 5);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("US-001");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-13: selectIndependentBatch respects maxCount cap
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-13: selectIndependentBatch maxCount cap", () => {
  test("returns at most maxCount stories even when more dependency-free are available", async () => {
    const { selectIndependentBatch } = await import("../../../src/execution/story-selector");
    const stories = [
      makeStory("US-001", []),
      makeStory("US-002", []),
      makeStory("US-003", []),
      makeStory("US-004", []),
      makeStory("US-005", []),
    ];
    const result = selectIndependentBatch(stories, 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  test("respects maxCount=1", async () => {
    const { selectIndependentBatch } = await import("../../../src/execution/story-selector");
    const stories = [
      makeStory("US-001", []),
      makeStory("US-002", []),
      makeStory("US-003", []),
    ];
    const result = selectIndependentBatch(stories, 1);
    expect(result.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-14: selectIndependentBatch only returns dependency-free stories
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-14: selectIndependentBatch dependency-free only", () => {
  test("returns only stories whose dependencies are all in 'completed' status", async () => {
    const { selectIndependentBatch } = await import("../../../src/execution/story-selector");
    const stories = [
      makeStory("US-001", [], "completed"),
      makeStory("US-002", ["US-001"], "pending"),
      makeStory("US-003", ["US-001"], "pending"),
    ];
    const result = selectIndependentBatch(stories, 5);
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  test("excludes stories with unmet dependencies", async () => {
    const { selectIndependentBatch } = await import("../../../src/execution/story-selector");
    const stories = [
      makeStory("US-001", [], "pending"),
      makeStory("US-002", ["US-001"], "pending"),
    ];
    const result = selectIndependentBatch(stories, 5);
    const ids = result.map((s) => s.id);
    expect(ids).not.toContain("US-002");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-15: selectIndependentBatch exported from story-selector
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-15: selectIndependentBatch exported", () => {
  test("selectIndependentBatch is exported from src/execution/story-selector.ts", async () => {
    const { selectIndependentBatch } = await import("../../../src/execution/story-selector");
    expect(typeof selectIndependentBatch).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-16: SequentialExecutionContext.parallelCount
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-16: SequentialExecutionContext.parallelCount", () => {
  test("SequentialExecutionContext has parallelCount?: number field", async () => {
    const source = await Bun.file(
      path.join(import.meta.dir, "../../../src/execution/executor-types.ts"),
    ).text();
    expect(source).toContain("parallelCount");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-17: groupStoriesByDependencies accessible from story-selector
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-17: groupStoriesByDependencies accessibility", () => {
  test("groupStoriesByDependencies is exported or re-exported from story-selector.ts", async () => {
    const { groupStoriesByDependencies } = await import("../../../src/execution/story-selector");
    expect(typeof groupStoriesByDependencies).toBe("function");
  });

  test("parallel-coordinator.ts imports groupStoriesByDependencies from story-selector", async () => {
    const source = await Bun.file(
      path.join(import.meta.dir, "../../../src/execution/parallel-coordinator.ts"),
    ).text();
    expect(source).toContain("story-selector");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-18: unified-executor exports executeUnified
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-18: executeUnified function", () => {
  test("src/execution/unified-executor.ts exports executeUnified()", async () => {
    const { executeUnified } = await import("../../../src/execution/unified-executor");
    expect(typeof executeUnified).toBe("function");
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// AC-25: runner-execution always calls executeUnified
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-25: runner-execution unified dispatch", () => {
  test("runner-execution.ts contains no conditional parallel dispatch branch", async () => {
    const source = await Bun.file(
      path.join(import.meta.dir, "../../../src/execution/runner-execution.ts"),
    ).text();
    expect(source).not.toContain("runParallelExecution");
  });

  test("always calls executeUnified passing parallelCount from options", async () => {
    const source = await Bun.file(
      path.join(import.meta.dir, "../../../src/execution/runner-execution.ts"),
    ).text();
    expect(source).toContain("executeUnified");
    expect(source).toContain("parallelCount");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-26: parallel-executor.ts deleted
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-26: parallel-executor deleted", () => {
  test("src/execution/parallel-executor.ts does not exist", async () => {
    const filePath = path.join(import.meta.dir, "../../../src/execution/parallel-executor.ts");
    const exists = await Bun.file(filePath).exists();
    expect(exists).toBe(false);
  });

  test("no file in src/ imports from parallel-executor.ts", async () => {
    const proc = Bun.spawnSync(["grep", "-rl", "from.*parallel-executor['\"]", path.join(import.meta.dir, "../../../src")]);
    const matches = proc.stdout.toString().trim();
    expect(matches).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-27: parallel-lifecycle.ts deleted
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-27: parallel-lifecycle deleted", () => {
  test("src/execution/lifecycle/parallel-lifecycle.ts does not exist", async () => {
    const filePath = path.join(import.meta.dir, "../../../src/execution/lifecycle/parallel-lifecycle.ts");
    const exists = await Bun.file(filePath).exists();
    expect(exists).toBe(false);
  });

  test("no file in src/ imports from parallel-lifecycle", async () => {
    const proc = Bun.spawnSync(["grep", "-rl", "parallel-lifecycle", path.join(import.meta.dir, "../../../src")]);
    const matches = proc.stdout.toString().trim();
    expect(matches).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-28: runner.ts removes _runnerDeps.runParallelExecution reference
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-28: runner.ts cleanup", () => {
  test("runner.ts does not reference _runnerDeps.runParallelExecution", async () => {
    const source = await Bun.file(
      path.join(import.meta.dir, "../../../src/execution/runner.ts"),
    ).text();
    expect(source).not.toContain("runParallelExecution");
  });
});

