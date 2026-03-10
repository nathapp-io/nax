/**
 * Unit tests for MFX-005: Merge conflict rectification
 *
 * Tests the new behavior in runParallelExecution where stories that conflict
 * during the first merge pass are re-run sequentially on the updated base
 * branch (which includes all successfully merged stories), giving the agent
 * full context of what already exists.
 *
 * All tests are in RED state — the feature is not yet implemented.
 *
 * Implementation target: src/execution/parallel-executor.ts
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import type { LoadedHooksConfig } from "../../../src/hooks";
import {
  _parallelExecutorDeps,
  runParallelExecution,
} from "../../../src/execution/parallel-executor";
import type { ParallelExecutorOptions } from "../../../src/execution/parallel-executor";
import type { PluginRegistry } from "../../../src/plugins/registry";
import type { StatusWriter } from "../../../src/execution/status-writer";
import type { PRD } from "../../../src/prd";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeStory(
  id: string,
  status: "pending" | "passed" | "failed" = "pending",
  deps: string[] = [],
) {
  return {
    id,
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: ["AC1"],
    dependencies: deps,
    tags: [] as string[],
    status,
    passes: status === "passed",
    escalations: [] as never[],
    attempts: 0,
  };
}

function makePrd(stories: ReturnType<typeof makeStory>[]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
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

function makeOptions(
  statusWriter: StatusWriter,
  overrides: Partial<ParallelExecutorOptions> = {},
): ParallelExecutorOptions {
  return {
    prdPath: "/tmp/test-prd.json",
    workdir: "/tmp/test-workdir",
    config: {} as NaxConfig,
    hooks: {} as LoadedHooksConfig,
    feature: "test-feature",
    parallelCount: 2,
    statusWriter,
    runId: "run-mfx005-001",
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

// Save originals for restoration
const originalExecuteParallel = _parallelExecutorDeps.executeParallel;
const originalFireHook = _parallelExecutorDeps.fireHook;
// @ts-ignore — rectifyConflictedStory will be added by the implementation
const originalRectifyConflictedStory = _parallelExecutorDeps.rectifyConflictedStory;

afterEach(() => {
  mock.restore();
  _parallelExecutorDeps.executeParallel = originalExecuteParallel;
  _parallelExecutorDeps.fireHook = originalFireHook;
  // @ts-ignore
  if (originalRectifyConflictedStory !== undefined) {
    // @ts-ignore
    _parallelExecutorDeps.rectifyConflictedStory = originalRectifyConflictedStory;
  }
});

// ─── _deps interface ──────────────────────────────────────────────────────────

describe("MFX-005: _parallelExecutorDeps has rectifyConflictedStory", () => {
  test("exposes rectifyConflictedStory dep for injection", () => {
    // MFX-005: implementation must add this dep — FAILS until implemented
    expect(_parallelExecutorDeps).toHaveProperty("rectifyConflictedStory");
    expect(
      typeof (_parallelExecutorDeps as Record<string, unknown>).rectifyConflictedStory,
    ).toBe("function");
  });
});

// ─── rectificationStats in result ────────────────────────────────────────────

describe("MFX-005: rectificationStats in ParallelExecutorResult", () => {
  test("result includes rectificationStats when executeParallel returns conflictedStories", async () => {
    const initialPrd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 3.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [
        { storyId: "US-002", conflictFiles: ["src/foo.ts"], originalCost: 1.5 },
      ],
    }));

    const statusWriter = makeStatusWriter();
    const result = await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: result must have rectificationStats — FAILS until implemented
    expect(result).toHaveProperty("rectificationStats");
  });

  test("rectificationStats has rectified and stillConflicting counters", async () => {
    const initialPrd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 3.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [
        { storyId: "US-002", conflictFiles: ["src/foo.ts"], originalCost: 1.5 },
      ],
    }));
    // @ts-ignore
    _parallelExecutorDeps.rectifyConflictedStory = mock(async () => ({
      success: true,
      storyId: "US-002",
      cost: 2.0,
    }));

    const statusWriter = makeStatusWriter();
    const result = await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: must have numeric rectified and stillConflicting — FAILS
    const stats = (result as unknown as Record<string, unknown>).rectificationStats as Record<
      string,
      number
    >;
    expect(typeof stats?.rectified).toBe("number");
    expect(typeof stats?.stillConflicting).toBe("number");
  });

  test("no conflicts: rectificationStats shows rectified: 0, stillConflicting: 0", async () => {
    const initialPrd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "passed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 2,
      totalCost: 4.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [],
    }));

    const statusWriter = makeStatusWriter();
    const result = await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: empty rectification when no conflicts — FAILS until implemented
    const stats = (result as unknown as Record<string, unknown>).rectificationStats as Record<
      string,
      number
    >;
    expect(stats).toBeDefined();
    expect(stats?.rectified).toBe(0);
    expect(stats?.stillConflicting).toBe(0);
  });
});

// ─── Successful rectification ─────────────────────────────────────────────────

describe("MFX-005: successful rectification", () => {
  test("marks rectified story as passed in returned PRD", async () => {
    const initialPrd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 3.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [
        { storyId: "US-002", conflictFiles: ["src/foo.ts"], originalCost: 1.5 },
      ],
    }));
    // @ts-ignore
    _parallelExecutorDeps.rectifyConflictedStory = mock(async () => ({
      success: true,
      storyId: "US-002",
      cost: 2.0,
    }));

    const statusWriter = makeStatusWriter();
    const result = await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: rectified story must be passed in PRD — FAILS until implemented
    const us002 = result.prd.userStories.find((s) => s.id === "US-002");
    expect(us002?.status).toBe("passed");
  });

  test("includes rectified story in storiesCompleted count", async () => {
    const initialPrd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 3.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [
        { storyId: "US-002", conflictFiles: ["src/foo.ts"], originalCost: 1.5 },
      ],
    }));
    // @ts-ignore
    _parallelExecutorDeps.rectifyConflictedStory = mock(async () => ({
      success: true,
      storyId: "US-002",
      cost: 2.0,
    }));

    const statusWriter = makeStatusWriter();
    // 1 parallel + 1 rectified = 2
    const result = await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: storiesCompleted must include rectified story — FAILS until implemented
    expect(result.storiesCompleted).toBe(2);
  });

  test("rectificationStats shows rectified: 1, stillConflicting: 0", async () => {
    const initialPrd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 3.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [
        { storyId: "US-002", conflictFiles: ["src/foo.ts"], originalCost: 1.5 },
      ],
    }));
    // @ts-ignore
    _parallelExecutorDeps.rectifyConflictedStory = mock(async () => ({
      success: true,
      storyId: "US-002",
      cost: 2.0,
    }));

    const statusWriter = makeStatusWriter();
    const result = await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: counts must be correct — FAILS until implemented
    const stats = (result as unknown as Record<string, unknown>).rectificationStats as Record<
      string,
      number
    >;
    expect(stats?.rectified).toBe(1);
    expect(stats?.stillConflicting).toBe(0);
  });
});

// ─── Rectification storyMetrics ───────────────────────────────────────────────

describe("MFX-005: storyMetrics for rectified stories", () => {
  test("storyMetrics includes entry with source: rectification", async () => {
    const initialPrd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 3.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [
        { storyId: "US-002", conflictFiles: ["src/foo.ts"], originalCost: 1.5 },
      ],
    }));
    // @ts-ignore
    _parallelExecutorDeps.rectifyConflictedStory = mock(async () => ({
      success: true,
      storyId: "US-002",
      cost: 2.0,
    }));

    const statusWriter = makeStatusWriter();
    const result = await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: storyMetrics must include rectification entry — FAILS until implemented
    const rectMetrics = result.storyMetrics.filter(
      (m) => (m as unknown as Record<string, unknown>).source === "rectification",
    );
    expect(rectMetrics.length).toBeGreaterThan(0);
  });

  test("storyMetrics rectification entry has rectifiedFromConflict: true", async () => {
    const initialPrd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 3.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [
        { storyId: "US-002", conflictFiles: ["src/foo.ts"], originalCost: 1.5 },
      ],
    }));
    // @ts-ignore
    _parallelExecutorDeps.rectifyConflictedStory = mock(async () => ({
      success: true,
      storyId: "US-002",
      cost: 2.0,
    }));

    const statusWriter = makeStatusWriter();
    const result = await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: rectifiedFromConflict flag must be set — FAILS until implemented
    const rectMetrics = result.storyMetrics.filter(
      (m) => (m as unknown as Record<string, unknown>).source === "rectification",
    );
    expect(rectMetrics.length).toBeGreaterThan(0);
    const entry = rectMetrics[0] as unknown as Record<string, unknown>;
    expect(entry.rectifiedFromConflict).toBe(true);
  });

  test("storyMetrics rectification entry tracks originalCost and rectificationCost", async () => {
    const ORIGINAL_COST = 1.5;
    const RECTIFICATION_COST = 2.5;
    const initialPrd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 3.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [
        { storyId: "US-002", conflictFiles: ["src/foo.ts"], originalCost: ORIGINAL_COST },
      ],
    }));
    // @ts-ignore
    _parallelExecutorDeps.rectifyConflictedStory = mock(async () => ({
      success: true,
      storyId: "US-002",
      cost: RECTIFICATION_COST,
    }));

    const statusWriter = makeStatusWriter();
    const result = await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: must store both cost components — FAILS until implemented
    const rectMetrics = result.storyMetrics.filter(
      (m) => (m as unknown as Record<string, unknown>).source === "rectification",
    );
    expect(rectMetrics.length).toBeGreaterThan(0);
    const entry = rectMetrics[0] as unknown as Record<string, unknown>;
    expect(entry.originalCost).toBe(ORIGINAL_COST);
    expect(entry.rectificationCost).toBe(RECTIFICATION_COST);
  });

  test("storyMetrics rectification entry includes storyId and success: true", async () => {
    const initialPrd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 3.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [
        { storyId: "US-002", conflictFiles: ["src/foo.ts"], originalCost: 1.5 },
      ],
    }));
    // @ts-ignore
    _parallelExecutorDeps.rectifyConflictedStory = mock(async () => ({
      success: true,
      storyId: "US-002",
      cost: 2.0,
    }));

    const statusWriter = makeStatusWriter();
    const result = await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: rectification entry must have core StoryMetrics fields — FAILS
    const entry = result.storyMetrics.find(
      (m) => (m as unknown as Record<string, unknown>).source === "rectification",
    ) as unknown as Record<string, unknown> | undefined;
    expect(entry).toBeDefined();
    expect(entry?.storyId).toBe("US-002");
    expect(entry?.success).toBe(true);
  });
});

// ─── finalConflict (still conflicting after rectification) ────────────────────

describe("MFX-005: finalConflict — story still conflicts after rectification", () => {
  test("story remains failed (not passed) when rectification still conflicts", async () => {
    const initialPrd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 3.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [
        { storyId: "US-002", conflictFiles: ["src/foo.ts"], originalCost: 1.5 },
      ],
    }));
    // @ts-ignore — still conflicts on re-run (structural issue)
    _parallelExecutorDeps.rectifyConflictedStory = mock(async () => ({
      success: false,
      storyId: "US-002",
      conflictFiles: ["src/foo.ts"],
      finalConflict: true,
      cost: 1.0,
    }));

    const statusWriter = makeStatusWriter();
    const result = await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: finalConflict story must NOT be passed — FAILS until implemented
    const us002 = result.prd.userStories.find((s) => s.id === "US-002");
    expect(us002?.status).not.toBe("passed");
  });

  test("rectificationStats shows rectified: 0, stillConflicting: 1 for finalConflict", async () => {
    const initialPrd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 3.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [
        { storyId: "US-002", conflictFiles: ["src/foo.ts"], originalCost: 1.5 },
      ],
    }));
    // @ts-ignore
    _parallelExecutorDeps.rectifyConflictedStory = mock(async () => ({
      success: false,
      storyId: "US-002",
      conflictFiles: ["src/foo.ts"],
      finalConflict: true,
      cost: 1.0,
    }));

    const statusWriter = makeStatusWriter();
    const result = await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: stats must reflect the still-conflicting story — FAILS until implemented
    const stats = (result as unknown as Record<string, unknown>).rectificationStats as Record<
      string,
      number
    >;
    expect(stats).toBeDefined();
    expect(stats?.rectified).toBe(0);
    expect(stats?.stillConflicting).toBe(1);
  });

  test("finalConflict story is excluded from storiesCompleted", async () => {
    const initialPrd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 3.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [
        { storyId: "US-002", conflictFiles: ["src/foo.ts"], originalCost: 1.5 },
      ],
    }));
    // @ts-ignore
    _parallelExecutorDeps.rectifyConflictedStory = mock(async () => ({
      success: false,
      storyId: "US-002",
      conflictFiles: ["src/foo.ts"],
      finalConflict: true,
      cost: 1.0,
    }));

    const statusWriter = makeStatusWriter();
    // starts at 0; parallel completes US-001 (storiesCompleted becomes 1 via executeParallel)
    const result = await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: only US-001 (passed via parallel) should be counted — FAILS until implemented
    expect(result.storiesCompleted).toBe(1);
  });

  test("mixed batch: 2 conflicted, 1 rectified + 1 finalConflict", async () => {
    const initialPrd = makePrd([
      makeStory("US-001"),
      makeStory("US-002"),
      makeStory("US-003"),
    ]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
      makeStory("US-003", "failed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 5.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [
        { storyId: "US-002", conflictFiles: ["src/a.ts"], originalCost: 2.0 },
        { storyId: "US-003", conflictFiles: ["src/b.ts"], originalCost: 2.0 },
      ],
    }));

    let callCount = 0;
    // @ts-ignore — US-002 succeeds, US-003 still conflicts
    _parallelExecutorDeps.rectifyConflictedStory = mock(
      async ({ storyId }: { storyId: string }) => {
        callCount++;
        if (storyId === "US-002") {
          return { success: true, storyId, cost: 1.5 };
        }
        return { success: false, storyId, conflictFiles: ["src/b.ts"], finalConflict: true, cost: 1.0 };
      },
    );

    const statusWriter = makeStatusWriter();
    const result = await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: both stories must be processed — FAILS until implemented
    expect(callCount).toBe(2);
    const stats = (result as unknown as Record<string, unknown>).rectificationStats as Record<
      string,
      number
    >;
    expect(stats?.rectified).toBe(1);
    expect(stats?.stillConflicting).toBe(1);
  });
});

// ─── Sequential ordering ──────────────────────────────────────────────────────

describe("MFX-005: rectification runs strictly sequentially", () => {
  test("stories are rectified one at a time in queue order", async () => {
    const initialPrd = makePrd([
      makeStory("US-001"),
      makeStory("US-002"),
      makeStory("US-003"),
    ]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
      makeStory("US-003", "failed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 5.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [
        { storyId: "US-002", conflictFiles: ["src/a.ts"], originalCost: 2.0 },
        { storyId: "US-003", conflictFiles: ["src/b.ts"], originalCost: 2.0 },
      ],
    }));

    const callOrder: string[] = [];
    // @ts-ignore
    _parallelExecutorDeps.rectifyConflictedStory = mock(
      async ({ storyId }: { storyId: string }) => {
        callOrder.push(storyId);
        return { success: true, storyId, cost: 1.0 };
      },
    );

    const statusWriter = makeStatusWriter();
    await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: order must match queue order — FAILS until implemented
    expect(callOrder).toEqual(["US-002", "US-003"]);
  });

  test("second story in queue sees first rectified story in merged base", async () => {
    // The rectification must be sequential so US-003 sees US-002 already merged.
    // We verify this by confirming rectifyConflictedStory is called once per story
    // (not batched), which ensures each call is on the updated base.
    const initialPrd = makePrd([
      makeStory("US-001"),
      makeStory("US-002"),
      makeStory("US-003"),
    ]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
      makeStory("US-003", "failed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 5.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [
        { storyId: "US-002", conflictFiles: ["src/a.ts"], originalCost: 2.0 },
        { storyId: "US-003", conflictFiles: ["src/b.ts"], originalCost: 2.0 },
      ],
    }));

    const startTimes: number[] = [];
    const endTimes: number[] = [];
    // @ts-ignore
    _parallelExecutorDeps.rectifyConflictedStory = mock(async () => {
      const start = Date.now();
      startTimes.push(start);
      // Small delay to make timing detectable
      await Bun.sleep(5);
      endTimes.push(Date.now());
      return { success: true, storyId: "US-002", cost: 1.0 };
    });

    const statusWriter = makeStatusWriter();
    await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: sequential — second call starts after first ends — FAILS until implemented
    if (startTimes.length >= 2 && endTimes.length >= 1) {
      // Second story must not start before first ends
      expect(startTimes[1]).toBeGreaterThanOrEqual(endTimes[0]);
    } else {
      // If not even called, fail to make the gap obvious
      expect(startTimes.length).toBe(2);
    }
  });
});

// ─── Edge case: verification failure (not merge conflict) ─────────────────────

describe("MFX-005: edge case — verification failure during rectification", () => {
  test("pipeline failure (non-conflict) treated as normal story failure", async () => {
    const initialPrd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 3.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [
        { storyId: "US-002", conflictFiles: ["src/foo.ts"], originalCost: 1.5 },
      ],
    }));
    // @ts-ignore — verification failed, not a merge conflict
    _parallelExecutorDeps.rectifyConflictedStory = mock(async () => ({
      success: false,
      storyId: "US-002",
      pipelineFailure: true,
      finalConflict: false,
      cost: 1.0,
    }));

    const statusWriter = makeStatusWriter();
    const result = await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: pipeline failures are NOT counted as structural conflicts — FAILS until implemented
    const stats = (result as unknown as Record<string, unknown>).rectificationStats as Record<
      string,
      number
    >;
    // A pipeline failure must not inflate stillConflicting
    if (stats) {
      expect(stats.stillConflicting).toBe(0);
    } else {
      // If stats doesn't exist at all, that itself is a failure (handled by other test)
      expect(result).toHaveProperty("rectificationStats");
    }
  });

  test("pipeline failure story is excluded from storiesCompleted", async () => {
    const initialPrd = makePrd([makeStory("US-001"), makeStory("US-002")]);
    const postParallelPrd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
    ]);

    _parallelExecutorDeps.fireHook = mock(async () => {});
    _parallelExecutorDeps.executeParallel = mock(async () => ({
      storiesCompleted: 1,
      totalCost: 3.0,
      updatedPrd: postParallelPrd,
      conflictedStories: [
        { storyId: "US-002", conflictFiles: ["src/foo.ts"], originalCost: 1.5 },
      ],
    }));
    // @ts-ignore
    _parallelExecutorDeps.rectifyConflictedStory = mock(async () => ({
      success: false,
      storyId: "US-002",
      pipelineFailure: true,
      finalConflict: false,
      cost: 1.0,
    }));

    const statusWriter = makeStatusWriter();
    const result = await runParallelExecution(makeOptions(statusWriter), initialPrd);

    // MFX-005: only US-001 (parallel) should be completed — FAILS until implemented
    expect(result.storiesCompleted).toBe(1);
  });
});
