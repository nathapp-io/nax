/**
 * Unit tests for merge-conflict trigger wiring in execution stage (TC-003)
 *
 * Covers:
 * - Agent output with CONFLICT + trigger enabled + chain aborts → fail
 * - Agent output with CONFLICT + trigger enabled + chain approves → continue
 * - Agent output with CONFLICT + trigger disabled → no trigger call
 * - Agent output without CONFLICT + trigger enabled → no trigger call
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { NaxConfig } from "../../../../src/config";
import { InteractionChain } from "../../../../src/interaction/chain";
import type { InteractionPlugin, InteractionResponse } from "../../../../src/interaction/types";
import { _executionDeps } from "../../../../src/pipeline/stages/execution";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../../src/prd";

// ─────────────────────────────────────────────────────────────────────────────
// Save originals for restoration
// ─────────────────────────────────────────────────────────────────────────────

const originalDetectMergeConflict = _executionDeps.detectMergeConflict;
const originalCheckMergeConflict = _executionDeps.checkMergeConflict;

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

function makeConfig(triggers: Record<string, unknown>): NaxConfig {
  return {
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
  } as unknown as NaxConfig;
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

function makeSuccessfulAgent() {
  return {
    name: "test-agent",
    capabilities: { supportedTiers: ["fast", "balanced", "powerful"] },
    run: mock(async () => ({
      success: true,
      exitCode: 0,
      output: "CONFLICT (content): Merge conflict in src/foo.ts",
      stderr: "",
      rateLimited: false,
      durationMs: 100,
      estimatedCost: 0.01,
    })),
  };
}

function makeCtx(config: NaxConfig, interaction?: InteractionChain): PipelineContext {
  return {
    config,
    prd: makePRD(),
    story: makeStory(),
    stories: [makeStory()],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp/test",
    projectDir: "/tmp/test",
    prompt: "Do something",
    hooks: {} as PipelineContext["hooks"],
    interaction,
  } as unknown as PipelineContext;
}

afterEach(() => {
  mock.restore();
  _executionDeps.detectMergeConflict = originalDetectMergeConflict;
  _executionDeps.checkMergeConflict = originalCheckMergeConflict;
  _executionDeps.getAgent = _executionDeps.getAgent; // restored via mock.restore()
});

// ─────────────────────────────────────────────────────────────────────────────
// Merge conflict trigger tests (via _executionDeps injection)
// ─────────────────────────────────────────────────────────────────────────────

describe("executionStage — merge-conflict trigger", () => {
  test("returns fail when conflict detected and trigger responds abort", async () => {
    const { executionStage } = await import("../../../../src/pipeline/stages/execution");
    const agent = makeSuccessfulAgent();
    _executionDeps.getAgent = mock(() => agent as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.detectMergeConflict = mock(() => true);
    _executionDeps.checkMergeConflict = mock(async () => false);

    const config = makeConfig({ "merge-conflict": { enabled: true } });
    const chain = makeChain("abort");
    const ctx = makeCtx(config, chain);

    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("fail");
    expect((result as { reason?: string }).reason).toContain("Merge conflict");
    expect(_executionDeps.detectMergeConflict).toHaveBeenCalled();
    expect(_executionDeps.checkMergeConflict).toHaveBeenCalledTimes(1);
  });

  test("returns continue when conflict detected but trigger approves", async () => {
    const { executionStage } = await import("../../../../src/pipeline/stages/execution");
    const agent = makeSuccessfulAgent();
    _executionDeps.getAgent = mock(() => agent as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.detectMergeConflict = mock(() => true);
    _executionDeps.checkMergeConflict = mock(async () => true);

    const config = makeConfig({ "merge-conflict": { enabled: true } });
    const chain = makeChain("approve");
    const ctx = makeCtx(config, chain);

    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(_executionDeps.checkMergeConflict).toHaveBeenCalledTimes(1);
  });

  test("does not call trigger when trigger is disabled", async () => {
    const { executionStage } = await import("../../../../src/pipeline/stages/execution");
    const agent = makeSuccessfulAgent();
    _executionDeps.getAgent = mock(() => agent as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.detectMergeConflict = mock(() => true);
    _executionDeps.checkMergeConflict = mock(async () => false);

    const config = makeConfig({});
    const chain = makeChain("abort");
    const ctx = makeCtx(config, chain);

    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(_executionDeps.checkMergeConflict).not.toHaveBeenCalled();
  });

  test("does not call trigger when no conflict detected", async () => {
    const { executionStage } = await import("../../../../src/pipeline/stages/execution");
    const agent = makeSuccessfulAgent();
    _executionDeps.getAgent = mock(() => agent as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.detectMergeConflict = mock(() => false);
    _executionDeps.checkMergeConflict = mock(async () => false);

    const config = makeConfig({ "merge-conflict": { enabled: true } });
    const chain = makeChain("abort");
    const ctx = makeCtx(config, chain);

    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(_executionDeps.checkMergeConflict).not.toHaveBeenCalled();
  });

  test("does not call trigger when no interaction chain", async () => {
    const { executionStage } = await import("../../../../src/pipeline/stages/execution");
    const agent = makeSuccessfulAgent();
    _executionDeps.getAgent = mock(() => agent as ReturnType<typeof _executionDeps.getAgent>);
    _executionDeps.detectMergeConflict = mock(() => true);
    _executionDeps.checkMergeConflict = mock(async () => false);

    const config = makeConfig({ "merge-conflict": { enabled: true } });
    const ctx = makeCtx(config); // no chain

    const result = await executionStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(_executionDeps.checkMergeConflict).not.toHaveBeenCalled();
  });
});
