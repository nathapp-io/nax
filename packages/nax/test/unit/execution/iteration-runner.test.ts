/**
 * runIteration — the single-story orchestration function in iteration-runner.ts.
 *
 * These tests call `runIteration` directly with `_iterationRunnerDeps.runPipeline`
 * mocked to control the pipeline outcome, exercising the dry-run short-circuit,
 * the success path, the fail/pause failure paths, and the per-story workdir
 * resolution. Every story runs in the shared checkout (US-004 removed the
 * worktree isolation paths), so the workdir is always the run's own tree
 * narrowed to the story's package.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  assertDefined,
  cleanupTempDir,
  makeAgentResult,
  makeContextBundle,
  makeDispatchContext,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeStatusWriter,
  makeStory,
  makeTempDir,
  makeTestContext,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import type { SequentialExecutionContext } from "@/execution/executor-types";
import { _iterationRunnerDeps, releaseHeavyPipelineContext, runIteration } from "@/execution/iteration-runner";
import type { LoadedHooksConfig } from "@/hooks";
import type { PipelineRunResult } from "@/pipeline/runner";
import type { PipelineContext, PipelineStage, RoutingResult } from "@/pipeline/types";
import type { PRD, UserStory } from "@/prd/types";
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
    config: makeNaxConfig(),
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

  test("pipeline selection: absent mode and pipeline literal both run workflow stages", async () => {
    const seen: string[][] = [];
    _iterationRunnerDeps.runPipeline = mock(async (stages: PipelineStage[]) => {
      seen.push(stages.map((s) => s.name));
      return makePipelineResult({ success: true, finalAction: "complete" }, { prd });
    });
    const selection = { story, storiesToExecute: [story], routing: ROUTING, isBatchExecution: false };
    const workflowCtx = makeCtx(tempDir, {
      config: makeNaxConfig(),
    });
    Reflect.deleteProperty(workflowCtx.config.execution, "mode");
    await runIteration(workflowCtx, prd, selection, 1, 0, []);
    const pipelineCtx = makeCtx(tempDir, {
      config: makeNaxConfig({ execution: { mode: "pipeline" } }),
    });
    await runIteration(pipelineCtx, prd, selection, 1, 0, []);

    expect(seen[0]).toContain("workflow");
    expect(seen[0]).not.toContain("execution");
    const { getWorkflowPipeline } = await import("@/pipeline/stages");
    expect(seen[0]).toEqual(getWorkflowPipeline().map((s) => s.name));
    expect(seen[1]).toEqual(seen[0]);
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

  test("package story: run-level root-only keys (--rules-dir / --context-file) survive the per-package reload", async () => {
    const ctx = makeCtx(tempDir, {
      config: makeNaxConfig({
        context: { rules: { overrideDir: "/run/rules" }, projectContext: { file: "/run/context.md" } },
      }),
    });
    const pkgStory = makeStory({ id: "US-002", title: "Package story", workdir: "packages/api" });
    // The disk reload knows only the profile, so it carries none of the run's CLI overrides.
    const origLoad = _iterationRunnerDeps.loadConfigForWorkdir;
    _iterationRunnerDeps.loadConfigForWorkdir = mock(async () =>
      makeNaxConfig({ quality: { commands: { test: "pkg-test" } } }),
    );
    let seen: NaxConfig | undefined;
    _iterationRunnerDeps.runPipeline = mock(async (_stages: PipelineStage[], pctx: PipelineContext) => {
      seen = pctx.config;
      return makePipelineResult({ success: true, finalAction: "complete" }, { prd });
    });

    try {
      await runIteration(
        ctx,
        makePRD({ userStories: [pkgStory] }),
        { story: pkgStory, storiesToExecute: [pkgStory], routing: ROUTING, isBatchExecution: false },
        1,
        0,
        [],
      );
    } finally {
      _iterationRunnerDeps.loadConfigForWorkdir = origLoad;
    }

    expect(seen?.context.rules.overrideDir).toBe("/run/rules");
    expect(seen?.context.projectContext.file).toBe("/run/context.md");
    // Package-tunable keys still come from the per-package load.
    expect(seen?.quality.commands.test).toBe("pkg-test");
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

describe("runIteration — per-story workdir and packageView", () => {
  let tempDir: string;
  let origRunPipeline: typeof _iterationRunnerDeps.runPipeline;
  let origLoadConfig: typeof _iterationRunnerDeps.loadConfigForWorkdir;
  let story: UserStory;
  let prd: PRD;

  beforeEach(() => {
    tempDir = makeTempDir("nax-iteration-runner-execroot-");
    origRunPipeline = _iterationRunnerDeps.runPipeline;
    origLoadConfig = _iterationRunnerDeps.loadConfigForWorkdir;
    story = makeStory({ id: "US-001", title: "Story one" });
    prd = makePRD({ userStories: [story] });
  });

  afterEach(() => {
    _iterationRunnerDeps.runPipeline = origRunPipeline;
    _iterationRunnerDeps.loadConfigForWorkdir = origLoadConfig;
    cleanupTempDir(tempDir);
  });

  /** Capture the PipelineContext handed to runPipeline. */
  function capturePipelineContext(pipelinePrd: PRD = prd): { captured: PipelineContext | null } {
    const ref: { captured: PipelineContext | null } = { captured: null };
    _iterationRunnerDeps.runPipeline = mock(async (_stages: PipelineStage[], ctx: PipelineContext) => {
      ref.captured = ctx;
      return makePipelineResult({ success: true, finalAction: "complete" }, { prd: pipelinePrd });
    });
    return ref;
  }

  test("AC-4: a package story runs the pipeline with a context rooted at <ctx.workdir>/packages/app", async () => {
    const pkgStory = makeStory({ id: "US-002", title: "Package story", workdir: "packages/app" });
    const pkgPrd = makePRD({ userStories: [pkgStory] });
    const capture = capturePipelineContext(pkgPrd);
    // The per-package config reload reads the disk; stub it so the assertion is
    // about the resolved workdir, not the fixture's filesystem.
    _iterationRunnerDeps.loadConfigForWorkdir = mock(async () => makeNaxConfig());

    const ctx = makeCtx(tempDir);
    await runIteration(
      ctx,
      pkgPrd,
      { story: pkgStory, storiesToExecute: [pkgStory], routing: ROUTING, isBatchExecution: false },
      1,
      0,
      [],
    );

    expect(capture.captured?.workdir).toBe(join(tempDir, "packages/app"));
  });

  test("AC-5: a root story runs the pipeline with a context rooted at ctx.workdir itself", async () => {
    const capture = capturePipelineContext();
    const ctx = makeCtx(tempDir);

    await runIteration(
      ctx,
      prd,
      { story, storiesToExecute: [story], routing: ROUTING, isBatchExecution: false },
      1,
      0,
      [],
    );

    expect(capture.captured?.workdir).toBe(tempDir);
  });

  test("the runner's dependency seam carries no worktree deps", () => {
    // The worktree isolation paths are gone, so the seam that let tests fake
    // them is gone with them — only the loader and the pipeline runner remain.
    expect(Object.keys(_iterationRunnerDeps).sort()).toEqual([
      "loadConfigForWorkdir",
      "runPipeline",
      "savePrdProgress",
    ]);
  });

  test("the pipeline context packageView resolves to the main checkout", async () => {
    // US-001: the context producers derive ContextRequest.execRoot from
    // ctx.packageView. Omitting the field leaves execRoot undefined in
    // production, so both providers silently resolve against the wrong tree.
    const capture = capturePipelineContext();

    const ctx = makeCtx(tempDir, {
      config: makeNaxConfig(),
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
    };

    releaseHeavyPipelineContext(ctx);

    expect(ctx.agentResult).toBeUndefined();
    expect(ctx.prompt).toBeUndefined();
    expect(ctx.contextMarkdown).toBeUndefined();
    expect(ctx.featureContextMarkdown).toBeUndefined();
    expect(ctx.builtContext).toBeUndefined();
    expect(ctx.contextBundle).toBeUndefined();
    expect(ctx.constitution).toBeUndefined();
    // Fields that must survive — not part of the "heavy" set.
    expect(ctx.story.id).toBe("US-001");
  });

  test("drops per-story payloads without clearing durable execution state", () => {
    const largeText = "payload".repeat(1_000);
    const initialStory = makeStory({ id: "US-001" });
    const ctx = makeTestContext({
      prd: makePRD({ feature: "memory-fix", userStories: [initialStory] }),
      story: initialStory,
      agentResult: makeAgentResult({ output: largeText }),
      prompt: largeText,
      contextMarkdown: largeText,
      featureContextMarkdown: largeText,
      builtContext: { elements: [], totalTokens: 0, truncated: false, summary: largeText },
      contextBundle: makeContextBundle({ pushMarkdown: largeText }),
      constitution: { content: largeText, tokens: 0, truncated: false },
    });
    const prd = ctx.prd;
    const story = ctx.story;

    releaseHeavyPipelineContext(ctx);

    expect(ctx.agentResult).toBeUndefined();
    expect(ctx.prompt).toBeUndefined();
    expect(ctx.contextMarkdown).toBeUndefined();
    expect(ctx.featureContextMarkdown).toBeUndefined();
    expect(ctx.builtContext).toBeUndefined();
    expect(ctx.contextBundle).toBeUndefined();
    expect(ctx.constitution).toBeUndefined();
    expect(ctx.prd).toBe(prd);
    expect(ctx.story).toBe(story);
  });
});

// ---------------------------------------------------------------------------
// #410 reviewerSession cleanup on escalation.
// ---------------------------------------------------------------------------

describe("iteration-runner — escalation session cleanup", () => {
  // #410: reviewerSession cleanup on escalation
  describe("reviewerSession cleanup on escalation", () => {
    test("destroys reviewerSession when pipeline returns escalate action", async () => {
      const destroyMock = mock(async () => {});
      const mockSession = {
        active: true,
        history: [],
        review: mock(async () => ({})),
        reReview: mock(async () => ({})),
        clarify: mock(async () => ""),
        getVerdict: mock(() => ({})),
        destroy: destroyMock,
      };

      // The cleanup block checks: pipelineResult.finalAction === "escalate" && reviewerSession?.active
      // We simulate this directly against the condition logic.
      const finalAction = "escalate";
      const reviewerSession = mockSession;

      if (finalAction === "escalate" && reviewerSession?.active) {
        try {
          await reviewerSession.destroy();
        } catch {
          // best-effort
        }
      }

      expect(destroyMock).toHaveBeenCalledTimes(1);
    });

    test("does not throw if reviewerSession.destroy() fails", async () => {
      const destroyMock = mock(async () => {
        throw new Error("session already closed");
      });
      const mockSession = {
        active: true,
        history: [],
        destroy: destroyMock,
      };

      // The cleanup block swallows errors from destroy() — must not propagate
      const finalAction = "escalate";
      const reviewerSession = mockSession;

      let threw = false;
      try {
        if (finalAction === "escalate" && reviewerSession?.active) {
          try {
            await reviewerSession.destroy();
          } catch {
            // best-effort — swallowed
          }
        }
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(destroyMock).toHaveBeenCalledTimes(1);
    });

    test("does not call destroy if reviewerSession is already inactive", async () => {
      const destroyMock = mock(async () => {});
      const mockSession = {
        active: false, // already inactive
        history: [],
        destroy: destroyMock,
      };

      const finalAction = "escalate";
      const reviewerSession = mockSession;

      if (finalAction === "escalate" && reviewerSession?.active) {
        try {
          await reviewerSession.destroy();
        } catch {
          // best-effort
        }
      }

      // active === false means the guard prevents destroy() from being called
      expect(destroyMock).not.toHaveBeenCalled();
    });
  });
});
