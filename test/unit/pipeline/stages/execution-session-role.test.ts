/**
 * Tests for session role normalization in execution stage (US-001)
 *
 * AC-1: agent.run() in execution.ts passes `sessionRole: "implementer"` for all test strategies
 * AC-2: When ctx.config.review.enabled is true, execution.ts passes `keepOpen: true`
 * AC-3: When ctx.config.execution.rectification?.enabled is true, execution.ts passes `keepOpen: true`
 * AC-4: When both review and rectification are falsy, execution.ts passes `keepOpen: false`
 * AC-5: computeAcpHandle produces consistent names for identical inputs
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { _executionDeps, executionStage } from "../../../../src/pipeline/stages/execution";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { NaxConfig } from "../../../../src/config";
import type { PRD, UserStory } from "../../../../src/prd";
import { makeAgentAdapter, makeMockAgentManager, makeNaxConfig, makeStory } from "../../../../test/helpers";
import { fakeAgentManager } from "../../../../test/helpers/fake-agent-manager";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeCtx(
  storyOverrides: Partial<UserStory> = {},
  routingOverrides: Partial<PipelineContext["routing"]> = {},
  configOverride?: NaxConfig,
): PipelineContext {
  const story = makeStory(storyOverrides);
  const config = configOverride ?? makeNaxConfig({
    agent: { default: "claude" },
    models: { claude: { fast: "claude-haiku", balanced: "claude-sonnet", powerful: "claude-opus" } },
    quality: { requireTests: false, commands: { test: "bun test" } },
    review: { enabled: false },
  });
  return {
    config,
    rootConfig: config,
    prd: { project: "p", feature: "test-feature", branchName: "b", createdAt: "", updatedAt: "", userStories: [story] } as PRD,
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
    agentManager: (() => { const a = _executionDeps.getAgent?.("claude"); return a ? fakeAgentManager(a, "claude") : fakeAgentManager(makeAgentAdapter({ name: "claude" })); })(),
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
// AC-1: sessionRole: "implementer" is passed to agent.run()
// ─────────────────────────────────────────────────────────────────────────────

describe("execution stage — session role normalization (AC-1)", () => {
  test("passes sessionRole: 'implementer' for test-after strategy", async () => {
    let capturedSessionRole: string | undefined;

    _executionDeps.getAgent = () =>
      makeAgentAdapter({
        name: "claude",
        capabilities: { supportedTiers: ["fast"], maxContextTokens: 100_000, features: new Set<"tdd" | "review" | "refactor" | "batch">() },
      });
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    const ctx = makeCtx({}, { testStrategy: "test-after" });
    (ctx as unknown as Record<string, unknown>).agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        capturedSessionRole = req.runOptions.sessionRole;
        return { result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] };
      },
    });
    await executionStage.execute(ctx);

    expect(capturedSessionRole).toBe("implementer");
  });

  test("passes sessionRole: 'implementer' for no-test strategy", async () => {
    let capturedSessionRole: string | undefined;

    _executionDeps.getAgent = () =>
      makeAgentAdapter({
        name: "claude",
        capabilities: { supportedTiers: ["fast"], maxContextTokens: 100_000, features: new Set<"tdd" | "review" | "refactor" | "batch">() },
      });
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    const ctx = makeCtx({}, { testStrategy: "no-test" });
    (ctx as unknown as Record<string, unknown>).agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        capturedSessionRole = req.runOptions.sessionRole;
        return { result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] };
      },
    });
    await executionStage.execute(ctx);

    expect(capturedSessionRole).toBe("implementer");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: keepOpen: true when review.enabled is true
// ─────────────────────────────────────────────────────────────────────────────

describe("execution stage — keepOpen when review enabled (AC-2)", () => {
  test("passes keepOpen: true when review.enabled is true", async () => {
    let capturedKeepSessionOpen: boolean | undefined;

    _executionDeps.getAgent = () =>
      makeAgentAdapter({
        name: "claude",
        capabilities: { supportedTiers: ["fast"], maxContextTokens: 100_000, features: new Set<"tdd" | "review" | "refactor" | "batch">() },
      });
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    const configWithReview = makeNaxConfig({ review: { enabled: true } });
    const ctx = makeCtx({}, { testStrategy: "test-after" }, configWithReview);
    (ctx as unknown as Record<string, unknown>).agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        capturedKeepSessionOpen = req.runOptions.keepOpen;
        return { result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] };
      },
    });
    await executionStage.execute(ctx);

    expect(capturedKeepSessionOpen).toBe(true);
  });
});

describe("execution stage — keepOpen when rectification enabled (AC-3)", () => {
  test("passes keepOpen: true when rectification.enabled is true", async () => {
    let capturedKeepSessionOpen: boolean | undefined;

    _executionDeps.getAgent = () =>
      makeAgentAdapter({
        name: "claude",
        capabilities: { supportedTiers: ["fast"], maxContextTokens: 100_000, features: new Set<"tdd" | "review" | "refactor" | "batch">() },
      });
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    const configWithRectification = makeNaxConfig({
      execution: { sessionTimeoutSeconds: 30, verificationTimeoutSeconds: 60, rectification: { enabled: true } },
    });
    const ctx = makeCtx({}, { testStrategy: "test-after" }, configWithRectification);
    (ctx as unknown as Record<string, unknown>).agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        capturedKeepSessionOpen = req.runOptions.keepOpen;
        return { result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] };
      },
    });
    await executionStage.execute(ctx);

    expect(capturedKeepSessionOpen).toBe(true);
  });
});

describe("execution stage — keepOpen when review and rectification disabled (AC-4)", () => {
  test("passes keepOpen: false when both review and rectification are disabled", async () => {
    let capturedKeepSessionOpen: boolean | undefined;

    _executionDeps.getAgent = () =>
      makeAgentAdapter({
        name: "claude",
        capabilities: { supportedTiers: ["fast"], maxContextTokens: 100_000, features: new Set<"tdd" | "review" | "refactor" | "batch">() },
      });
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    const configWithoutReviewOrRectification = makeNaxConfig({
      review: { enabled: false },
      execution: { sessionTimeoutSeconds: 30, verificationTimeoutSeconds: 60, rectification: { enabled: false } },
    });
    const ctx = makeCtx({}, { testStrategy: "test-after" }, configWithoutReviewOrRectification);
    (ctx as unknown as Record<string, unknown>).agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        capturedKeepSessionOpen = req.runOptions.keepOpen;
        return { result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] };
      },
    });
    await executionStage.execute(ctx);

    expect(capturedKeepSessionOpen).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: computeAcpHandle consistency test
// ─────────────────────────────────────────────────────────────────────────────

describe("execution stage — computeAcpHandle consistency (AC-5)", () => {
  test("computeAcpHandle produces same result for identical inputs", async () => {
    // Import computeAcpHandle from ACP adapter
    const { computeAcpHandle } = await import("../../../../src/agents/acp/adapter");

    const workdir = "/repo";
    const feature = "test-feature";
    const storyId = "US-001";
    const role = "implementer";

    // Call computeAcpHandle twice with same inputs
    const name1 = computeAcpHandle(workdir, feature, storyId, role);
    const name2 = computeAcpHandle(workdir, feature, storyId, role);

    // Should be identical
    expect(name1).toBe(name2);

    // Should contain the expected parts
    expect(name1).toContain("nax-");
    expect(name1).toContain("implementer");
  });
});
