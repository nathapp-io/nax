/**
 * Unit tests for skipPrdPersistence gate in completion stage (CR-1)
 *
 * Covers:
 * - savePRD is NOT called when skipPrdPersistence is true (parallel worktree mode)
 * - Story status is NOT mutated to "passed" when skipPrdPersistence is true
 * - savePRD IS called and story IS marked passed when skipPrdPersistence is unset (serial mode)
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { _completionDeps, completionStage } from "../../../../src/pipeline/stages/completion";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { makeNaxConfig, makePRD, makeStory } from "../../../helpers";
import { makeMockRuntime } from "../../../helpers/runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Save originals for restoration
// ─────────────────────────────────────────────────────────────────────────────

const origSavePRD = _completionDeps.savePRD;
const origGetDiffText = _completionDeps.getDiffText;
const origCheckReviewGate = _completionDeps.checkReviewGate;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<PipelineContext>): PipelineContext {
  const story = makeStory({ id: "US-001", status: "in-progress" });
  const prd = makePRD({ userStories: [story] });
  return {
    config: makeNaxConfig(),
    rootConfig: makeNaxConfig(),
    prd,
    story,
    stories: [story],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: "/tmp/x",
    projectDir: "/tmp/x",
    prdPath: "/tmp/x/prd.json",
    agentResult: { success: true, estimatedCostUsd: 0.01, output: "", stderr: "", exitCode: 0, rateLimited: false },
    hooks: {} as PipelineContext["hooks"],
    storyStartTime: new Date().toISOString(),
    runtime: makeMockRuntime(),
    ...overrides,
  } as unknown as PipelineContext;
}

afterEach(() => {
  _completionDeps.savePRD = origSavePRD;
  _completionDeps.getDiffText = origGetDiffText;
  _completionDeps.checkReviewGate = origCheckReviewGate;
});

// ─────────────────────────────────────────────────────────────────────────────
// skipPrdPersistence tests
// ─────────────────────────────────────────────────────────────────────────────

describe("completionStage skipPrdPersistence", () => {
  test("does NOT call savePRD when skipPrdPersistence is true", async () => {
    const saveSpy = mock(async () => {});
    _completionDeps.savePRD = saveSpy;
    _completionDeps.getDiffText = mock(async () => "");
    const ctx = makeCtx({ skipPrdPersistence: true });

    await completionStage.execute(ctx);

    expect(saveSpy).not.toHaveBeenCalled();
  });

  test("does NOT mutate story status to passed when skipPrdPersistence is true", async () => {
    _completionDeps.savePRD = mock(async () => {});
    _completionDeps.getDiffText = mock(async () => "");
    const ctx = makeCtx({ skipPrdPersistence: true });

    await completionStage.execute(ctx);

    // Shared PRD must not be mutated to "passed" by a parallel worktree pipeline
    expect(ctx.prd.userStories[0].status).not.toBe("passed");
  });

  test("calls savePRD and marks story passed when skipPrdPersistence is unset (serial mode)", async () => {
    const saveSpy = mock(async () => {});
    _completionDeps.savePRD = saveSpy;
    _completionDeps.getDiffText = mock(async () => "");
    const ctx = makeCtx({});

    await completionStage.execute(ctx);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(ctx.prd.userStories[0].status).toBe("passed");
  });

  test("still returns { action: continue } when skipPrdPersistence is true", async () => {
    _completionDeps.savePRD = mock(async () => {});
    _completionDeps.getDiffText = mock(async () => "");
    const ctx = makeCtx({ skipPrdPersistence: true });

    const result = await completionStage.execute(ctx);

    expect(result.action).toBe("continue");
  });
});
