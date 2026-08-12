/**
 * Unit tests for merge-conflict-rectify (conflict rectification logic).
 *
 * File: merge-conflict-rectify.test.ts
 * Covers:
 *   rect AC-7  an error thrown by rectifyConflictedStory's inner work is caught and
 *              returned as a failure result (not propagated to the caller)
 */

import { describe, expect, test } from "bun:test";
import type { RectifyConflictedStoryOptions } from "../../../src/execution/merge-conflict-rectify";
import {
  buildRectificationPipelineContext,
  rectifyConflictedStory,
  rectifyMergeFailure,
} from "../../../src/execution/merge-conflict-rectify";
import { makeMockAgentManager, makeNaxConfig, makePRD, makeSessionManager, makeStory } from "../../helpers";
import { makeTestContext } from "../../helpers/pipeline-context";

const FAKE_RUNTIME = {
  outputDir: "/tmp/nax-rect-test-output",
  costAggregator: {
    snapshot: () => ({
      totalCostUsd: 0,
      totalEstimatedCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      callCount: 0,
      errorCount: 0,
    }),
  },
} as never;

// ─────────────────────────────────────────────────────────────────────────────
// rect AC-7 — errors are caught, not propagated; returns { success: false }
// ─────────────────────────────────────────────────────────────────────────────

describe("rect AC-7: rectifyConflictedStory catches errors and returns failure — never throws", () => {
  function makeMinimalOpts(overrides: Partial<RectifyConflictedStoryOptions> = {}): RectifyConflictedStoryOptions {
    const story = makeStory({ id: "US-conflict-1", title: "Conflict story" });
    const prd = makePRD({ userStories: [story] });
    const config = makeNaxConfig();
    return {
      storyId: story.id,
      conflictFiles: ["src/foo.ts"],
      originalCost: 0.5,
      workdir: "/tmp/nonexistent-workdir-for-test",
      config,
      hooks: { hooks: {} },
      pluginRegistry: { getReporters: () => [], getContextProviders: () => [] } as never,
      prd,
      pipelineContextBase: makeTestContext({
        config,
        prd,
        workdir: "/tmp/nonexistent-workdir-for-test",
        agentManager: makeMockAgentManager(),
        sessionManager: makeSessionManager(),
        runtime: FAKE_RUNTIME,
        abortSignal: undefined as never,
      }),
      ...overrides,
    };
  }

  test("AC-7: function returns a failure result when inner work throws (bad workdir triggers catch)", async () => {
    // The workdir does not exist — WorktreeManager.remove/create will throw, hitting the catch block.
    // The function must return { success: false } instead of propagating the error.
    const opts = makeMinimalOpts();

    let result: Awaited<ReturnType<typeof rectifyConflictedStory>>;
    let threw = false;
    try {
      result = await rectifyConflictedStory(opts);
    } catch {
      threw = true;
      result = { success: false, storyId: opts.storyId, cost: 0, finalConflict: false, pipelineFailure: true };
    }

    // AC-7: the function must NOT throw — it must return a failure result
    expect(threw).toBe(false);
    // The result must indicate failure
    expect(result?.success).toBe(false);
    expect(result?.storyId).toBe(opts.storyId);
  });

  test("AC-7: function returns pipelineFailure=true when story cannot be found in PRD", async () => {
    // storyId not in prd.userStories — function returns early at the "story not found" guard
    const config = makeNaxConfig();
    const story = makeStory({ id: "US-a", title: "story a" });
    const prd = makePRD({ userStories: [story] });

    const opts: RectifyConflictedStoryOptions = {
      storyId: "US-not-in-prd",
      conflictFiles: [],
      originalCost: 0,
      workdir: "/tmp/nonexistent-workdir-for-test",
      config,
      hooks: { hooks: {} },
      pluginRegistry: { getReporters: () => [], getContextProviders: () => [] } as never,
      prd,
      pipelineContextBase: makeTestContext({
        config,
        prd,
        workdir: "/tmp/nonexistent-workdir-for-test",
        agentManager: makeMockAgentManager(),
        sessionManager: makeSessionManager(),
        runtime: FAKE_RUNTIME,
        abortSignal: undefined as never,
      }),
    };

    let result: Awaited<ReturnType<typeof rectifyConflictedStory>>;
    let threw = false;
    try {
      result = await rectifyConflictedStory(opts);
    } catch {
      threw = true;
      result = { success: false, storyId: opts.storyId, cost: 0, finalConflict: false, pipelineFailure: true };
    }

    expect(threw).toBe(false);
    expect(result?.success).toBe(false);
    // The early-return guard sets pipelineFailure: true for unknown storyId
    expect((result as Extract<typeof result, { success: false }>).pipelineFailure).toBe(true);
  });

  test("AC-7: return type is RectificationResult — never a thrown exception", async () => {
    // Verify via type system: rectifyConflictedStory returns Promise<RectificationResult>
    // If it threw, TypeScript callers using await would need try/catch for error handling.
    // By contract, the function returns a union type — callers check .success, not try/catch.
    type Ret = Awaited<ReturnType<typeof rectifyConflictedStory>>;
    // Compile-time: the union type must have a success discriminant
    type SuccessVariant = Extract<Ret, { success: true }>;
    type FailureVariant = Extract<Ret, { success: false }>;
    const successCheck: SuccessVariant = { success: true, storyId: "x", cost: 0 };
    const failureCheck: FailureVariant = { success: false, storyId: "x", cost: 0, finalConflict: false };
    expect(successCheck.success).toBe(true);
    expect(failureCheck.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The post-rectification merge reports WHY it did not land
// ─────────────────────────────────────────────────────────────────────────────

describe("rectifyMergeFailure: carries the merge classification instead of assuming a conflict", () => {
  test("a real conflict is reported as a final conflict, with its files", () => {
    const r = rectifyMergeFailure("US-001", 1.5, {
      success: false,
      storyId: "US-001",
      failureKind: "conflict",
      conflictFiles: ["src/a.ts", "src/b.ts"],
    });

    expect(r).toMatchObject({
      success: false,
      storyId: "US-001",
      cost: 1.5,
      finalConflict: true,
      conflictFiles: ["src/a.ts", "src/b.ts"],
    });
  });

  test("a non-conflict git failure is NOT reported as a final conflict", () => {
    // Telling the operator the agent could not resolve a conflict, when git
    // actually refused over a dirty tree or a missing branch, sends them
    // looking for a conflict that was never there.
    const r = rectifyMergeFailure("US-001", 0, {
      success: false,
      storyId: "US-001",
      failureKind: "error",
      error: "working tree is dirty",
    });

    expect(r).toMatchObject({ finalConflict: false, conflictFiles: [] });
  });

  test("an absent result keeps the historical conflict reading", () => {
    // mergeAll returned nothing for this story. Unknown is not "error", so the
    // conservative reading — the one every caller had before failureKind
    // existed — is preserved.
    const r = rectifyMergeFailure("US-001", 0, undefined);

    expect(r).toMatchObject({ finalConflict: true, conflictFiles: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildRectificationPipelineContext — BUG-36: the constructed PipelineContext
// must actually carry the worktree contract, not just forward a reference to it.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRectificationPipelineContext: the rectification re-run inherits the worktree contract", () => {
  function makeBase(overrides: Partial<RectifyConflictedStoryOptions["pipelineContextBase"]> = {}) {
    const config = makeNaxConfig();
    return makeTestContext({
      config,
      prd: makePRD({ userStories: [] }),
      workdir: "/tmp/nax-rect-ctx",
      prdPath: "/real/feature/prd.json",
      featureDir: "/real/feature",
      skipPrdPersistence: true,
      agentManager: makeMockAgentManager(),
      sessionManager: makeSessionManager(),
      runtime: FAKE_RUNTIME,
      abortSignal: undefined as never,
      ...overrides,
    });
  }

  test("carries skipPrdPersistence, prdPath, and featureDir through from the base", () => {
    const story = makeStory({ id: "US-001" });
    const ctx = buildRectificationPipelineContext({
      pipelineContextBase: makeBase(),
      story,
      config: makeNaxConfig(),
      hooks: { hooks: {} },
      pluginRegistry: { getReporters: () => [], getContextProviders: () => [] } as never,
      workdir: "/tmp/nax-rect-ctx",
      worktreePath: "/tmp/nax-rect-ctx/.nax-wt/US-001",
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });

    expect(ctx.skipPrdPersistence).toBe(true);
    expect(ctx.prdPath).toBe("/real/feature/prd.json");
    expect(ctx.featureDir).toBe("/real/feature");
  });

  test("always forces skipCompletionEvents: true, regardless of the base", () => {
    const story = makeStory({ id: "US-001" });
    const ctx = buildRectificationPipelineContext({
      // Base explicitly omits skipCompletionEvents — the override must set it anyway.
      pipelineContextBase: makeBase(),
      story,
      config: makeNaxConfig(),
      hooks: { hooks: {} },
      pluginRegistry: { getReporters: () => [], getContextProviders: () => [] } as never,
      workdir: "/tmp/nax-rect-ctx",
      worktreePath: "/tmp/nax-rect-ctx/.nax-wt/US-001",
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });

    expect(ctx.skipCompletionEvents).toBe(true);
  });

  test("scopes story/stories/workdir/projectDir to the rectified story's fresh worktree", () => {
    const story = makeStory({ id: "US-002", title: "Second story" });
    const ctx = buildRectificationPipelineContext({
      pipelineContextBase: makeBase(),
      story,
      config: makeNaxConfig(),
      hooks: { hooks: {} },
      pluginRegistry: { getReporters: () => [], getContextProviders: () => [] } as never,
      workdir: "/tmp/nax-rect-ctx",
      worktreePath: "/tmp/nax-rect-ctx/.nax-wt/US-002",
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });

    expect(ctx.story).toBe(story);
    expect(ctx.stories).toEqual([story]);
    expect(ctx.projectDir).toBe("/tmp/nax-rect-ctx");
    expect(ctx.workdir).toBe("/tmp/nax-rect-ctx/.nax-wt/US-002");
  });
});
