/**
 * Characterisation tests for runParallelBatch branches the four mirror suites
 * (parallel-batch, parallel-batch-structure, and the two integration files)
 * do not pin — written green against the unrefactored function before the B5
 * complexity-drain refactor, so the extraction must keep them passing unchanged.
 *
 * Covered here and nowhere else:
 *   - the non-conflict merge-failure branch (failureKind "error"): the story
 *     lands in failed, never mergeConflicts, and no rectification is bought
 *   - the worktree-create failure's synthesized pipeline result (stage name,
 *     failure context under the batch workdir) and its near-instant duration
 *   - the dependency-prep failure's worktree cleanup (remove called with the
 *     composed identity) and its tolerance of a throwing cleanup
 *   - per-story effective-config threading into dependency prep and the worker
 *     (and the empty-map arm that forwards no map at all)
 *   - the two warn-log payloads (config-load failure, rectification throw —
 *     the latter under the bracketed stage spelling)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMergeEngine,
  makePluginRegistry,
  makePRD,
  makeStory,
  makeTempDir,
  makeTestContext,
  makeWorktreeManager,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import type { RectificationResult } from "@/execution/merge-conflict-rectify";
import { _parallelBatchDeps, type ParallelBatchCtx, runParallelBatch } from "@/execution/parallel-batch";
import type { ParallelBatchResult } from "@/execution/parallel-worker";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { PRD, UserStory } from "@/prd/types";
import type { WorktreeId } from "@/worktree";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures (same local pattern the mirror suites use over the shared helpers)
// ─────────────────────────────────────────────────────────────────────────────

const FEATURE = "test-feature";

function composedId(storyId: string): string {
  return `story-${FEATURE}-${storyId}`;
}

function edgePrd(stories: UserStory[]): PRD {
  return makePRD({ feature: FEATURE, branchName: "feat/test", userStories: stories });
}

function makeEdgeCtx(workdir: string): ParallelBatchCtx {
  return {
    workdir,
    config: DEFAULT_CONFIG,
    hooks: { hooks: {} },
    pluginRegistry: makePluginRegistry(),
    maxConcurrency: 2,
    pipelineContext: makeTestContext({
      config: DEFAULT_CONFIG,
      rootConfig: DEFAULT_CONFIG,
    }),
  };
}

function emptyWorkerResult(overrides: Partial<ParallelBatchResult> = {}): ParallelBatchResult {
  return {
    pipelinePassed: [],
    merged: [],
    failed: [],
    totalCost: 0,
    mergeConflicts: [],
    storyCosts: new Map(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir: string;
let origDeps: typeof _parallelBatchDeps;

beforeEach(() => {
  tmpDir = makeTempDir("nax-pb-edges-");
  origDeps = { ..._parallelBatchDeps };
});

afterEach(() => {
  Object.assign(_parallelBatchDeps, origDeps);
  cleanupTempDir(tmpDir);
  mock.restore();
});

/** Stubs every dep the batch touches so a test only overrides what it asserts on. */
function stubHappyPath(workerResult: ParallelBatchResult): void {
  _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
  _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
  _parallelBatchDeps.createMergeEngine = mock(async () => makeMergeEngine());
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-conflict merge failure (failureKind "error")
// ─────────────────────────────────────────────────────────────────────────────

describe("non-conflict merge failures", () => {
  test("a failureKind-error merge result lands in failed, never mergeConflicts, and buys no rectification", async () => {
    const story = makeStory({ id: "US-001" });
    const prd = edgePrd([story]);
    const ctx = makeEdgeCtx(tmpDir);
    stubHappyPath(emptyWorkerResult({ pipelinePassed: [story], storyCosts: new Map([["US-001", 0.5]]) }));
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({
        mergeAll: mock(async () => [
          { success: false, storyId: "US-001", failureKind: "error", error: "git merge died" },
        ]),
      }),
    );
    const rectifyMock = mock(
      async (): Promise<RectificationResult> => ({ success: true, storyId: "US-001", cost: 0.1 }),
    );
    _parallelBatchDeps.rectifyConflictedStory = rectifyMock;

    const result = await runParallelBatch({ stories: [story], ctx, prd });

    expect(result.completed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.story).toBe(story);
    expect(result.failed[0]?.pipelineResult.success).toBe(false);
    expect(result.failed[0]?.pipelineResult.finalAction).toBe("fail");
    expect(result.failed[0]?.pipelineResult.reason).toBe("git merge died");
    expect(result.mergeConflicts).toEqual([]);
    expect(rectifyMock).not.toHaveBeenCalled();
  });

  test("an error-kind merge result without a message falls back to the literal merge-failed reason", async () => {
    const story = makeStory({ id: "US-002" });
    const prd = edgePrd([story]);
    const ctx = makeEdgeCtx(tmpDir);
    stubHappyPath(emptyWorkerResult({ pipelinePassed: [story], storyCosts: new Map([["US-002", 0.3]]) }));
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({
        mergeAll: mock(async () => [{ success: false, storyId: "US-002", failureKind: "error" }]),
      }),
    );

    const result = await runParallelBatch({ stories: [story], ctx, prd });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.pipelineResult.reason).toBe("merge failed");
    expect(result.mergeConflicts).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Worktree-create failure: synthesized result shape + failure-moment duration
// ─────────────────────────────────────────────────────────────────────────────

describe("worktree-create failure bookkeeping", () => {
  test("the synthesized result names the worktree-create stage, runs under the batch workdir, and its duration stays near-instant", async () => {
    const failing = makeStory({ id: "US-021" });
    const surviving = makeStory({ id: "US-022" });
    const prd = edgePrd([failing, surviving]);
    const ctx = makeEdgeCtx(tmpDir);

    const manager = makeWorktreeManager({
      create: mock(async (_projectRoot: string, worktreeId: WorktreeId) => {
        if (String(worktreeId) === composedId("US-021")) {
          throw new Error("git worktree add failed");
        }
      }),
    });
    _parallelBatchDeps.createWorktreeManager = mock(async () => manager);
    _parallelBatchDeps.executeParallelBatch = mock(async () => {
      // Simulate the surviving story occupying the batch so a batchEndMs
      // fallback would visibly stretch the failing story's duration.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return emptyWorkerResult({ pipelinePassed: [surviving], merged: [surviving] });
    });
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({ mergeAll: mock(async () => [{ success: true, storyId: "US-022" }]) }),
    );

    const result = await runParallelBatch({ stories: [failing, surviving], ctx, prd });

    const failure = result.failed.find((f) => f.story.id === "US-021");
    expect(failure).toBeDefined();
    expect(failure?.pipelineResult.stoppedAtStage).toBe("worktree-create");
    expect(failure?.pipelineResult.finalAction).toBe("fail");
    expect(failure?.pipelineResult.reason).toBe("git worktree add failed");
    const failureContext = failure?.pipelineResult.context;
    expect(failureContext?.workdir).toBe(tmpDir);
    expect(failureContext?.story?.id).toBe("US-021");
    expect(failureContext?.stories?.map((s) => s.id)).toEqual(["US-021"]);

    const failingDuration = result.storyDurations?.get("US-021") ?? 0;
    const survivingDuration = result.storyDurations?.get("US-022") ?? 0;
    expect(failingDuration).toBeLessThan(survivingDuration);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dependency-prep failure: worktree cleanup with the composed identity
// ─────────────────────────────────────────────────────────────────────────────

describe("dependency-prep failure cleanup", () => {
  test("the story's worktree is removed under the composed identity and a throwing cleanup is swallowed", async () => {
    const story = makeStory({ id: "US-031", workdir: "packages/app" });
    const prd = edgePrd([story]);
    const ctx = makeEdgeCtx(tmpDir);

    const manager = makeWorktreeManager({
      remove: mock(async () => {
        throw new Error("cleanup blew up");
      }),
    });
    _parallelBatchDeps.createWorktreeManager = mock(async () => manager);
    _parallelBatchDeps.loadConfigForWorkdir = mock(async () => DEFAULT_CONFIG);
    _parallelBatchDeps.prepareWorktreeDependencies = mock(async (opts) => {
      if (opts.storyId === "US-031") {
        throw new Error("dependency prep failed");
      }
      return { cwd: opts.worktreeRoot };
    });
    stubHappyPath(emptyWorkerResult());
    _parallelBatchDeps.createWorktreeManager = mock(async () => manager);

    const result = await runParallelBatch({ stories: [story], ctx, prd });

    expect(manager.remove).toHaveBeenCalledTimes(1);
    const removeCall = manager.remove.mock.calls[0];
    expect(removeCall?.[0]).toBe(tmpDir);
    expect(String(removeCall?.[1])).toBe(composedId("US-031"));

    // The batch survived the cleanup throw and still reports the failure with
    // the dependency stage and a context rooted at the (now removed) worktree.
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.pipelineResult.stoppedAtStage).toBe("worktree-dependencies");
    const failureContext = result.failed[0]?.pipelineResult.context;
    expect(failureContext?.workdir).not.toBe(tmpDir);
    expect(failureContext?.workdir).toContain(join(".nax-wt", composedId("US-031")));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-story effective-config threading
// ─────────────────────────────────────────────────────────────────────────────

describe("per-story effective-config threading", () => {
  test("a resolved per-story config feeds that story's dependency prep and is forwarded to the worker", async () => {
    const story = makeStory({ id: "US-041", workdir: "packages/app" });
    const prd = edgePrd([story]);
    const ctx = makeEdgeCtx(tmpDir);
    const storyConfig = structuredClone(DEFAULT_CONFIG);

    let prepConfig: NaxConfig | undefined;
    let observedConfigs: Map<string, NaxConfig> | undefined;

    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.loadConfigForWorkdir = mock(async () => storyConfig);
    _parallelBatchDeps.prepareWorktreeDependencies = mock(async (opts) => {
      prepConfig = opts.config;
      return { cwd: opts.worktreeRoot };
    });
    _parallelBatchDeps.executeParallelBatch = mock(
      async (
        _stories: UserStory[],
        _projectRoot: string,
        _config: NaxConfig,
        _context: unknown,
        _worktreePaths: Map<string, string>,
        _dependencyContexts: Map<string, unknown>,
        _maxConcurrency: number,
        _eventEmitter: unknown,
        effectiveConfigs?: Map<string, NaxConfig>,
      ) => {
        observedConfigs = effectiveConfigs;
        return emptyWorkerResult();
      },
    );
    _parallelBatchDeps.createMergeEngine = mock(async () => makeMergeEngine());

    const result = await runParallelBatch({ stories: [story], ctx, prd });

    // Dependency prep saw the per-story config, not the root config object.
    expect(prepConfig).toBe(storyConfig);
    expect(prepConfig).not.toBe(ctx.config);
    // The worker received the effective-config map keyed by raw story id.
    expect(observedConfigs?.get("US-041")).toBe(storyConfig);
    expect(result.failed).toEqual([]);
  });

  test("with no per-story package configs the worker receives no effective-config map", async () => {
    const story = makeStory({ id: "US-042" });
    const prd = edgePrd([story]);
    const ctx = makeEdgeCtx(tmpDir);

    let observedConfigs: Map<string, NaxConfig> | undefined;
    let configLoads = 0;

    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.loadConfigForWorkdir = mock(async () => {
      configLoads++;
      return DEFAULT_CONFIG;
    });
    _parallelBatchDeps.prepareWorktreeDependencies = mock(async (opts) => ({ cwd: opts.worktreeRoot }));
    _parallelBatchDeps.executeParallelBatch = mock(
      async (
        _stories: UserStory[],
        _projectRoot: string,
        _config: NaxConfig,
        _context: unknown,
        _worktreePaths: Map<string, string>,
        _dependencyContexts: Map<string, unknown>,
        _maxConcurrency: number,
        _eventEmitter: unknown,
        effectiveConfigs?: Map<string, NaxConfig>,
      ) => {
        observedConfigs = effectiveConfigs;
        return emptyWorkerResult();
      },
    );
    _parallelBatchDeps.createMergeEngine = mock(async () => makeMergeEngine());

    await runParallelBatch({ stories: [story], ctx, prd });

    expect(configLoads).toBe(0);
    expect(observedConfigs).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Warn-log payloads (global logger — the logs read getSafeLogger, not a seam)
// ─────────────────────────────────────────────────────────────────────────────

describe("warn-log payloads", () => {
  test("a config-load failure warns with the story id and reason", async () => {
    const story = makeStory({ id: "US-051", workdir: "packages/bad" });
    const prd = edgePrd([story]);
    const ctx = makeEdgeCtx(tmpDir);

    stubHappyPath(emptyWorkerResult());
    _parallelBatchDeps.loadConfigForWorkdir = mock(async () => {
      throw new Error("Malformed per-package config");
    });

    const logCalls: LogEntry[] = [];
    resetLogger();
    initLogger({ level: "silent" });
    const removeSink = addSink((entry) => logCalls.push(entry));
    try {
      await runParallelBatch({ stories: [story], ctx, prd });
    } finally {
      removeSink();
      resetLogger();
    }

    const entry = logCalls.find((l) => l.message === "Failed to load per-story config; using root config");
    expect(entry).toBeDefined();
    expect(entry?.level).toBe("warn");
    expect(entry?.stage).toBe("parallel-batch");
    expect(entry?.data?.storyId).toBe("US-051");
    expect(entry?.data?.reason).toBe("Malformed per-package config");
  });

  test("a rectification throw warns under the bracketed stage spelling with the story id and error", async () => {
    const story = makeStory({ id: "US-061" });
    const prd = edgePrd([story]);
    const ctx = makeEdgeCtx(tmpDir);

    stubHappyPath(emptyWorkerResult({ pipelinePassed: [story], storyCosts: new Map([["US-061", 0.5]]) }));
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({
        mergeAll: mock(async () => [
          { success: false, storyId: "US-061", failureKind: "conflict", conflictFiles: ["src/x.ts"] },
        ]),
      }),
    );
    _parallelBatchDeps.rectifyConflictedStory = mock(async () => {
      throw new Error("rectification exploded");
    });

    const logCalls: LogEntry[] = [];
    resetLogger();
    initLogger({ level: "silent" });
    const removeSink = addSink((entry) => logCalls.push(entry));
    let result: Awaited<ReturnType<typeof runParallelBatch>> | undefined;
    try {
      result = await runParallelBatch({ stories: [story], ctx, prd });
    } finally {
      removeSink();
      resetLogger();
    }

    const entry = logCalls.find((l) => l.message === "rectification failed for story");
    expect(entry).toBeDefined();
    expect(entry?.level).toBe("warn");
    expect(entry?.stage).toBe("[parallel-batch]");
    expect(entry?.data?.storyId).toBe("US-061");
    expect(entry?.data?.error).toBe("rectification exploded");

    const conflict = result?.mergeConflicts.find((c) => c.story.id === "US-061");
    expect(conflict?.rectified).toBe(false);
    expect(conflict?.cost).toBe(0);
  });
});
