import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { _parallelWorkerDeps, executeParallelBatch } from "../../../src/execution/parallel-worker";
import type { NaxConfig } from "../../../src/config";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../src/prd/types";

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
  } as unknown as UserStory;
}

function makeContext(config: NaxConfig = DEFAULT_CONFIG as NaxConfig): Omit<PipelineContext, "story" | "stories" | "workdir" | "routing"> {
  return {
    config,
    rootConfig: config,
    prd: {} as PRD,
    hooks: {} as PipelineContext["hooks"],
    plugins: {} as PipelineContext["plugins"],
    storyStartTime: new Date().toISOString(),
  } as unknown as Omit<PipelineContext, "story" | "stories" | "workdir" | "routing">;
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
    _parallelWorkerDeps.executeStoryInWorktree =
      executeStoryMock as typeof _parallelWorkerDeps.executeStoryInWorktree;

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
    }) as unknown as typeof _parallelWorkerDeps.executeStoryInWorktree;

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
