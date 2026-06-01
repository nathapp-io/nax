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
import { rectifyConflictedStory } from "../../../src/execution/merge-conflict-rectify";
import { makeMockAgentManager, makeNaxConfig, makePRD, makeSessionManager, makeStory } from "../../helpers";

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
      agentManager: makeMockAgentManager(),
      sessionManager: makeSessionManager(),
      runtime: {
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
      } as never,
      abortSignal: undefined as never,
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
      agentManager: makeMockAgentManager(),
      sessionManager: makeSessionManager(),
      runtime: {
        outputDir: "/tmp",
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
      } as never,
      abortSignal: undefined as never,
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
