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
});
