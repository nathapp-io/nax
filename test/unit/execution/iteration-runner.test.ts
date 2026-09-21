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
  assertDefined,
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
  makeWorktreeManager,
} from "@test/helpers";
import type { SequentialExecutionContext } from "@/execution/executor-types";
import { _iterationRunnerDeps, releaseHeavyPipelineContext, runIteration } from "@/execution/iteration-runner";
import type { IsolationCheck } from "@/execution/types";
import type { LoadedHooksConfig } from "@/hooks";
import type { PipelineRunResult } from "@/pipeline/runner";
import type { PipelineContext, PipelineStage, RoutingResult } from "@/pipeline/types";
import type { PRD, UserStory } from "@/prd/types";
import type { SelfVerificationResult } from "@/quality";
import { storyExecRoot } from "@/runtime";

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

describe("runIteration — US-001 stamps packageView for the context producers", () => {
  let tempDir: string;
  let origRunPipeline: typeof _iterationRunnerDeps.runPipeline;
  let origExistsSync: typeof _iterationRunnerDeps.existsSync;
  let origPrepareDeps: typeof _iterationRunnerDeps.prepareWorktreeDependencies;
  let origWorktreeManager: typeof _iterationRunnerDeps.worktreeManager;
  let story: UserStory;
  let prd: PRD;

  beforeEach(() => {
    tempDir = makeTempDir("nax-iteration-runner-execroot-");
    origRunPipeline = _iterationRunnerDeps.runPipeline;
    origExistsSync = _iterationRunnerDeps.existsSync;
    origPrepareDeps = _iterationRunnerDeps.prepareWorktreeDependencies;
    origWorktreeManager = _iterationRunnerDeps.worktreeManager;
    story = makeStory({ id: "US-001", title: "Story one" });
    prd = makePRD({ userStories: [story] });
  });

  afterEach(() => {
    _iterationRunnerDeps.runPipeline = origRunPipeline;
    _iterationRunnerDeps.existsSync = origExistsSync;
    _iterationRunnerDeps.prepareWorktreeDependencies = origPrepareDeps;
    _iterationRunnerDeps.worktreeManager = origWorktreeManager;
    cleanupTempDir(tempDir);
  });

  /** Capture the PipelineContext handed to runPipeline. */
  function capturePipelineContext(): { captured: PipelineContext | null } {
    const ref: { captured: PipelineContext | null } = { captured: null };
    _iterationRunnerDeps.runPipeline = mock(async (_stages: PipelineStage[], ctx: PipelineContext) => {
      ref.captured = ctx;
      return makePipelineResult({ success: true, finalAction: "complete" }, { prd });
    });
    return ref;
  }

  test("US-003 AC-5: with no worktree yet, WorktreeManager.create receives story-f-US-001 — not the raw story ID", async () => {
    // First attempt for this story: the worktree does not exist yet, so the
    // runner takes the create() branch.
    const manager = makeWorktreeManager();
    _iterationRunnerDeps.worktreeManager = manager;
    _iterationRunnerDeps.existsSync = () => false;
    // The pipeline result is a failure so the run's post-pipeline handlers stay
    // off the real merge path — this test is about the identity passed to
    // create(), and nothing downstream should need git.
    let capturedStoryId: string | undefined;
    _iterationRunnerDeps.runPipeline = mock(async (_stages: PipelineStage[], ctx: PipelineContext) => {
      capturedStoryId = ctx.story.id;
      return makePipelineResult({ success: false, finalAction: "fail", reason: "boom" }, { prd, workdir: ctx.workdir });
    });

    const ctx = makeCtx(tempDir, {
      feature: "f",
      config: makeNaxConfig({ execution: { storyIsolation: "worktree" } }),
    });

    await runIteration(
      ctx,
      prd,
      { story, storiesToExecute: [story], routing: ROUTING, isBatchExecution: false },
      1,
      0,
      [],
    );

    const createArgs = manager.create.mock.calls[0];
    assertDefined(createArgs, "worktreeManager.create call");
    expect(createArgs[0]).toBe(tempDir);
    // feature "f" + story "US-001" → the composed identity, spelled literally
    // so the assertion does not mirror the producer it is checking.
    expect(String(createArgs[1])).toBe("story-f-US-001");
    expect(String(createArgs[1])).not.toBe(story.id);
    // AC-13: the story the pipeline (and therefore metrics, costs and status)
    // sees keeps its raw ID — the composed identity is a worktree name only.
    expect(capturedStoryId).toBe(story.id);
  });

  test("under worktree isolation the pipeline context carries a packageView rooted at the story's composed worktree", async () => {
    const capture = capturePipelineContext();
    // Worktree already exists → reuse it (skip create()).
    _iterationRunnerDeps.existsSync = () => true;
    // US-003: the runner composes effectiveWorkdir from (feature, storyId) and
    // routes it through the worktree-id producers. prepareWorktreeDependencies
    // is left at its real implementation (mode "off" returns cwd =
    // worktreeRoot unchanged), so the runner is exercised end to end instead
    // of short-circuiting through a mock.
    const composedWorktreePath = join(tempDir, ".nax-wt", "story-f-US-001");

    const ctx = makeCtx(tempDir, {
      feature: "f",
      config: makeNaxConfig({ execution: { storyIsolation: "worktree" } }),
    });

    await runIteration(
      ctx,
      prd,
      { story, storiesToExecute: [story], routing: ROUTING, isBatchExecution: false },
      1,
      0,
      [],
    );

    // US-001 Motivation: the context producers derive ContextRequest.execRoot
    // from ctx.packageView. If this producer omits the field, execRoot is
    // ALWAYS undefined in production and both providers silently resolve
    // against the MAIN checkout — the stale-or-absent-context defect.
    const packageView = capture.captured?.packageView;
    assertDefined(packageView, "pipelineContext.packageView");
    // storyExecRoot(packageView) must land on the COMPOSED worktree root
    // (US-003 AC-6): .nax-wt/story-f-US-001, not the raw .nax-wt/US-001 the
    // pre-US-003 spelling used.
    expect(storyExecRoot(packageView)).toBe(composedWorktreePath);
    expect(storyExecRoot(packageView).endsWith(join(".nax-wt", "story-f-US-001"))).toBe(true);
    expect(storyExecRoot(packageView).endsWith(join(".nax-wt", story.id))).toBe(false);
  });

  test("under shared isolation the packageView resolves to the main checkout", async () => {
    const capture = capturePipelineContext();

    const ctx = makeCtx(tempDir, {
      config: makeNaxConfig({ execution: { storyIsolation: "shared" } }),
    });

    await runIteration(
      ctx,
      prd,
      { story, storiesToExecute: [story], routing: ROUTING, isBatchExecution: false },
      1,
      0,
      [],
    );

    const packageView = capture.captured?.packageView;
    assertDefined(packageView, "pipelineContext.packageView");
    expect(storyExecRoot(packageView)).toBe(tempDir);
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
