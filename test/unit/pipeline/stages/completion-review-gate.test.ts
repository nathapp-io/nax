/**
 * Unit tests for review-gate trigger wiring in completion stage (TC-004)
 *
 * Covers:
 * - review-gate trigger fires after each story passes when enabled
 * - review-gate is disabled by default
 * - trigger responds abort → logs warning (non-blocking)
 * - trigger responds approve → continues normally
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { InteractionChain } from "../../../../src/interaction/chain";
import type { InteractionPlugin, InteractionResponse } from "../../../../src/interaction/types";
import { _completionDeps } from "../../../../src/pipeline/stages/completion";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../../src/prd";
import { withTempDir } from "../../../helpers/temp";
import { makeNaxConfig } from "../../../helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Save originals for restoration
// ─────────────────────────────────────────────────────────────────────────────

const originalCheckReviewGate = _completionDeps.checkReviewGate;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeChain(action: InteractionResponse["action"]): InteractionChain {
  const chain = new InteractionChain({ defaultTimeout: 5000, defaultFallback: "abort" });
  const plugin: InteractionPlugin = {
    name: "test",
    send: mock(async () => {}),
    receive: mock(async (id: string): Promise<InteractionResponse> => ({
      requestId: id,
      action,
      respondedBy: "user",
      respondedAt: Date.now(),
    })),
  };
  chain.register(plugin);
  return chain;
}

function makeConfig(triggers: Record<string, unknown>) {
  return makeNaxConfig({
    agent: { default: "test-agent" },
    models: { "test-agent": { fast: "claude-haiku-4-5", balanced: "claude-sonnet-4-5", powerful: "claude-opus-4-5" } },
    execution: {
      sessionTimeoutSeconds: 60,
      dangerouslySkipPermissions: false,
      costLimit: 10,
      maxIterations: 10,
      rectification: { maxRetries: 3 },
    },
    interaction: {
      plugin: "cli",
      defaults: { timeout: 30000, fallback: "abort" as const },
      triggers,
    },
  });
}

function makeStory(): UserStory {
  return {
    id: "US-001",
    title: "Test Story",
    description: "Test",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    escalations: [],
    attempts: 1,
  };
}

function makePRD(): PRD {
  return {
    project: "test",
    feature: "my-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [makeStory()],
  };
}

function makeCtx(config: ReturnType<typeof makeNaxConfig>, tempDir: string, interaction?: InteractionChain): PipelineContext {
  return {
    config,
    prd: makePRD(),
    story: makeStory(),
    stories: [makeStory()],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: makeNaxConfig(),
    workdir: tempDir,
    projectDir: tempDir,
    featureDir: tempDir,
    agentResult: { success: true, estimatedCostUsd: 0.01, output: "", stderr: "", exitCode: 0, rateLimited: false },
    hooks: {} as PipelineContext["hooks"],
    interaction,
    storyStartTime: new Date().toISOString(),
  } as unknown as PipelineContext;
}

afterEach(() => {
  mock.restore();
  _completionDeps.checkReviewGate = originalCheckReviewGate;
});

// ─────────────────────────────────────────────────────────────────────────────
// review-gate trigger tests (via _completionDeps injection)
// ─────────────────────────────────────────────────────────────────────────────

describe("completionStage — review-gate trigger", () => {
  test("calls review-gate trigger after story passes when enabled", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");
      _completionDeps.checkReviewGate = mock(async () => true);

      const config = makeConfig({ "review-gate": { enabled: true } });
      const chain = makeChain("approve");
      const ctx = makeCtx(config, tempDir, chain);

      const result = await completionStage.execute(ctx);

      expect(result.action).toBe("continue");
      expect(_completionDeps.checkReviewGate).toHaveBeenCalledTimes(1);
    });
  });

  test("does not call trigger when review-gate is disabled (default)", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");
      _completionDeps.checkReviewGate = mock(async () => true);

      const config = makeConfig({});
      const chain = makeChain("approve");
      const ctx = makeCtx(config, tempDir, chain);

      const result = await completionStage.execute(ctx);

      expect(result.action).toBe("continue");
      expect(_completionDeps.checkReviewGate).not.toHaveBeenCalled();
    });
  });

  test("does not fail pipeline when trigger responds abort", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");
      _completionDeps.checkReviewGate = mock(async () => false);

      const config = makeConfig({ "review-gate": { enabled: true } });
      const chain = makeChain("abort");
      const ctx = makeCtx(config, tempDir, chain);

      const result = await completionStage.execute(ctx);

      expect(result.action).toBe("continue");
      expect(_completionDeps.checkReviewGate).toHaveBeenCalledTimes(1);
    });
  });

  test("continues normally when trigger approves", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");
      _completionDeps.checkReviewGate = mock(async () => true);

      const config = makeConfig({ "review-gate": { enabled: true } });
      const chain = makeChain("approve");
      const ctx = makeCtx(config, tempDir, chain);

      const result = await completionStage.execute(ctx);

      expect(result.action).toBe("continue");
    });
  });

  test("does not call trigger when no interaction chain", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");
      _completionDeps.checkReviewGate = mock(async () => true);

      const config = makeConfig({ "review-gate": { enabled: true } });
      const ctx = makeCtx(config, tempDir);

      const result = await completionStage.execute(ctx);

      expect(result.action).toBe("continue");
      expect(_completionDeps.checkReviewGate).not.toHaveBeenCalled();
    });
  });

  test("passes correct context to checkReviewGate", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");
      _completionDeps.checkReviewGate = mock(async () => true);

      const config = makeConfig({ "review-gate": { enabled: true } });
      const chain = makeChain("approve");
      const ctx = makeCtx(config, tempDir, chain);

      await completionStage.execute(ctx);

      const callArgs = (_completionDeps.checkReviewGate as any).mock.calls[0];
      expect(callArgs[0].featureName).toBe("my-feature");
      expect(callArgs[0].storyId).toBe("US-001");
    });
  });

  test("calls trigger for each story when multiple stories passed", async () => {
    await withTempDir(async (tempDir) => {
      const { completionStage } = await import("../../../../src/pipeline/stages/completion");
      _completionDeps.checkReviewGate = mock(async () => true);

      const config = makeConfig({ "review-gate": { enabled: true } });
      const chain = makeChain("approve");
      const ctx = makeCtx(config, tempDir, chain);

      const story2 = makeStory();
      story2.id = "US-002";
      ctx.stories = [makeStory(), story2];

      await completionStage.execute(ctx);

      expect(_completionDeps.checkReviewGate).toHaveBeenCalledTimes(2);
    });
  });
});
