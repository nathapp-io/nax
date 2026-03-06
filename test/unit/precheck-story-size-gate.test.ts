// RE-ARCH: keep
/**
 * Tests for src/precheck/story-size-gate.ts
 *
 * Tests story size gate detection logic including heuristic signals
 * (AC count, description length, bullet points).
 */

import { describe, expect, test } from "bun:test";
import type { NaxConfig } from "../../src/config";
import type { PRD, UserStory } from "../../src/prd/types";
import { checkStorySizeGate } from "../../src/precheck/story-size-gate";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const createMockConfig = (
  storySizeGateConfig?: NaxConfig["precheck"],
): NaxConfig =>
  ({
    precheck: storySizeGateConfig,
    version: 1,
    models: {
      fast: "haiku",
      balanced: "sonnet",
      powerful: "opus",
    },
    autoMode: {
      enabled: false,
      defaultAgent: "test",
      fallbackOrder: [],
      complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
      escalation: { enabled: false, tierOrder: [] },
    },
    routing: { strategy: "keyword" },
    execution: {
      maxIterations: 10,
      iterationDelayMs: 1000,
      costLimit: 10,
      sessionTimeoutSeconds: 600,
      verificationTimeoutSeconds: 300,
      maxStoriesPerFeature: 100,
      rectification: {
        enabled: false,
        maxRetries: 0,
        fullSuiteTimeoutSeconds: 120,
        maxFailureSummaryChars: 2000,
        abortOnIncreasingFailures: true,
      },
      regressionGate: { enabled: false, timeoutSeconds: 120 },
      contextProviderTokenBudget: 2000,
    },
    quality: {
      requireTypecheck: false,
      requireLint: false,
      requireTests: false,
      commands: {},
      forceExit: false,
      detectOpenHandles: false,
      detectOpenHandlesRetries: 1,
      gracePeriodMs: 5000,
      drainTimeoutMs: 2000,
      shell: "/bin/sh",
      stripEnvVars: [],
      environmentalEscalationDivisor: 2,
    },
    tdd: {
      maxRetries: 0,
      autoVerifyIsolation: false,
      autoApproveVerifier: false,
      strategy: "off",
    },
    constitution: { enabled: false, path: "", maxTokens: 2000 },
    analyze: { llmEnhanced: false, model: "fast", fallbackToKeywords: true, maxCodebaseSummaryTokens: 5000 },
    review: { enabled: false, checks: [], commands: {} },
    plan: { model: "balanced", outputPath: "" },
    acceptance: { enabled: false, maxRetries: 0, generateTests: false, testPath: "" },
    context: {
      testCoverage: {
        enabled: false,
        detail: "names-only",
        maxTokens: 500,
        testPattern: "**/*.test.ts",
        scopeToStory: false,
      },
      autoDetect: { enabled: false, maxFiles: 5, traceImports: false },
    },
  }) as NaxConfig;

const createMockStory = (overrides: Partial<UserStory> = {}): UserStory => ({
  id: "US-001",
  title: "Test story",
  description: "Test description",
  acceptanceCriteria: ["AC1"],
  tags: [],
  dependencies: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 0,
  ...overrides,
});

const createMockPRD = (stories: UserStory[] = []): PRD => ({
  project: "test-project",
  feature: "test-feature",
  branchName: "test-branch",
  userStories: stories,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("checkStorySizeGate", () => {
  test("passes when gate is disabled", async () => {
    const config = createMockConfig({ storySizeGate: { enabled: false, maxAcCount: 6, maxDescriptionLength: 2000, maxBulletPoints: 8 } });
    const story = createMockStory({ acceptanceCriteria: Array(10).fill("AC") });
    const prd = createMockPRD([story]);

    const result = await checkStorySizeGate(config, prd);

    expect(result.check.passed).toBe(true);
    expect(result.check.tier).toBe("warning");
    expect(result.check.message).toContain("disabled");
    expect(result.flaggedStories).toHaveLength(0);
  });

  test("passes when no stories exceed thresholds", async () => {
    const config = createMockConfig({ storySizeGate: { enabled: true, maxAcCount: 6, maxDescriptionLength: 2000, maxBulletPoints: 8 } });
    const story = createMockStory({
      acceptanceCriteria: ["AC1", "AC2", "AC3"],
      description: "Short description",
    });
    const prd = createMockPRD([story]);

    const result = await checkStorySizeGate(config, prd);

    expect(result.check.passed).toBe(true);
    expect(result.check.tier).toBe("warning");
    expect(result.flaggedStories).toHaveLength(0);
  });

  test("flags story when AC count exceeds threshold", async () => {
    const config = createMockConfig({ storySizeGate: { enabled: true, maxAcCount: 6, maxDescriptionLength: 2000, maxBulletPoints: 8 } });
    const story = createMockStory({
      id: "US-001",
      acceptanceCriteria: Array(8).fill("AC"),
      description: "Short description",
    });
    const prd = createMockPRD([story]);

    const result = await checkStorySizeGate(config, prd);

    expect(result.check.passed).toBe(false);
    expect(result.check.tier).toBe("warning");
    expect(result.check.message).toContain("US-001");
    expect(result.flaggedStories).toHaveLength(1);
    expect(result.flaggedStories[0].storyId).toBe("US-001");
    expect(result.flaggedStories[0].signals.acCount.flagged).toBe(true);
    expect(result.flaggedStories[0].signals.acCount.value).toBe(8);
  });

  test("flags story when description length exceeds threshold", async () => {
    const config = createMockConfig({ storySizeGate: { enabled: true, maxAcCount: 6, maxDescriptionLength: 100, maxBulletPoints: 8 } });
    const longDescription = "a".repeat(150);
    const story = createMockStory({
      id: "US-002",
      acceptanceCriteria: ["AC1"],
      description: longDescription,
    });
    const prd = createMockPRD([story]);

    const result = await checkStorySizeGate(config, prd);

    expect(result.check.passed).toBe(false);
    expect(result.flaggedStories).toHaveLength(1);
    expect(result.flaggedStories[0].signals.descriptionLength.flagged).toBe(true);
    expect(result.flaggedStories[0].signals.descriptionLength.value).toBe(150);
  });

  test("flags story when bullet point count exceeds threshold", async () => {
    const config = createMockConfig({ storySizeGate: { enabled: true, maxAcCount: 6, maxDescriptionLength: 2000, maxBulletPoints: 5 } });
    const description = `
Requirements:
- Item 1
- Item 2
- Item 3
- Item 4
- Item 5
- Item 6
- Item 7
`;
    const story = createMockStory({
      id: "US-003",
      acceptanceCriteria: ["AC1"],
      description,
    });
    const prd = createMockPRD([story]);

    const result = await checkStorySizeGate(config, prd);

    expect(result.check.passed).toBe(false);
    expect(result.flaggedStories).toHaveLength(1);
    expect(result.flaggedStories[0].signals.bulletPoints.flagged).toBe(true);
    expect(result.flaggedStories[0].signals.bulletPoints.value).toBeGreaterThan(5);
  });

  test("flags multiple stories when multiple exceed thresholds", async () => {
    const config = createMockConfig({ storySizeGate: { enabled: true, maxAcCount: 3, maxDescriptionLength: 50, maxBulletPoints: 5 } });
    const story1 = createMockStory({
      id: "US-001",
      acceptanceCriteria: Array(5).fill("AC"),
    });
    const story2 = createMockStory({
      id: "US-002",
      description: "a".repeat(100),
    });
    const prd = createMockPRD([story1, story2]);

    const result = await checkStorySizeGate(config, prd);

    expect(result.check.passed).toBe(false);
    expect(result.flaggedStories).toHaveLength(2);
    expect(result.flaggedStories[0].storyId).toBe("US-001");
    expect(result.flaggedStories[1].storyId).toBe("US-002");
  });

  test("only checks pending stories, ignores completed/failed/skipped", async () => {
    const config = createMockConfig({ storySizeGate: { enabled: true, maxAcCount: 3, maxDescriptionLength: 2000, maxBulletPoints: 8 } });
    const pendingStory = createMockStory({
      id: "US-001",
      status: "pending",
      acceptanceCriteria: Array(5).fill("AC"),
    });
    const passedStory = createMockStory({
      id: "US-002",
      status: "passed",
      acceptanceCriteria: Array(5).fill("AC"),
    });
    const failedStory = createMockStory({
      id: "US-003",
      status: "failed",
      acceptanceCriteria: Array(5).fill("AC"),
    });
    const prd = createMockPRD([pendingStory, passedStory, failedStory]);

    const result = await checkStorySizeGate(config, prd);

    expect(result.check.passed).toBe(false);
    expect(result.flaggedStories).toHaveLength(1);
    expect(result.flaggedStories[0].storyId).toBe("US-001");
  });

  test("uses default thresholds when config is not provided", async () => {
    const config = createMockConfig(undefined);
    const story = createMockStory({
      id: "US-001",
      acceptanceCriteria: Array(10).fill("AC"),
    });
    const prd = createMockPRD([story]);

    const result = await checkStorySizeGate(config, prd);

    // Default threshold is 6, so 10 AC should be flagged
    expect(result.check.passed).toBe(false);
    expect(result.flaggedStories).toHaveLength(1);
  });

  test("includes recommendation message in flagged story", async () => {
    const config = createMockConfig({ storySizeGate: { enabled: true, maxAcCount: 3, maxDescriptionLength: 2000, maxBulletPoints: 8 } });
    const story = createMockStory({
      id: "US-001",
      acceptanceCriteria: Array(5).fill("AC"),
    });
    const prd = createMockPRD([story]);

    const result = await checkStorySizeGate(config, prd);

    expect(result.flaggedStories[0].recommendation).toContain("US-001");
    expect(result.flaggedStories[0].recommendation).toContain("too large");
    expect(result.flaggedStories[0].recommendation).toContain("5 AC");
    expect(result.flaggedStories[0].recommendation).toContain("max 3");
  });
});
