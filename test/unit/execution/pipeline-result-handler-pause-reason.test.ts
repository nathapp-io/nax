/**
 * Unit tests for pipeline-result-handler.ts — pause-reason persistence (nax#1582)
 *
 * Split out of pipeline-result-handler.test.ts to stay under the 800-line test
 * file cap (.claude/rules/project-conventions.md).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeAgentResult,
  makeMockRuntime,
  makePRD,
  makeStory,
  makeTempDir,
  makeTestContext,
} from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { _resultHandlerDeps, handlePipelineFailure, type PipelineHandlerContext } from "@/execution";
import type { PipelineRunResult } from "@/pipeline";
import { PluginRegistry } from "@/plugins";
import { loadPRD } from "@/prd";
import type { UserStory } from "@/prd/types";

function makeCtx(story: UserStory, overrides: Partial<PipelineHandlerContext> = {}): PipelineHandlerContext {
  const prd = makePRD({ userStories: [story] });
  return {
    config: DEFAULT_CONFIG,
    prd,
    prdPath: "/tmp/prd.json",
    workdir: "/tmp/repo",
    hooks: { hooks: [] } as unknown as PipelineHandlerContext["hooks"], // test-ratchet-allow: as-unknown-as
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
    runtime: makeMockRuntime(),
    ...overrides,
  } as PipelineHandlerContext;
}

describe("handlePipelineFailure — pause-reason persistence (nax#1582)", () => {
  let tempDir: string;
  let prdPath: string;
  let origExistsSync: typeof _resultHandlerDeps.existsSync;

  beforeEach(() => {
    tempDir = makeTempDir("nax-pause-reason-");
    prdPath = join(tempDir, "prd.json");
    origExistsSync = _resultHandlerDeps.existsSync;
    // MEM-6: ctx.workdir here is the shared fake "/tmp/repo" path (not
    // per-test-isolated), so force "no worktree" rather than letting a real,
    // unmocked existsSync/spawn depend on whatever happens to exist on disk.
    _resultHandlerDeps.existsSync = (() => false) as typeof _resultHandlerDeps.existsSync;
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    _resultHandlerDeps.existsSync = origExistsSync;
  });

  test("appends the pipeline reason to priorErrors instead of leaving it empty", async () => {
    const story = makeStory({ id: "US-001", status: "in-progress", passes: false, attempts: 1 });
    const ctx = makeCtx(story, { prdPath });

    const pauseResult: PipelineRunResult = {
      success: false,
      finalAction: "pause",
      reason: "Semantic review failed: 1 findings",
      context: makeTestContext({ agentResult: makeAgentResult() }),
    };

    await handlePipelineFailure(ctx, pauseResult);

    const onDisk = await loadPRD(prdPath);
    const pausedStory = onDisk.userStories.find((s) => s.id === "US-001");
    expect(pausedStory?.status).toBe("paused");
    expect(pausedStory?.priorErrors).toEqual(["PAUSED: Semantic review failed: 1 findings"]);
  });

  test("leaves priorErrors empty when the pipeline result carries no reason", async () => {
    const story = makeStory({ id: "US-002", status: "in-progress", passes: false, attempts: 1 });
    const ctx = makeCtx(story, { prdPath });

    const pauseResult: PipelineRunResult = {
      success: false,
      finalAction: "pause",
      context: makeTestContext({ agentResult: makeAgentResult() }),
    };

    await handlePipelineFailure(ctx, pauseResult);

    const onDisk = await loadPRD(prdPath);
    const pausedStory = onDisk.userStories.find((s) => s.id === "US-002");
    expect(pausedStory?.status).toBe("paused");
    expect(pausedStory?.priorErrors ?? []).toHaveLength(0);
  });

  test("scrubs a fabricated quote in the pipeline reason before persisting (nax#930 convention)", async () => {
    const story = makeStory({ id: "US-003", status: "in-progress", passes: false, attempts: 1 });
    const ctx = makeCtx(story, { prdPath });

    const pauseResult: PipelineRunResult = {
      success: false,
      finalAction: "pause",
      reason: "src/does-not-exist.ts:1 says `this quote is fabricated`",
      context: makeTestContext({ agentResult: makeAgentResult() }),
    };

    await handlePipelineFailure(ctx, pauseResult);

    const onDisk = await loadPRD(prdPath);
    const pausedStory = onDisk.userStories.find((s) => s.id === "US-003");
    expect(pausedStory?.priorErrors?.[0]).toContain("<UNVERIFIED_QUOTE>");
    expect(pausedStory?.priorErrors?.[0]).not.toContain("this quote is fabricated");
  });
});
