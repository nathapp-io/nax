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
import { makeAgentAdapter, makeNaxConfig, makeStory } from "../../../../test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeCtx(
  storyOverrides: Partial<UserStory> = {},
  routingOverrides: Partial<PipelineContext["routing"]> = {},
  configOverride?: NaxConfig,
): PipelineContext {
  const story = makeStory(storyOverrides);
  const defaultModelsConfig = makeNaxConfig({
    agent: { default: "claude" },
    models: {
      claude: { fast: "claude-haiku", balanced: "claude-sonnet", powerful: "claude-opus" },
    },
  });
  return {
    config: configOverride ?? defaultModelsConfig,
    rootConfig: configOverride ?? defaultModelsConfig,
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

afterEach(() => {
  mock.restore();
  _executionDeps.getAgent = originalGetAgent;
  _executionDeps.validateAgentForTier = originalValidateAgentForTier;
  _executionDeps.detectMergeConflict = originalDetectMergeConflict;
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: unset routing.agent falls back to defaultAgent
// ─────────────────────────────────────────────────────────────────────────────

describe("execution stage — routing.agent unset uses defaultAgent", () => {
  test("passes claude's fast model when routing.agent is unset", async () => {
    let capturedModelDef: { model: string; provider: string } | undefined;

    _executionDeps.getAgent = () =>
      makeAgentAdapter({
        name: "claude",
        capabilities: { supportedTiers: ["fast"], maxContextTokens: 100_000, features: new Set<"tdd" | "review" | "refactor" | "batch">() },
        openSession: mock(async (_name: string, opts: { modelDef?: { model: string; provider: string } }) => {
          capturedModelDef = opts.modelDef;
          return { id: "session", agentName: "claude" };
        }),
        sendTurn: mock(async () => ({ output: "", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 1 })),
        closeSession: mock(async () => {}),
      });

    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

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

    const multiAgentConfig = makeNaxConfig({
      models: {
        claude: { fast: "claude-haiku", balanced: "claude-sonnet", powerful: "claude-opus" },
        codex: { fast: "codex-mini-latest", balanced: "codex-full", powerful: "codex-full" },
      },
    });

    _executionDeps.getAgent = () =>
      makeAgentAdapter({
        name: "codex",
        capabilities: { supportedTiers: ["fast"], maxContextTokens: 100_000, features: new Set<"tdd" | "review" | "refactor" | "batch">() },
        openSession: mock(async (_name: string, opts: { modelDef?: { model: string; provider: string } }) => {
          capturedModelDef = opts.modelDef;
          return { id: "session", agentName: "codex" };
        }),
        sendTurn: mock(async () => ({ output: "", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 1 })),
        closeSession: mock(async () => {}),
      });

    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

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

    const partialCodexConfig = makeNaxConfig({
      models: {
        claude: { fast: "claude-haiku", balanced: "claude-sonnet", powerful: "claude-opus" },
        codex: { fast: "codex-mini-latest" },
      },
    });

    _executionDeps.getAgent = () =>
      makeAgentAdapter({
        name: "codex",
        capabilities: { supportedTiers: ["powerful"], maxContextTokens: 100_000, features: new Set<"tdd" | "review" | "refactor" | "batch">() },
        openSession: mock(async (_name: string, opts: { modelDef?: { model: string; provider: string } }) => {
          capturedModelDef = opts.modelDef;
          return { id: "session", agentName: "codex" };
        }),
        sendTurn: mock(async () => ({ output: "", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 1 })),
        closeSession: mock(async () => {}),
      });

    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    const ctx = makeCtx(
      {},
      { modelTier: "powerful", agent: "codex" },
      partialCodexConfig,
    );
    await executionStage.execute(ctx);

    expect(capturedModelDef?.model).toBe("claude-opus");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue 6 — tier mismatch: clamp to first supported tier (issue #369)
// ─────────────────────────────────────────────────────────────────────────────

describe("execution stage — tier mismatch clamps to first supported tier", () => {
  test("passes first supported tier to agent.run() when requested tier is unsupported", async () => {
    let capturedModelDef: { model: string; provider: string } | undefined;

    _executionDeps.getAgent = () =>
      makeAgentAdapter({
        name: "opencode",
        capabilities: { supportedTiers: ["balanced"], maxContextTokens: 100_000, features: new Set<"tdd" | "review" | "refactor" | "batch">() },
        openSession: mock(async (_name: string, opts: { modelDef?: { model: string; provider: string } }) => {
          capturedModelDef = opts.modelDef;
          return { id: "session", agentName: "opencode" };
        }),
        sendTurn: mock(async () => ({ output: "", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 1 })),
        closeSession: mock(async () => {}),
      });

    _executionDeps.validateAgentForTier = () => false;
    _executionDeps.detectMergeConflict = () => false;

    const ctx = makeCtx({}, { modelTier: "fast" });
    await executionStage.execute(ctx);

    // Tier clamped to "balanced" → modelDef resolves to the balanced model for claude (default fallback)
    expect(capturedModelDef?.model).toBe("claude-sonnet");
  });

  test("no clamping occurs when tier is supported", async () => {
    let capturedModelDef: { model: string; provider: string } | undefined;

    _executionDeps.getAgent = () =>
      makeAgentAdapter({
        name: "claude",
        capabilities: { supportedTiers: ["fast", "balanced", "powerful"], maxContextTokens: 100_000, features: new Set<"tdd" | "review" | "refactor" | "batch">() },
        openSession: mock(async (_name: string, opts: { modelDef?: { model: string; provider: string } }) => {
          capturedModelDef = opts.modelDef;
          return { id: "session", agentName: "claude" };
        }),
        sendTurn: mock(async () => ({ output: "", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 1 })),
        closeSession: mock(async () => {}),
      });

    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    const ctx = makeCtx({}, { modelTier: "fast" });
    await executionStage.execute(ctx);

    // No clamping — tier stays "fast" → modelDef resolves to the fast model for claude
    expect(capturedModelDef?.model).toBe("claude-haiku");
  });
});
