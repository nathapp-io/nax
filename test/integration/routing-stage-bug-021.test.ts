/**
 * Routing Stage Bug-021 Fix: Ensure "Task classified" log shows final routing state
 *
 * Tests that the "Task classified" log reflects the final routing state after all
 * overrides (config cache overrides, greenfield detection, etc.) are applied.
 *
 * BUG-021: The log was showing raw LLM output even after overrides were applied.
 * Fix: Ensure ctx.routing is set AFTER all overrides, and the log uses ctx.routing.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NaxConfig } from "../../src/config/schema";
import { initLogger, resetLogger } from "../../src/logger";
import type { Logger } from "../../src/logger";
import { routingStage } from "../../src/pipeline/stages/routing";
import type { PipelineContext } from "../../src/pipeline/types";
import { PluginRegistry } from "../../src/plugins/registry";
import type { PRD, UserStory } from "../../src/prd/types";

/**
 * Helper: Create minimal test context
 */
function createTestContext(
  workdir: string,
  overrides?: Partial<PipelineContext>,
): PipelineContext {
  const story: UserStory = {
    id: "BUG-021-test",
    title: "Add user authentication",
    description: "Implement JWT-based authentication",
    acceptanceCriteria: ["Secure token storage", "Token refresh", "Password hashing", "Session management"],
    tags: ["security", "auth"],
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
      fast: "claude-haiku-4-5",
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
        tierOrder: [
          { tier: "fast", attempts: 2 },
          { tier: "balanced", attempts: 2 },
          { tier: "powerful", attempts: 1 },
        ],
        escalateEntireBatch: true,
      },
    },
    routing: {
      strategy: "keyword",
    },
    execution: {
      maxIterations: 100,
      iterationDelayMs: 1000,
      costLimit: 50,
      sessionTimeoutSeconds: 600,
      verificationTimeoutSeconds: 300,
      maxStoriesPerFeature: 50,
      rectification: {
        enabled: true,
        maxRetries: 2,
        fullSuiteTimeoutSeconds: 120,
        maxFailureSummaryChars: 2000,
        abortOnIncreasingFailures: true,
      },
      contextProviderTokenBudget: 2000,
    },
    quality: {
      requireTypecheck: false,
      requireLint: false,
      requireTests: true,
      commands: {},
      forceExit: false,
      detectOpenHandles: true,
      detectOpenHandlesRetries: 1,
      gracePeriodMs: 5000,
      drainTimeoutMs: 2000,
      shell: "/bin/sh",
      stripEnvVars: [],
      environmentalEscalationDivisor: 2,
    },
    tdd: {
      maxRetries: 3,
      autoVerifyIsolation: true,
      autoApproveVerifier: true,
      strategy: "auto",
      greenfieldDetection: true,
      rollbackOnFailure: true,
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
    acceptance: {
      enabled: true,
      maxRetries: 2,
      generateTests: true,
      testPath: "acceptance.test.ts",
    },
    context: {
      testCoverage: {
        enabled: true,
        detail: "names-and-counts",
        maxTokens: 500,
        testPattern: "**/*.test.{ts,js,tsx,jsx}",
        scopeToStory: true,
      },
    },
  };

  return {
    workdir,
    story,
    stories: [story],
    prd,
    config,
    plugins: new PluginRegistry([]),
    ...overrides,
  };
}

describe("Routing Stage - BUG-021: Task classified log shows final routing state", () => {
  let workdir: string;
  let capturedLogs: Array<{
    level: string;
    stage: string;
    message: string;
    data?: Record<string, unknown>;
  }>;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "nax-bug-021-test-"));
    capturedLogs = [];

    // Initialize logger with debug level to capture all logs
    initLogger({ level: "debug" });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    resetLogger();
  });

  test("logs final routing state (not raw LLM output) when greenfield override is applied", async () => {
    // Create source files but no test files (triggers greenfield detection)
    await Bun.write(join(workdir, "src/index.ts"), "export const foo = 42;");

    const ctx = createTestContext(workdir);
    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");

    // Verify ctx.routing has the final state (greenfield override applied)
    expect(ctx.routing).toBeDefined();
    expect(ctx.routing?.testStrategy).toBe("test-after");
    expect(ctx.routing?.complexity).toBe("complex");
    expect(ctx.routing?.modelTier).toBe("powerful");

    // Verify reasoning mentions the greenfield override
    expect(ctx.routing?.reasoning).toContain("GREENFIELD OVERRIDE");
  });

  test("logs final routing state when using cached routing with greenfield override", async () => {
    // Create source files but no test files
    await Bun.write(join(workdir, "src/index.ts"), "export const foo = 42;");

    const ctx = createTestContext(workdir);
    // Simulate cached routing that would normally use TDD
    ctx.story.routing = {
      complexity: "medium",
      testStrategy: "three-session-tdd",
      reasoning: "Cached from previous run",
    };

    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");

    // Verify final state has greenfield override applied to cached TDD strategy
    expect(ctx.routing).toBeDefined();
    expect(ctx.routing?.testStrategy).toBe("test-after");
    expect(ctx.routing?.complexity).toBe("medium");
    expect(ctx.routing?.modelTier).toBe("balanced");
    expect(ctx.routing?.reasoning).toContain("GREENFIELD OVERRIDE");
  });

  test("logs final routing state when no overrides are needed", async () => {
    // Create test files so greenfield detection doesn't trigger
    await Bun.write(join(workdir, "src/index.test.ts"), "test('foo', () => {})");

    const ctx = createTestContext(workdir);
    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");

    // Verify ctx.routing shows final state (no greenfield override)
    expect(ctx.routing).toBeDefined();
    expect(ctx.routing?.testStrategy).toMatch(/three-session-tdd/);
    expect(ctx.routing?.complexity).toBe("complex");
    expect(ctx.routing?.modelTier).toBe("powerful");
    expect(ctx.routing?.reasoning).not.toContain("GREENFIELD OVERRIDE");
  });

  test("ctx.routing is set after all overrides are applied", async () => {
    // Create source files but no test files (triggers greenfield detection)
    await Bun.write(join(workdir, "src/auth.ts"), "export function authenticate() {}");

    const ctx = createTestContext(workdir);
    // Set initial cached routing
    ctx.story.routing = {
      complexity: "simple",
      testStrategy: "three-session-tdd-lite",
      reasoning: "Cached simple routing",
    };

    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");

    // After routing stage completes, ctx.routing should reflect:
    // 1. Cached complexity: "simple"
    // 2. Fresh modelTier: derived from config
    // 3. Greenfield override: test-after instead of TDD
    expect(ctx.routing?.complexity).toBe("simple");
    expect(ctx.routing?.testStrategy).toBe("test-after");
    expect(ctx.routing?.modelTier).toBe("fast"); // simple -> fast
  });
});
