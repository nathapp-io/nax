import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config/defaults";
import {
  _parallelWorkerDeps,
  executeParallelBatch,
  executeStoryInWorktree,
} from "@/execution/parallel-worker";
import { defaultPipeline } from "@/pipeline/stages";
import type { PipelineContext, PipelineStage } from "@/pipeline/types";
import type { PRD, UserStory } from "@/prd/types";
import type { WorktreeDependencyContext } from "@/worktree/types";

function makeStory(id: string): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: [`AC-1: ${id}`],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
  };
}

function makeContext(
  config: NaxConfig = DEFAULT_CONFIG as NaxConfig,
): Omit<PipelineContext, "story" | "stories" | "workdir" | "routing"> {
  return {
    config,
    rootConfig: config,
    prd: {} as PRD,
    hooks: {} as PipelineContext["hooks"],
    plugins: {} as PipelineContext["plugins"],
    storyStartTime: new Date().toISOString(),
  } as Omit<PipelineContext, "story" | "stories" | "workdir" | "routing">;
}

const originalDeps = { ..._parallelWorkerDeps };

afterEach(() => {
  Object.assign(_parallelWorkerDeps, originalDeps);
  mock.restore();
});

describe("executeParallelBatch", () => {
  test("routes each story with its effective per-story config when provided", async () => {
    const story = makeStory("US-001");
    const rootConfig = DEFAULT_CONFIG as NaxConfig;
    const storyConfig = {
      ...rootConfig,
      routing: {
        ...rootConfig.routing,
        strategy: "llm",
      },
    } as NaxConfig;

    const routeTaskMock = mock(() => ({ complexity: "simple", modelTier: "fast", testStrategy: "test-after" }));
    const executeStoryMock = mock(async () => ({
      success: true,
      cost: 0.25,
    }));
    _parallelWorkerDeps.routeTask = routeTaskMock as typeof _parallelWorkerDeps.routeTask;
    _parallelWorkerDeps.executeStoryInWorktree = executeStoryMock as typeof _parallelWorkerDeps.executeStoryInWorktree;

    const result = await executeParallelBatch(
      [story],
      "/repo",
      rootConfig,
      makeContext(rootConfig),
      new Map([[story.id, "/repo/.nax-wt/US-001"]]),
      new Map([[story.id, { cwd: "/repo/.nax-wt/US-001/packages/app" }]]),
      1,
      undefined,
      new Map([[story.id, storyConfig]]),
    );

    expect(routeTaskMock).toHaveBeenCalledWith(
      story.title,
      story.description,
      story.acceptanceCriteria,
      story.tags,
      storyConfig,
    );
    expect(executeStoryMock).toHaveBeenCalled();
    expect(result.pipelinePassed).toEqual([story]);
  });

  // Regression: the scheduler chained .then().finally() with no .catch(), so a
  // rejecting execution propagated out of Promise.race/Promise.all and abandoned
  // sibling stories still running in their worktrees — their results were lost
  // and the rejection surfaced as an unhandled rejection.
  test("records a rejected story as failed instead of aborting the batch", async () => {
    const stories = ["US-001", "US-002", "US-003"].map(makeStory);
    const config = DEFAULT_CONFIG as NaxConfig;

    _parallelWorkerDeps.routeTask = mock(() => ({
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
    })) as typeof _parallelWorkerDeps.routeTask;

    _parallelWorkerDeps.executeStoryInWorktree = mock(async (story: UserStory) => {
      if (story.id === "US-001") throw new Error("worktree exploded");
      await new Promise((r) => setTimeout(r, 20));
      return { success: true, cost: 0.5 };
    }) as typeof _parallelWorkerDeps.executeStoryInWorktree;

    const result = await executeParallelBatch(
      stories,
      "/repo",
      config,
      makeContext(config),
      new Map(stories.map((s) => [s.id, `/repo/.nax-wt/${s.id}`])),
      new Map(stories.map((s) => [s.id, { cwd: `/repo/.nax-wt/${s.id}` }])),
      3,
    );

    // The thrower is recorded, not swallowed and not fatal.
    expect(result.failed.map((f) => f.story.id)).toEqual(["US-001"]);
    expect(result.failed[0].error).toContain("worktree exploded");

    // Crucially, the siblings still completed and their results were kept.
    expect(result.pipelinePassed.map((s) => s.id).sort()).toEqual(["US-002", "US-003"]);
    expect(result.totalCost).toBeCloseTo(1.0, 5);
  });
});

describe("executeStoryInWorktree — cost includes stageCost (BUG-7)", () => {
  // Secondary-agent spend within pipeline stages (semantic/adversarial review,
  // rectification, gate-triage probes) accumulates in PipelineRunResult.stageCost.
  // executeStoryInWorktree previously reported only agentResult.estimatedCostUsd,
  // silently dropping stageCost from the parallel-mode cost accounting. Splice a
  // fake stage into the real defaultPipeline array (no injectable seam exists for
  // the stage list itself) to exercise the real runPipeline → cost-return path.
  let workdir: string;
  let originalStages: PipelineStage[];

  function withFakeStage(stage: PipelineStage): void {
    defaultPipeline.length = 0;
    defaultPipeline.push(stage);
  }

  function restoreStages(): void {
    defaultPipeline.length = 0;
    defaultPipeline.push(...originalStages);
  }

  beforeEach(() => {
    originalStages = [...defaultPipeline];
  });

  afterEach(() => {
    restoreStages();
  });

  test("sums stageCost with agentResult.estimatedCostUsd when both are present", async () => {
    workdir = makeTempDir("nax-parallel-worker-cost-");
    withFakeStage({
      name: "fake-cost-stage",
      enabled: () => true,
      async execute(ctx: PipelineContext) {
        ctx.agentResult = {
          success: true,
          exitCode: 0,
          output: "",
          rateLimited: false,
          durationMs: 0,
          estimatedCostUsd: 2,
        };
        return { action: "fail", reason: "simulated failure", cost: 0.5 };
      },
    });

    try {
      const story = makeStory("US-cost-001");
      const dependencyContext: WorktreeDependencyContext = { cwd: workdir };
      const result = await executeStoryInWorktree(story, workdir, dependencyContext, makeContext(), {
        complexity: "simple",
        modelTier: "fast",
        testStrategy: "test-after",
        reasoning: "",
      });

      expect(result.success).toBe(false);
      // Regression guard: (agentResult.estimatedCostUsd ?? 0) + (stageCost ?? 0) = 2 + 0.5
      expect(result.cost).toBeCloseTo(2.5, 5);
    } finally {
      cleanupTempDir(workdir);
    }
  });

  test("reports stageCost alone when no agentResult is present", async () => {
    workdir = makeTempDir("nax-parallel-worker-cost-");
    withFakeStage({
      name: "fake-cost-stage",
      enabled: () => true,
      async execute() {
        return { action: "fail", reason: "simulated failure", cost: 1.5 };
      },
    });

    try {
      const story = makeStory("US-cost-002");
      const dependencyContext: WorktreeDependencyContext = { cwd: workdir };
      const result = await executeStoryInWorktree(story, workdir, dependencyContext, makeContext(), {
        complexity: "simple",
        modelTier: "fast",
        testStrategy: "test-after",
        reasoning: "",
      });

      expect(result.success).toBe(false);
      // Before BUG-7's fix this was 0 — stageCost was dropped entirely.
      expect(result.cost).toBeCloseTo(1.5, 5);
    } finally {
      cleanupTempDir(workdir);
    }
  });
});
