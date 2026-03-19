/**
 * Unit tests for pipeline-result-handler.ts (ENH-005 — outputFiles capture)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { PRD, UserStory } from "../../../src/prd/types";
import { _gitDeps } from "../../../src/utils/git";
import {
  handlePipelineSuccess,
  type PipelineHandlerContext,
} from "../../../src/execution/pipeline-result-handler";
import type { PipelineRunResult } from "../../../src/pipeline/runner";
import { PluginRegistry } from "../../../src/plugins/registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, overrides: Partial<UserStory> = {}): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "passed",
    passes: true,
    escalations: [],
    attempts: 1,
    ...overrides,
  };
}

function makePRD(stories: UserStory[]): PRD {
  return {
    project: "test",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

function makeMinimalResult(): PipelineRunResult {
  return {
    success: true,
    finalAction: "complete",
    context: {
      agentResult: { estimatedCost: 0 },
      storyMetrics: [],
    } as unknown as PipelineRunResult["context"],
  };
}

function makeCtx(story: UserStory, overrides: Partial<PipelineHandlerContext> = {}): PipelineHandlerContext {
  const prd = makePRD([story]);
  return {
    config: DEFAULT_CONFIG,
    prd,
    prdPath: "/tmp/prd.json",
    workdir: "/tmp/repo",
    hooks: { hooks: [] } as unknown as PipelineHandlerContext["hooks"],
    feature: "test-feature",
    totalCost: 0,
    startTime: Date.now(),
    runId: "run-001",
    pluginRegistry: new PluginRegistry([]),
    story,
    storiesToExecute: [story],
    routing: { complexity: "simple", modelTier: "standard", testStrategy: "test-after", reasoning: "" },
    isBatchExecution: false,
    allStoryMetrics: [],
    storyGitRef: "abc123",
    ...overrides,
  };
}

/** Build a mock spawn that returns the given output as stdout */
function mockSpawnReturning(output: string) {
  return mock((_args: string[], _opts: unknown) => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(output);
    return {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: Promise.resolve(0),
      kill: mock(() => {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let origSpawn: typeof _gitDeps.spawn;

beforeEach(() => {
  origSpawn = _gitDeps.spawn;
});

afterEach(() => {
  _gitDeps.spawn = origSpawn;
  mock.restore();
});

describe("handlePipelineSuccess — outputFiles capture (ENH-005)", () => {
  test("populates outputFiles on story when storyGitRef is set", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: "abc123" });

    _gitDeps.spawn = mockSpawnReturning("src/service.ts\nsrc/handler.ts\n");

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(story.outputFiles).toEqual(["src/service.ts", "src/handler.ts"]);
  });

  test("scopes diff to story.workdir when set", async () => {
    const story = makeStory("US-001", { workdir: "apps/api" });
    const ctx = makeCtx(story, { storyGitRef: "abc123" });

    let capturedArgs: string[] = [];
    _gitDeps.spawn = mock((args: string[], _opts: unknown) => {
      capturedArgs = args as string[];
      const bytes = new TextEncoder().encode("apps/api/src/index.ts\n");
      return {
        stdout: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
        kill: mock(() => {}),
      };
    });

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(capturedArgs).toContain("--");
    expect(capturedArgs).toContain("apps/api/");
    expect(story.outputFiles).toEqual(["apps/api/src/index.ts"]);
  });

  test("does not set outputFiles when storyGitRef is undefined", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: undefined });

    // spawn should not be called
    _gitDeps.spawn = mock(() => { throw new Error("spawn should not be called"); });

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(story.outputFiles).toBeUndefined();
  });

  test("does not set outputFiles when storyGitRef is null", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: null });

    _gitDeps.spawn = mock(() => { throw new Error("spawn should not be called"); });

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(story.outputFiles).toBeUndefined();
  });

  test("filters out .test.ts files from captured output", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: "abc123" });

    _gitDeps.spawn = mockSpawnReturning("src/service.ts\nsrc/service.test.ts\n");

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(story.outputFiles).toEqual(["src/service.ts"]);
  });

  test("filters out bun.lockb from captured output", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: "abc123" });

    _gitDeps.spawn = mockSpawnReturning("src/index.ts\nbun.lockb\n");

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(story.outputFiles).toEqual(["src/index.ts"]);
  });

  test("caps captured files at 15", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: "abc123" });

    const manyFiles = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`).join("\n");
    _gitDeps.spawn = mockSpawnReturning(manyFiles + "\n");

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(story.outputFiles).toHaveLength(15);
  });

  test("does not set outputFiles when all files are filtered out", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: "abc123" });

    _gitDeps.spawn = mockSpawnReturning("bun.lockb\npackage-lock.json\n");

    await handlePipelineSuccess(ctx, makeMinimalResult());

    // filtered.length === 0 → outputFiles not set
    expect(story.outputFiles).toBeUndefined();
  });

  test("is non-fatal when git spawn throws", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: "abc123" });

    _gitDeps.spawn = mock(() => { throw new Error("git not found"); });

    // Should not throw
    const result = await handlePipelineSuccess(ctx, makeMinimalResult());
    expect(result.prdDirty).toBe(true);
    expect(story.outputFiles).toBeUndefined();
  });
});
