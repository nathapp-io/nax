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
import type { NaxConfig } from "@/config/schema";
import { initLogger, resetLogger } from "@/logger";
import { routingStage } from "@/pipeline/stages/routing";
import type { PipelineContext } from "@/pipeline/types";
import { PluginRegistry } from "@/plugins/registry";
import type { PRD, UserStory } from "@/prd/types";
import { makeDispatchContext, makeNaxConfig, makeTempDir } from "@test/helpers";

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

  const config: NaxConfig = makeNaxConfig({
    version: 1,
    models: {
      fast: "claude-haiku-4-5",
      balanced: "claude-sonnet-4-5",
      powerful: "claude-opus-4-6",
    },
    autoMode: {
      enabled: true,
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
        maxAttemptsTotal: 2,
        fullSuiteTimeoutSeconds: 120,
        maxFailureSummaryChars: 2000,
        abortOnIncreasingFailures: true,
      },
      contextProviderTokenBudget: 2000,
      // Explicit co-located test patterns (resolver tier-2, ADR-009 SSOT) so
      // greenfield detection matches src-co-located tests without needing a git
      // fixture for the detection tier. Mirrors a project using co-located tests.
      smartTestRunner: {
        enabled: true,
        fallback: "import-grep",
        maxScanFiles: 200,
        testFilePatterns: [
          "**/*.test.ts",
          "**/*.test.tsx",
          "**/*.test.js",
          "**/*.test.jsx",
          "**/*.spec.ts",
          "**/*.spec.js",
          "**/*.spec.tsx",
          "**/*.spec.jsx",
        ],
      },
    },
    quality: {
      commands: {},
      forceExit: false,
      detectOpenHandles: true,
      detectOpenHandlesRetries: 1,
      gracePeriodMs: 5000,
      drainTimeoutMs: 2000,
      shell: "/bin/sh",
      stripEnvVars: [],
    },
    tdd: {
      maxRetries: 3,
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
  });

  return {
    workdir,
    story,
    stories: [story],
    prd,
    config,
    plugins: new PluginRegistry([]),
    ...makeDispatchContext(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

// BUG-010
describe("Routing Stage - Greenfield Detection forces test-after strategy when no tests exist", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = makeTempDir("nax-routing-greenfield-test-");
    await initLogger({ level: "silent" });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    resetLogger();
  });

  test("keeps three-session-tdd for SECURITY-critical greenfield (no downgrade)", async () => {
    const ctx = createTestContext(workdir, true);
    // default story is "Add user authentication" / tags [security, auth] → security-critical

    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.routing?.testStrategy).toBe("three-session-tdd");
    expect(ctx.routing?.reasoning).not.toContain("GREENFIELD OVERRIDE");
  });

  test("downgrades NON-security greenfield to tdd-simple", async () => {
    const ctx = createTestContext(workdir, true);
    ctx.story.title = "Render dashboard widget";
    ctx.story.description = "Add a chart component";
    ctx.story.acceptanceCriteria = ["Renders chart"];
    ctx.story.tags = [];
    ctx.story.routing = {
      complexity: "complex",
      modelTier: "balanced",
      testStrategy: "three-session-tdd",
      reasoning: "complex non-security",
    };

    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.routing?.testStrategy).toBe("tdd-simple");
    expect(ctx.routing?.reasoning).toContain("GREENFIELD OVERRIDE");
    // BUG-35: ctx.story.routing must stay in sync with ctx.routing after the
    // greenfield override — escalation code and rectifier prompts read story.routing,
    // not ctx.routing, and previously kept the stale pre-override value here.
    expect(ctx.story.routing?.testStrategy).toBe("tdd-simple");
    expect(ctx.story.routing?.reasoning).toContain("GREENFIELD OVERRIDE");
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

  test("only overrides three-session strategies, not single-session test-after", async () => {
    // A story already routed to test-after (single-session) must pass through the
    // greenfield check untouched — the override only fires for three-session strategies.
    const ctx = createTestContext(workdir, true);
    ctx.story.title = "Fix typo in README";
    ctx.story.description = "Update README.md";
    ctx.story.acceptanceCriteria = ["Typo fixed"];
    ctx.story.tags = [];
    ctx.story.routing = {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "single-session test-after",
    };

    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.routing).toBeDefined();
    // test-after strategy should remain unchanged (no GREENFIELD OVERRIDE)
    expect(ctx.routing?.testStrategy).toBe("test-after");
    expect(ctx.routing?.reasoning).not.toContain("GREENFIELD OVERRIDE");
  });

  test("keeps three-session-tdd-lite for security-critical greenfield", async () => {
    // Test that greenfield detection preserves TDD-lite for security stories
    await createTestFile(workdir, "src/index.ts", "export const foo = 42;");

    const ctx = createTestContext(workdir, true);
    // default story is security-critical ("Add user authentication" / tags [security, auth])
    ctx.story.routing = {
      complexity: "medium",
      testStrategy: "three-session-tdd-lite",
      reasoning: "Pre-cached routing",
    };

    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.routing).toBeDefined();
    expect(ctx.routing?.testStrategy).toBe("three-session-tdd-lite");
    expect(ctx.routing?.reasoning).not.toContain("GREENFIELD OVERRIDE");
  });

  test("ignores test files in node_modules", async () => {
    // Create test file in node_modules (should be ignored)
    await createTestFile(workdir, "node_modules/lib/foo.test.ts", "test('foo', () => {})");

    const ctx = createTestContext(workdir, true);
    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.routing).toBeDefined();
    // Greenfield (node_modules ignored) + security-critical story → keep three-session-tdd
    expect(ctx.routing?.testStrategy).toBe("three-session-tdd");
    expect(ctx.routing?.reasoning).not.toContain("GREENFIELD OVERRIDE");
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
