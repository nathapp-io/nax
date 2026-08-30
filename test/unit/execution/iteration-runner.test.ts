/**
 * runIteration — the single-story orchestration function in iteration-runner.ts.
 *
 * `iteration-runner-worktree.test.ts` and `iteration-runner-memory.test.ts` only
 * exercise `_iterationRunnerDeps` in isolation or inline the same conditional
 * logic without calling `runIteration` — the function itself was 0% covered.
 * These tests call `runIteration` directly (storyIsolation: "shared", the
 * default, so the worktree branch is skipped) with `_iterationRunnerDeps.runPipeline`
 * mocked to control the pipeline outcome, exercising the dry-run short-circuit,
 * the success path, and the fail/pause failure paths.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeContextBundle,
  makeDispatchContext,
  makeFinding,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeStatusWriter,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import type { SequentialExecutionContext } from "@/execution/executor-types";
import { _iterationRunnerDeps, releaseHeavyPipelineContext, runIteration } from "@/execution/iteration-runner";
import type { IsolationCheck } from "@/execution/types";
import type { LoadedHooksConfig } from "@/hooks";
import type { PipelineRunResult } from "@/pipeline/runner";
import type { PipelineContext, RoutingResult } from "@/pipeline/types";
import type { PRD, UserStory } from "@/prd/types";
import type { SelfVerificationResult } from "@/quality";

const EMPTY_HOOKS: LoadedHooksConfig = { hooks: {} };

const ROUTING: RoutingResult = {
  complexity: "simple",
  modelTier: "fast",
  testStrategy: "test-after",
  reasoning: "test",
};

function makeCtx(tempDir: string, overrides: Record<string, unknown> = {}): SequentialExecutionContext {
  return {
    prdPath: join(tempDir, "prd.json"),
    workdir: tempDir,
    config: makeNaxConfig({ execution: { storyIsolation: "shared" } }),
    hooks: EMPTY_HOOKS,
    feature: "test-feature",
    dryRun: false,
    useBatch: false,
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter(),
    runId: "run-test",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    ...makeDispatchContext({ runtime: makeMockRuntime({ workdir: tempDir }) }),
    ...overrides,
  } as SequentialExecutionContext;
}

function makePipelineResult(
  overrides: Partial<PipelineRunResult> = {},
  ctxOverrides: Partial<PipelineContext> = {},
): PipelineRunResult {
  return {
    success: true,
    finalAction: "complete",
    context: { ...ctxOverrides } as PipelineContext,
    ...overrides,
  };
}

describe("runIteration", () => {
  let tempDir: string;
  let origRunPipeline: typeof _iterationRunnerDeps.runPipeline;
  let story: UserStory;
  let prd: PRD;

  beforeEach(() => {
    tempDir = makeTempDir("nax-iteration-runner-");
    origRunPipeline = _iterationRunnerDeps.runPipeline;
    story = makeStory({ id: "US-001", title: "Story one" });
    prd = makePRD({ userStories: [story] });
  });

  afterEach(() => {
    _iterationRunnerDeps.runPipeline = origRunPipeline;
    cleanupTempDir(tempDir);
  });

  test("dry run: delegates to handleDryRun and short-circuits before the pipeline runs", async () => {
    const ctx = makeCtx(tempDir, { dryRun: true });
    const runPipelineMock = mock(async () => makePipelineResult());
    _iterationRunnerDeps.runPipeline = runPipelineMock;

    const result = await runIteration(
      ctx,
      prd,
      { story, storiesToExecute: [story], routing: ROUTING, isBatchExecution: false },
      0,
      0,
      [],
    );

    expect(runPipelineMock).not.toHaveBeenCalled();
    expect(result.prd).toBe(prd);
    expect(result.costDelta).toBe(0);
  });

  test("success path: runs the pipeline and returns storiesCompletedDelta/costDelta from handlePipelineSuccess", async () => {
    const ctx = makeCtx(tempDir);
    const runPipelineMock = mock(async () =>
      makePipelineResult(
        { success: true, finalAction: "complete" },
        { prd, agentResult: { estimatedCostUsd: 0.25 } as PipelineContext["agentResult"] },
      ),
    );
    _iterationRunnerDeps.runPipeline = runPipelineMock;

    const result = await runIteration(
      ctx,
      prd,
      { story, storiesToExecute: [story], routing: ROUTING, isBatchExecution: false },
      1,
      0,
      [],
    );

    expect(runPipelineMock).toHaveBeenCalledTimes(1);
    expect(result.finalAction).toBe("complete");
    expect(result.storiesCompletedDelta).toBe(1);
    expect(result.costDelta).toBeCloseTo(0.25);
    expect(ctx.statusWriter.setPrd).toHaveBeenCalled();
    expect(ctx.statusWriter.setCurrentStory).toHaveBeenCalled();
  });

  test("failure path: 'fail' finalAction marks the story failed, persists the PRD, and surfaces the reason", async () => {
    const ctx = makeCtx(tempDir);
    const runPipelineMock = mock(async () =>
      makePipelineResult({ success: false, finalAction: "fail", reason: "boom", stoppedAtStage: "verify" }, { prd }),
    );
    _iterationRunnerDeps.runPipeline = runPipelineMock;

    const result = await runIteration(
      ctx,
      prd,
      { story, storiesToExecute: [story], routing: ROUTING, isBatchExecution: false },
      1,
      0,
      [],
    );

    expect(result.finalAction).toBe("fail");
    expect(result.reason).toBe("boom");
    expect(result.storiesCompletedDelta).toBe(0);
    expect(result.prdDirty).toBe(true);
    const updatedStory = result.prd.userStories.find((s) => s.id === story.id);
    expect(updatedStory?.status).toBe("failed");
  });

  test("failure path: 'pause' finalAction marks the story paused with the reason", async () => {
    const ctx = makeCtx(tempDir);
    const runPipelineMock = mock(async () =>
      makePipelineResult({ success: false, finalAction: "pause", reason: "waiting on human input" }, { prd }),
    );
    _iterationRunnerDeps.runPipeline = runPipelineMock;

    const result = await runIteration(
      ctx,
      prd,
      { story, storiesToExecute: [story], routing: ROUTING, isBatchExecution: false },
      1,
      0,
      [],
    );

    expect(result.finalAction).toBe("pause");
    const updatedStory = result.prd.userStories.find((s) => s.id === story.id);
    expect(updatedStory?.status).toBe("paused");
  });

  test("escalate finalAction closes live sessions for the story via sessionManager", async () => {
    const closeSession = mock(async () => {});
    const liveHandle = { id: "handle-1" };
    const sessionManager = {
      getForStory: mock(() => [{ handle: "handle-1", state: "RUNNING", role: "implementer" }]),
      getLiveHandle: mock(() => liveHandle),
      closeSession,
    };
    const ctx = makeCtx(tempDir, { sessionManager });
    const runPipelineMock = mock(async () =>
      makePipelineResult({ success: false, finalAction: "escalate", reason: "escalating tier" }, { prd }),
    );
    _iterationRunnerDeps.runPipeline = runPipelineMock;

    await runIteration(
      ctx,
      prd,
      { story, storiesToExecute: [story], routing: ROUTING, isBatchExecution: false },
      1,
      0,
      [],
    );

    expect(closeSession).toHaveBeenCalledWith(liveHandle);
  });

  test("escalate finalAction swallows a rejecting closeSession instead of throwing", async () => {
    const closeSession = mock(() => Promise.reject(new Error("close failed")));
    const liveHandle = { id: "handle-1" };
    const sessionManager = {
      getForStory: mock(() => [{ handle: "handle-1", state: "RUNNING", role: "implementer" }]),
      getLiveHandle: mock(() => liveHandle),
      closeSession,
    };
    const ctx = makeCtx(tempDir, { sessionManager });
    const runPipelineMock = mock(async () =>
      makePipelineResult({ success: false, finalAction: "escalate", reason: "escalating tier" }, { prd }),
    );
    _iterationRunnerDeps.runPipeline = runPipelineMock;

    await expect(
      runIteration(ctx, prd, { story, storiesToExecute: [story], routing: ROUTING, isBatchExecution: false }, 1, 0, []),
    ).resolves.toBeDefined();
  });
});

describe("releaseHeavyPipelineContext", () => {
  test("clears heavy per-story payload fields from the pipeline context", () => {
    const story = makeStory({ id: "US-001" });
    const prd = makePRD({ userStories: [story] });
    const ctx: PipelineContext = {
      ...makeDispatchContext({ runtime: makeMockRuntime() }),
      config: makeNaxConfig(),
      rootConfig: makeNaxConfig(),
      prd,
      story,
      stories: [story],
      routing: ROUTING,
      projectDir: "/tmp/nax-release-heavy-test",
      workdir: "/tmp/nax-release-heavy-test",
      hooks: EMPTY_HOOKS,
      agentResult: {
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        durationMs: 1,
        estimatedCostUsd: 1,
      },
      prompt: "some prompt",
      contextMarkdown: "context",
      featureContextMarkdown: "feature context",
      builtContext: { elements: [], totalTokens: 0, truncated: false, summary: "" },
      contextBundle: makeContextBundle(),
      constitution: { content: "c", tokens: 1, truncated: false },
      acceptanceFailures: { failedACs: ["AC-1"], findings: [makeFinding()], testOutput: "" },
      reviewFindings: [makeFinding()],
      selfVerification: {
        lint: "pass",
        typecheck: "pass",
        preExistingFailures: [],
      } satisfies SelfVerificationResult,
      tddIsolations: {
        implementer: { passed: true, violations: [] } satisfies IsolationCheck,
      },
    };

    releaseHeavyPipelineContext(ctx);

    expect(ctx.agentResult).toBeUndefined();
    expect(ctx.prompt).toBeUndefined();
    expect(ctx.contextMarkdown).toBeUndefined();
    expect(ctx.featureContextMarkdown).toBeUndefined();
    expect(ctx.builtContext).toBeUndefined();
    expect(ctx.contextBundle).toBeUndefined();
    expect(ctx.constitution).toBeUndefined();
    expect(ctx.acceptanceFailures).toBeUndefined();
    expect(ctx.reviewFindings).toBeUndefined();
    expect(ctx.selfVerification).toBeUndefined();
    expect(ctx.tddIsolations).toBeUndefined();
    // Fields that must survive — not part of the "heavy" set.
    expect(ctx.story.id).toBe("US-001");
  });
});
