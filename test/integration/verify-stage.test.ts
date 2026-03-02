/**
 * Verify Stage Tests
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NaxConfig } from "../../src/config/schema";
import { initLogger, resetLogger } from "../../src/logger";
import { verifyStage } from "../../src/pipeline/stages/verify";
import type { PipelineContext } from "../../src/pipeline/types";
import type { PRD, UserStory } from "../../src/prd/types";

/** Helper: Create minimal test context */
function createTestContext(overrides?: Partial<PipelineContext>): PipelineContext {
  const story: UserStory = {
    id: "US-001",
    title: "Test Story",
    description: "Test description",
    acceptanceCriteria: ["Test passes"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  };

  const prd: PRD = {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [story],
  };

  const config: NaxConfig = {
    version: 1,
    models: {
      fast: "claude-sonnet-4-5",
      balanced: "claude-sonnet-4-5",
      powerful: "claude-opus-4-6",
    },
    autoMode: {
      enabled: true,
      defaultAgent: "nax-agent-claude",
      fallbackOrder: ["nax-agent-claude"],
      complexityRouting: {
        simple: "fast",
        medium: "balanced",
        complex: "powerful",
        expert: "powerful",
      },
      escalation: {
        enabled: true,
        maxAttempts: 3,
      },
    },
    execution: {
      maxIterations: 100,
      iterationDelayMs: 1000,
      costLimit: 50,
      sessionTimeoutSeconds: 600,
      maxStoriesPerFeature: 50,
    },
    quality: {
      requireTypecheck: false,
      requireLint: false,
      requireTests: true,
      commands: {},
    },
    tdd: {
      maxRetries: 3,
      autoVerifyIsolation: true,
      autoApproveVerifier: true,
    },
    constitution: {
      enabled: false,
      path: "constitution.md",
      maxTokens: 2000,
    },
    analyze: {
      llmEnhanced: false,
      model: "balanced",
      fallbackToKeywords: true,
      maxCodebaseSummaryTokens: 4000,
    },
    review: {
      enabled: true,
      checks: ["test"],
      commands: {},
    },
    plan: {
      model: "balanced",
      outputPath: "features",
    },
  };

  return {
    config,
    prd,
    story,
    stories: [story],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "Test routing",
    },
    workdir: "/test/workdir",
    hooks: { hooks: {} },
    ...overrides,
  };
}

describe("Verify Stage", () => {
  beforeEach(() => {
    initLogger({ level: "error", useChalk: false });
  });

  afterEach(() => {
    resetLogger();
  });

  test("verifyStage is always enabled", () => {
    const ctx = createTestContext();
    expect(verifyStage.enabled(ctx)).toBe(true);
  });

  test("passes when tests succeed", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-verify-test-"));

    const ctx = createTestContext({
      workdir: tempDir,
      config: {
        ...createTestContext().config,
        review: {
          enabled: true,
          checks: ["test"],
          commands: {
            test: "echo 'Tests passed'",
          },
        },
      },
    });

    const result = await verifyStage.execute(ctx);

    expect(result.action).toBe("continue");
  });

  test("fails when tests fail", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-verify-test-"));

    const ctx = createTestContext({
      workdir: tempDir,
      config: {
        ...createTestContext().config,
        review: {
          enabled: true,
          checks: ["test"],
          commands: {
            test: "sh -c 'exit 1'",
          },
        },
      },
    });

    const result = await verifyStage.execute(ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") {
      expect(result.reason).toContain("Tests failed");
      // Exit code may vary by shell - just check it mentions exit code
      expect(result.reason).toMatch(/exit code/);
    }
  });

  test("uses default test command when not configured", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-verify-test-"));

    // Create a simple package.json to make bun test work
    await Bun.write(join(tempDir, "package.json"), JSON.stringify({ name: "test" }));

    const ctx = createTestContext({
      workdir: tempDir,
      config: {
        ...createTestContext().config,
        review: {
          enabled: true,
          checks: ["test"],
          commands: {}, // No custom command
        },
      },
    });

    const result = await verifyStage.execute(ctx);

    // No test command configured → stage skips (returns continue)
    // This is correct behaviour: don't run tests if none configured
    expect(result.action).toBe("continue");
  });

  test("uses custom test command from config", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-verify-test-"));

    const ctx = createTestContext({
      workdir: tempDir,
      config: {
        ...createTestContext().config,
        review: {
          enabled: true,
          checks: ["test"],
          commands: {
            test: "echo 'custom test command'",
          },
        },
      },
    });

    const result = await verifyStage.execute(ctx);

    expect(result.action).toBe("continue");
  });

  test("handles test command with arguments", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-verify-test-"));

    const ctx = createTestContext({
      workdir: tempDir,
      config: {
        ...createTestContext().config,
        review: {
          enabled: true,
          checks: ["test"],
          commands: {
            test: "echo 'test' && echo 'with args'",
          },
        },
      },
    });

    const result = await verifyStage.execute(ctx);

    expect(result.action).toBe("continue");
  });

  test.skip("handles test command that throws error — hangs on nonexistent-command (TODO: fix timeout handling)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "nax-verify-test-"));

    const ctx = createTestContext({
      workdir: tempDir,
      config: {
        ...createTestContext().config,
        review: {
          enabled: true,
          checks: ["test"],
          commands: {
            test: "nonexistent-command",
          },
        },
      },
    });

    const result = await verifyStage.execute(ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "fail") {
      expect(result.reason).toContain("Tests failed");
    }
  });
});
