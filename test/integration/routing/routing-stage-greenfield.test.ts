// RE-ARCH: keep
/**
 * Routing Stage Greenfield Detection Tests
 *
 * Tests BUG-010 fix: greenfield detection forces test-after strategy
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NaxConfig } from "../../../src/config/schema";
import { initLogger, resetLogger } from "../../../src/logger";
import { routingStage } from "../../../src/pipeline/stages/routing";
import type { PipelineContext } from "../../../src/pipeline/types";
import { PluginRegistry } from "../../../src/plugins/registry";
import type { PRD, UserStory } from "../../../src/prd/types";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function createTestFile(workdir: string, filepath: string, content = ""): Promise<void> {
  const fullPath = join(workdir, filepath);
  await Bun.write(fullPath, content);
}

/** Helper: Create minimal test context */
function createTestContext(
  workdir: string,
  greenfieldDetectionEnabled = true,
  overrides?: Partial<PipelineContext>,
): PipelineContext {
  const story: UserStory = {
    id: "US-001",
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
      greenfieldDetection: greenfieldDetectionEnabled,
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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Routing Stage - Greenfield Detection (BUG-010)", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "nax-routing-greenfield-test-"));
    await initLogger({ level: "silent" });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    resetLogger();
  });

  test("forces test-after when no test files exist (greenfield)", async () => {
    // Create source files but no test files
    await createTestFile(workdir, "src/index.ts", "export const foo = 42;");

    const ctx = createTestContext(workdir, true);
    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.routing).toBeDefined();
    expect(ctx.routing?.testStrategy).toBe("test-after");
    expect(ctx.routing?.reasoning).toContain("GREENFIELD OVERRIDE");
  });

  test("preserves TDD when test files exist", async () => {
    // Create test files
    await createTestFile(workdir, "src/index.test.ts", "test('foo', () => {})");

    const ctx = createTestContext(workdir, true);
    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.routing).toBeDefined();
    // Should use TDD for complex stories with existing tests
    expect(ctx.routing?.testStrategy).toMatch(/three-session-tdd/);
  });

  test("respects greenfieldDetection config disabled", async () => {
    // No test files, but greenfield detection disabled
    await createTestFile(workdir, "src/index.ts", "export const foo = 42;");

    const ctx = createTestContext(workdir, false); // greenfieldDetection = false
    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.routing).toBeDefined();
    // Should use TDD even though greenfield, because detection is disabled
    expect(ctx.routing?.testStrategy).toMatch(/three-session-tdd/);
  });

  test("only overrides TDD strategies, not test-after", async () => {
    // Create a simple story that would normally get test-after
    const ctx = createTestContext(workdir, true);
    ctx.story.title = "Fix typo in README";
    ctx.story.description = "Update README.md";
    ctx.story.acceptanceCriteria = ["Typo fixed"];

    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.routing).toBeDefined();
    // test-after strategy should remain unchanged
    expect(ctx.routing?.testStrategy).toBe("test-after");
  });

  test("handles both TDD and TDD-lite strategies", async () => {
    // Test that greenfield detection works for both TDD variants
    await createTestFile(workdir, "src/index.ts", "export const foo = 42;");

    const ctx = createTestContext(workdir, true);
    ctx.story.routing = {
      complexity: "medium",
      testStrategy: "three-session-tdd-lite",
      reasoning: "Pre-cached routing",
    };

    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.routing).toBeDefined();
    expect(ctx.routing?.testStrategy).toBe("test-after");
    expect(ctx.routing?.reasoning).toContain("GREENFIELD OVERRIDE");
  });

  test("ignores test files in node_modules", async () => {
    // Create test file in node_modules (should be ignored)
    await createTestFile(workdir, "node_modules/lib/foo.test.ts", "test('foo', () => {})");

    const ctx = createTestContext(workdir, true);
    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.routing).toBeDefined();
    // Should treat as greenfield since node_modules is ignored
    expect(ctx.routing?.testStrategy).toBe("test-after");
  });

  test("detects various test file patterns", async () => {
    // Test .spec.ts pattern
    await createTestFile(workdir, "src/foo.spec.ts", "describe('foo', () => {})");

    const ctx = createTestContext(workdir, true);
    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.routing).toBeDefined();
    // Should preserve TDD because .spec.ts files exist
    expect(ctx.routing?.testStrategy).toMatch(/three-session-tdd/);
  });
});
