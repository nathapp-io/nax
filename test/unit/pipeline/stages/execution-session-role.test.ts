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

function makeConfig(overrides: Partial<NaxConfig> = {}): NaxConfig {
  return {
    agent: { default: "claude" },
    execution: { sessionTimeoutSeconds: 30, verificationTimeoutSeconds: 60 },
    models: { claude: { fast: "claude-haiku", balanced: "claude-sonnet", powerful: "claude-opus" } },
    quality: { requireTests: false, commands: { test: "bun test" } },
    review: { enabled: false },
    ...overrides,
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
      ({
        name: "claude",
        capabilities: { supportedTiers: ["fast"] },
        run: async (opts: { sessionRole?: string }) => {
          capturedSessionRole = opts.sessionRole;
          return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0 };
        },
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    const ctx = makeCtx({}, { testStrategy: "test-after" });
    await executionStage.execute(ctx);

    expect(capturedSessionRole).toBe("implementer");
  });

  test("passes sessionRole: 'implementer' for no-test strategy", async () => {
    let capturedSessionRole: string | undefined;

    _executionDeps.getAgent = () =>
      ({
        name: "claude",
        capabilities: { supportedTiers: ["fast"] },
        run: async (opts: { sessionRole?: string }) => {
          capturedSessionRole = opts.sessionRole;
          return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0 };
        },
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    const ctx = makeCtx({}, { testStrategy: "no-test" });
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
      ({
        name: "claude",
        capabilities: { supportedTiers: ["fast"] },
        run: async (opts: { keepOpen?: boolean }) => {
          capturedKeepSessionOpen = opts.keepOpen;
          return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0 };
        },
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    const configWithReview = makeConfig({ review: { enabled: true } });
    const ctx = makeCtx({}, { testStrategy: "test-after" }, configWithReview);
    await executionStage.execute(ctx);

    expect(capturedKeepSessionOpen).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: keepOpen: true when rectification.enabled is true
// ─────────────────────────────────────────────────────────────────────────────

describe("execution stage — keepOpen when rectification enabled (AC-3)", () => {
  test("passes keepOpen: true when rectification.enabled is true", async () => {
    let capturedKeepSessionOpen: boolean | undefined;

    _executionDeps.getAgent = () =>
      ({
        name: "claude",
        capabilities: { supportedTiers: ["fast"] },
        run: async (opts: { keepOpen?: boolean }) => {
          capturedKeepSessionOpen = opts.keepOpen;
          return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0 };
        },
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    const configWithRectification = makeConfig({
      execution: { sessionTimeoutSeconds: 30, verificationTimeoutSeconds: 60, rectification: { enabled: true } },
    });
    const ctx = makeCtx({}, { testStrategy: "test-after" }, configWithRectification);
    await executionStage.execute(ctx);

    expect(capturedKeepSessionOpen).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: keepOpen: false when both review and rectification are falsy
// ─────────────────────────────────────────────────────────────────────────────

describe("execution stage — keepOpen when review and rectification disabled (AC-4)", () => {
  test("passes keepOpen: false when both review and rectification are disabled", async () => {
    let capturedKeepSessionOpen: boolean | undefined;

    _executionDeps.getAgent = () =>
      ({
        name: "claude",
        capabilities: { supportedTiers: ["fast"] },
        run: async (opts: { keepOpen?: boolean }) => {
          capturedKeepSessionOpen = opts.keepOpen;
          return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0 };
        },
      }) as unknown as ReturnType<typeof _executionDeps.getAgent>;

    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.detectMergeConflict = () => false;

    const configWithoutReviewOrRectification = makeConfig({
      review: { enabled: false },
      execution: { sessionTimeoutSeconds: 30, verificationTimeoutSeconds: 60, rectification: { enabled: false } },
    });
    const ctx = makeCtx({}, { testStrategy: "test-after" }, configWithoutReviewOrRectification);
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
