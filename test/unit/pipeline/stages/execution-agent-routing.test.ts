/**
 * Tests for per-agent model routing in execution stage (US-002)
 *
 * AC-2: When ctx.routing.agent is 'codex' and config.models.codex.fast exists,
 *       execution.ts resolves to codex's fast model instead of claude's.
 * AC-3: When ctx.routing.agent is unset, callsites resolve using defaultAgent.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { _executionDeps, executionStage } from "../../../../src/pipeline/stages/execution";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { NaxConfig } from "../../../../src/config";
import type { PRD, UserStory } from "../../../../src/prd";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Test story",
    description: "desc",
    acceptanceCriteria: ["AC-1"],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    attempts: 1,
    escalations: [],
    ...overrides,
  };
}

function makeConfig(modelsOverride?: NaxConfig["models"]): NaxConfig {
  return {
    autoMode: { defaultAgent: "claude" },
    execution: { sessionTimeoutSeconds: 30, verificationTimeoutSeconds: 60 },
    models: modelsOverride ?? { claude: { fast: "claude-haiku", balanced: "claude-sonnet", powerful: "claude-opus" } },
    quality: { requireTests: false, commands: { test: "bun test" } },
    agent: {},
  } as unknown as NaxConfig;
}

function makeCtx(
  storyOverrides: Partial<UserStory> = {},
  routingOverrides: Partial<PipelineContext["routing"]> = {},
  configOverride?: NaxConfig,
): PipelineContext {
  const story = makeStory(storyOverrides);
  return {
    config: configOverride ?? makeConfig(),
    rootConfig: configOverride ?? makeConfig(),
    prd: { project: "p", feature: "f", branchName: "b", createdAt: "", updatedAt: "", userStories: [story] } as PRD,
    story,
    stories: [story],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "",
      ...routingOverrides,
    },
    workdir: "/repo",
    hooks: {},
    prompt: "Do the thing",
  } as unknown as PipelineContext;
}

const originalGetAgent = _executionDeps.getAgent;
const originalValidateAgentForTier = _executionDeps.validateAgentForTier;
const originalDetectMergeConflict = _executionDeps.detectMergeConflict;
const originalResolveStoryWorkdir = _executionDeps.resolveStoryWorkdir;
const originalAutoCommitIfDirty = _executionDeps.autoCommitIfDirty;

afterEach(() => {
  mock.restore();
  _executionDeps.getAgent = originalGetAgent;
  _executionDeps.validateAgentForTier = originalValidateAgentForTier;
  _executionDeps.detectMergeConflict = originalDetectMergeConflict;
  _executionDeps.resolveStoryWorkdir = originalResolveStoryWorkdir;
  if (_executionDeps.autoCommitIfDirty) {
    _executionDeps.autoCommitIfDirty = originalAutoCommitIfDirty;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: unset routing.agent falls back to defaultAgent
// ─────────────────────────────────────────────────────────────────────────────

describe("execution stage — routing.agent unset uses defaultAgent", () => {
  test("passes claude's fast model when routing.agent is unset", async () => {
    let capturedModelDef: { model: string; provider: string } | undefined;

    _executionDeps.getAgent = () =>
      ({
        name: "claude",
        capabilities: { supportedTiers: ["fast"] },
        run: async (opts: { modelDef?: { model: string; provider: string } }) => {
          capturedModelDef = opts.modelDef;
          return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0 };
        },
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    // routing.agent is NOT set — should use defaultAgent "claude"
    const ctx = makeCtx({}, { modelTier: "fast" });
    await executionStage.execute(ctx);

    expect(capturedModelDef?.model).toBe("claude-haiku");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: ctx.routing.agent = 'codex' → resolves codex's model
// ─────────────────────────────────────────────────────────────────────────────

describe("execution stage — routing.agent overrides default agent for model resolution", () => {
  test("uses codex fast model when routing.agent is 'codex'", async () => {
    let capturedModelDef: { model: string; provider: string } | undefined;

    const multiAgentConfig = makeConfig({
      claude: { fast: "claude-haiku", balanced: "claude-sonnet", powerful: "claude-opus" },
      codex: { fast: "codex-mini-latest", balanced: "codex-full", powerful: "codex-full" },
    });

    _executionDeps.getAgent = () =>
      ({
        name: "codex",
        capabilities: { supportedTiers: ["fast"] },
        run: async (opts: { modelDef?: { model: string; provider: string } }) => {
          capturedModelDef = opts.modelDef;
          return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0 };
        },
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    // routing.agent is 'codex' — should resolve codex's fast model
    const ctx = makeCtx(
      {},
      { modelTier: "fast", agent: "codex" },
      multiAgentConfig,
    );
    await executionStage.execute(ctx);

    expect(capturedModelDef?.model).toBe("codex-mini-latest");
  });

  test("falls back to claude when routing.agent is 'codex' but no codex model entry for tier", async () => {
    let capturedModelDef: { model: string; provider: string } | undefined;

    const partialCodexConfig = makeConfig({
      claude: { fast: "claude-haiku", balanced: "claude-sonnet", powerful: "claude-opus" },
      codex: { fast: "codex-mini-latest" },  // no 'powerful' tier
    });

    _executionDeps.getAgent = () =>
      ({
        name: "codex",
        capabilities: { supportedTiers: ["powerful"] },
        run: async (opts: { modelDef?: { model: string; provider: string } }) => {
          capturedModelDef = opts.modelDef;
          return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0 };
        },
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    // routing.agent='codex', tier='powerful', codex has no powerful → falls back to claude.powerful
    const ctx = makeCtx(
      {},
      { modelTier: "powerful", agent: "codex" },
      partialCodexConfig,
    );
    await executionStage.execute(ctx);

    // Should fall back to claude's powerful model
    expect(capturedModelDef?.model).toBe("claude-opus");
  });
});
