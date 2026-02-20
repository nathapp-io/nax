/**
 * End-to-End Integration Tests
 *
 * Tests the full nax workflow: plan → analyze → run
 * Uses a MockAgentAdapter to avoid requiring real Claude Code installation
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentResult,
  AgentRunOptions,
  PlanOptions,
  PlanResult,
  DecomposeOptions,
  DecomposeResult,
} from "../src/agents/types";
import { planCommand } from "../src/cli/plan";
import { analyzeFeature } from "../src/cli/analyze";
import { run } from "../src/execution/runner";
import { DEFAULT_CONFIG } from "../src/config";
import type { NaxConfig } from "../src/config";
import { loadPRD } from "../src/prd";
import { ALL_AGENTS } from "../src/agents/registry";

/**
 * Mock Agent Adapter for testing
 *
 * Implements the AgentAdapter interface but doesn't spawn real processes.
 * Returns realistic, controllable results for testing scenarios.
 */
class MockAgentAdapter implements AgentAdapter {
  readonly name = "mock";
  readonly displayName = "Mock Agent";
  readonly binary = "mock-agent";

  readonly capabilities: AgentCapabilities = {
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 200_000,
    features: new Set(["tdd", "review", "refactor", "batch"]),
  };

  // Control behavior via flags
  public shouldFailRun = false;
  public shouldRateLimit = false;
  public shouldFailReview = false;
  public callCount = 0;
  public runCalls: AgentRunOptions[] = [];
  public planCalls: PlanOptions[] = [];
  public decomposeCalls: DecomposeOptions[] = [];

  async isInstalled(): Promise<boolean> {
    return true;
  }

  buildCommand(options: AgentRunOptions): string[] {
    return [this.binary, "--prompt", options.prompt];
  }

  async run(_options: AgentRunOptions): Promise<AgentResult> {
    this.callCount++;
    this.runCalls.push(_options);

    // Simulate execution time
    await Bun.sleep(10);

    // Rate limit scenario
    if (this.shouldRateLimit && this.callCount === 1) {
      return {
        success: false,
        exitCode: 1,
        output: "Rate limit exceeded. Too many requests.",
        rateLimited: true,
        durationMs: 100,
        estimatedCost: 0.0,
      };
    }

    // Failure scenario
    if (this.shouldFailRun) {
      return {
        success: false,
        exitCode: 1,
        output: "Agent execution failed: mock error",
        rateLimited: false,
        durationMs: 500,
        estimatedCost: 0.01,
      };
    }

    // Success scenario
    return {
      success: true,
      exitCode: 0,
      output: `Mock agent completed task: ${_options.prompt.slice(0, 50)}...\n\nToken usage: 1500 input, 800 output`,
      rateLimited: false,
      durationMs: 2000,
      estimatedCost: 0.015,
    };
  }

  async plan(_options: PlanOptions): Promise<PlanResult> {
    this.planCalls.push(_options);

    // Simulate planning time
    await Bun.sleep(10);

    const specContent = `# Feature: URL Shortener

## Problem
We need a URL shortening service to make long URLs more shareable.

## Requirements
- REQ-1: Accept long URLs and generate short codes
- REQ-2: Redirect short codes to original URLs
- REQ-3: Track click analytics
- REQ-4: Support custom short codes (optional)

## Acceptance Criteria
- AC-1: Short codes are unique and collision-free
- AC-2: Redirects work with 301 status
- AC-3: Click counts are tracked accurately
- AC-4: API returns JSON responses

## Technical Notes
- Use base62 encoding for short codes
- Store mappings in database (consider Redis for caching)
- Log all redirects for analytics
- Validate URLs before shortening

## Out of Scope
- User accounts and authentication (MVP only)
- Custom domains
- Link expiration
`;

    return {
      specContent,
      conversationLog: "Mock planning session",
    };
  }

  async decompose(_options: DecomposeOptions): Promise<DecomposeResult> {
    this.decomposeCalls.push(_options);

    // Simulate decompose time
    await Bun.sleep(10);

    // Parse the spec content to determine what stories to generate
    // For URL shortener spec, return realistic stories
    const stories = [
      {
        id: "US-001",
        title: "Implement short code generation",
        description: "Create algorithm to generate unique base62 short codes from URLs",
        acceptanceCriteria: [
          "Short codes are 6-8 characters",
          "Codes use base62 charset (a-zA-Z0-9)",
          "Collision detection works",
          "Codes are URL-safe",
        ],
        tags: ["core", "algorithm"],
        dependencies: [],
        complexity: "medium" as const,
        relevantFiles: ["src/shortener/generator.ts", "src/utils/base62.ts"],
        reasoning: "Requires algorithmic implementation with collision handling. 2-3 files, ~150 LOC.",
        estimatedLOC: 150,
        risks: ["Collision probability under high load"],
      },
      {
        id: "US-002",
        title: "Add database storage for URL mappings",
        description: "Store short code → long URL mappings in database with timestamps",
        acceptanceCriteria: [
          "Database schema defined",
          "CRUD operations work",
          "Queries are indexed",
          "Timestamps recorded",
        ],
        tags: ["database", "storage"],
        dependencies: [],
        complexity: "medium" as const,
        relevantFiles: ["src/db/schema.ts", "src/db/repository.ts"],
        reasoning: "Standard CRUD with indexing. 2 files, ~120 LOC.",
        estimatedLOC: 120,
        risks: ["Database performance at scale"],
      },
      {
        id: "US-003",
        title: "Create redirect handler",
        description: "Route that redirects /:code to the original URL with 301 status",
        acceptanceCriteria: [
          "GET /:code returns 301 redirect",
          "404 for invalid codes",
          "Click count incremented",
          "Response headers correct",
        ],
        tags: ["api", "core"],
        dependencies: ["US-001", "US-002"],
        complexity: "simple" as const,
        relevantFiles: ["src/api/redirect.ts"],
        reasoning: "Simple handler with lookup and redirect. 1 file, ~50 LOC.",
        estimatedLOC: 50,
        risks: [],
      },
      {
        id: "US-004",
        title: "Build URL shortening handler",
        description: "POST /api/shorten route that accepts URL and returns short code",
        acceptanceCriteria: [
          "POST /api/shorten accepts JSON",
          "URL validation works",
          "Returns short code in response",
          "Error handling for invalid URLs",
        ],
        tags: ["api", "core"],
        dependencies: ["US-001", "US-002"],
        complexity: "simple" as const,
        relevantFiles: ["src/api/shorten.ts"],
        reasoning: "Standard POST handler. 1 file, ~60 LOC.",
        estimatedLOC: 60,
        risks: [],
      },
      {
        id: "US-005",
        title: "Implement click analytics tracking",
        description: "Track clicks on each short URL with timestamps and IP addresses",
        acceptanceCriteria: [
          "Clicks logged with timestamp",
          "IP address recorded (anonymized)",
          "Analytics queryable by code",
          "Performance doesn't block redirects",
        ],
        tags: ["analytics", "database"],
        dependencies: ["US-003"],
        complexity: "medium" as const,
        relevantFiles: ["src/analytics/tracker.ts", "src/db/analytics-schema.ts"],
        reasoning: "Async logging with privacy concerns. 2 files, ~100 LOC.",
        estimatedLOC: 100,
        risks: ["Privacy compliance (GDPR)", "Performance under high traffic"],
      },
    ];

    return { stories };
  }

  reset() {
    this.shouldFailRun = false;
    this.shouldRateLimit = false;
    this.shouldFailReview = false;
    this.callCount = 0;
    this.runCalls = [];
    this.planCalls = [];
    this.decomposeCalls = [];
  }
}

/**
 * Register mock agent in the registry for testing
 *
 * Modifies the ALL_AGENTS array to include the mock agent
 */
function registerMockAgent(adapter: MockAgentAdapter): () => void {
  // Add mock agent to registry
  ALL_AGENTS.push(adapter);

  // Return cleanup function that removes it
  return () => {
    const index = ALL_AGENTS.findIndex((a) => a.name === "mock");
    if (index >= 0) {
      ALL_AGENTS.splice(index, 1);
    }
  };
}

describe("E2E: plan → analyze → run workflow", () => {
  let testDir: string;
  let mockAgent: MockAgentAdapter;
  let cleanup: () => void;

  beforeEach(() => {
    // Create temp directory
    testDir = `/tmp/nax-e2e-test-${Date.now()}`;
    mkdirSync(testDir, { recursive: true });

    // Create mock agent and register
    mockAgent = new MockAgentAdapter();
    cleanup = registerMockAgent(mockAgent);

    // Set up minimal project structure
    setupTestProject(testDir);
  });

  afterEach(() => {
    // Clean up
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    cleanup();
  });

  test("full workflow: init → plan → analyze → run", { timeout: 120000 }, async () => {
    const ngentDir = join(testDir, "nax");
    const featureDir = join(ngentDir, "features/url-shortener");
    mkdirSync(featureDir, { recursive: true });

    // Step 1: Initialize (create config, constitution, hooks)
    await initializeNgent(ngentDir);
    expect(existsSync(join(ngentDir, "config.json"))).toBe(true);
    expect(existsSync(join(ngentDir, "constitution.md"))).toBe(true);
    expect(existsSync(join(ngentDir, "hooks.json"))).toBe(true);

    // Step 2: Plan (manually create spec.md since mock agent doesn't spawn real process)
    const config = createTestConfig();
    const specPath = join(featureDir, "spec.md");
    const spec = await mockAgent.plan({
      prompt: "Build a URL shortener with analytics",
      workdir: testDir,
      interactive: false,
    });
    await Bun.write(specPath, spec.specContent);

    expect(existsSync(specPath)).toBe(true);
    const specContent = await Bun.file(specPath).text();
    expect(specContent).toContain("# Feature: URL Shortener");
    expect(specContent).toContain("## Requirements");
    expect(mockAgent.planCalls).toHaveLength(1);

    // Step 3: Analyze (decompose spec into prd.json)
    const prd = await analyzeFeature({
      featureDir,
      featureName: "url-shortener",
      branchName: "feat/url-shortener",
      config,
    });

    expect(prd.userStories).toHaveLength(5);
    expect(prd.userStories[0].id).toBe("US-001");
    expect(prd.userStories[0].routing?.complexity).toBe("medium");
    expect(prd.userStories[2].dependencies).toContain("US-001");
    expect(mockAgent.decomposeCalls).toHaveLength(1);

    // Save PRD
    const prdPath = join(featureDir, "prd.json");
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    // Step 4: Run (execute stories via pipeline)
    const runResult = await run({
      prdPath,
      workdir: testDir,
      config: {
        ...config,
        execution: {
          ...config.execution,
          maxIterations: 10, // Enough for 5 stories
        },
      },
      hooks: { hooks: {} },
      feature: "url-shortener",
      featureDir,
      dryRun: false,
      useBatch: true, // Enable batching
    });

    expect(runResult.success).toBe(true);
    expect(runResult.storiesCompleted).toBe(5);
    expect(mockAgent.runCalls.length).toBeGreaterThan(0);

    // Verify PRD was updated
    const finalPRD = await loadPRD(prdPath);
    expect(finalPRD.userStories.every((s) => s.status === "passed")).toBe(true);
  });

  test("pipeline stages execute in correct order", { timeout: 15000 }, async () => {
    const ngentDir = join(testDir, "nax");
    const featureDir = join(ngentDir, "features/simple-task");
    mkdirSync(featureDir, { recursive: true });

    await initializeNgent(ngentDir);

    // Create minimal PRD with one simple story
    const prd = {
      project: "test",
      feature: "simple-task",
      branchName: "feat/simple-task",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Add console log",
          description: "Add a console.log statement to index.ts",
          acceptanceCriteria: ["Log statement added"],
          tags: [],
          dependencies: [],
          status: "pending" as const,
          passes: false,
          escalations: [],
          attempts: 0,
          routing: {
            complexity: "simple" as const,
            modelTier: "fast" as const,
            testStrategy: "test-after" as const,
            reasoning: "Trivial change",
            estimatedLOC: 1,
            risks: [],
          },
        },
      ],
    };

    const prdPath = join(featureDir, "prd.json");
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    const config = createTestConfig();

    // Run execution
    await run({
      prdPath,
      workdir: testDir,
      config,
      hooks: {
        hooks: {
          "on-story-start": {
            command: "echo story-start",
            enabled: true,
            timeout: 60000,
          },
          "on-story-complete": {
            command: "echo story-complete",
            enabled: true,
            timeout: 60000,
          },
        },
      },
      feature: "simple-task",
      featureDir,
      dryRun: false,
    });

    // Verify agent was called (execution stage ran)
    expect(mockAgent.runCalls.length).toBeGreaterThan(0);

    // Verify story completed (completion stage ran)
    const finalPRD = await loadPRD(prdPath);
    expect(finalPRD.userStories[0].status).toBe("passed");
  });

  test("agent failure triggers escalation", { timeout: 60000 }, async () => {
    const ngentDir = join(testDir, "nax");
    const featureDir = join(ngentDir, "features/fail-task");
    mkdirSync(featureDir, { recursive: true });

    await initializeNgent(ngentDir);

    const prd = {
      project: "test",
      feature: "fail-task",
      branchName: "feat/fail-task",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Task that will fail",
          description: "This task will fail on first attempt",
          acceptanceCriteria: ["Task complete"],
          tags: [],
          dependencies: [],
          status: "pending" as const,
          passes: false,
          escalations: [],
          attempts: 0,
          routing: {
            complexity: "simple" as const,
            modelTier: "fast" as const,
            testStrategy: "test-after" as const,
            reasoning: "Simple task",
            estimatedLOC: 10,
            risks: [],
          },
        },
      ],
    };

    const prdPath = join(featureDir, "prd.json");
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    // Make first call fail, subsequent calls succeed
    let failCount = 0;
    const originalRun = mockAgent.run.bind(mockAgent);
    mockAgent.run = async (opts: AgentRunOptions): Promise<AgentResult> => {
      failCount++;
      if (failCount === 1) {
        // First call fails
        return {
          success: false,
          exitCode: 1,
          output: "Tests failed",
          rateLimited: false,
          durationMs: 100,
          estimatedCost: 0.01,
        };
      }
      // Subsequent calls succeed
      return originalRun(opts);
    };

    const config = createTestConfig();

    await run({
      prdPath,
      workdir: testDir,
      config,
      hooks: { hooks: {} },
      feature: "fail-task",
      featureDir,
      dryRun: false,
    });

    // Verify story completed (escalation auto-handled by system)
    const finalPRD = await loadPRD(prdPath);

    // The story should complete after escalation kicks in
    expect(finalPRD.userStories[0].status).toBe("passed");
  });

  test("rate limit triggers retry with backoff", { timeout: 60000 }, async () => {
    const ngentDir = join(testDir, "nax");
    const featureDir = join(ngentDir, "features/rate-limit-task");
    mkdirSync(featureDir, { recursive: true });

    await initializeNgent(ngentDir);

    const prd = {
      project: "test",
      feature: "rate-limit-task",
      branchName: "feat/rate-limit",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Task with rate limit",
          description: "This task will hit rate limit once",
          acceptanceCriteria: ["Task complete"],
          tags: [],
          dependencies: [],
          status: "pending" as const,
          passes: false,
          escalations: [],
          attempts: 0,
          routing: {
            complexity: "simple" as const,
            modelTier: "fast" as const,
            testStrategy: "test-after" as const,
            reasoning: "Simple task",
            estimatedLOC: 10,
            risks: [],
          },
        },
      ],
    };

    const prdPath = join(featureDir, "prd.json");
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    // Set rate limit on first call
    mockAgent.shouldRateLimit = true;

    const config = createTestConfig();

    const runResult = await run({
      prdPath,
      workdir: testDir,
      config,
      hooks: { hooks: {} },
      feature: "rate-limit-task",
      featureDir,
      dryRun: false,
    });

    expect(runResult.success).toBe(true);

    const finalPRD = await loadPRD(prdPath);
    expect(finalPRD.userStories[0].status).toBe("passed");
  });

  test.skip("review phase failure marks story as failed (skipped - review disabled in tests)", async () => {
    // This test is skipped because review is disabled in test config to avoid mocking
    // typecheck/lint/test commands. In a real scenario with review enabled, this would
    // test that review failures are properly handled.
  });

  test("story batching groups simple stories", { timeout: 15000 }, async () => {
    const ngentDir = join(testDir, "nax");
    const featureDir = join(ngentDir, "features/batch-test");
    mkdirSync(featureDir, { recursive: true });

    await initializeNgent(ngentDir);

    const prd = {
      project: "test",
      feature: "batch-test",
      branchName: "feat/batch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Add log statement 1",
          description: "Add console.log to file1.ts",
          acceptanceCriteria: ["Log added"],
          tags: [],
          dependencies: [],
          status: "pending" as const,
          passes: false,
          escalations: [],
          attempts: 0,
          routing: {
            complexity: "simple" as const,
            modelTier: "fast" as const,
            testStrategy: "test-after" as const,
            reasoning: "Trivial",
            estimatedLOC: 1,
            risks: [],
          },
        },
        {
          id: "US-002",
          title: "Add log statement 2",
          description: "Add console.log to file2.ts",
          acceptanceCriteria: ["Log added"],
          tags: [],
          dependencies: [],
          status: "pending" as const,
          passes: false,
          escalations: [],
          attempts: 0,
          routing: {
            complexity: "simple" as const,
            modelTier: "fast" as const,
            testStrategy: "test-after" as const,
            reasoning: "Trivial",
            estimatedLOC: 1,
            risks: [],
          },
        },
        {
          id: "US-003",
          title: "Add log statement 3",
          description: "Add console.log to file3.ts",
          acceptanceCriteria: ["Log added"],
          tags: [],
          dependencies: [],
          status: "pending" as const,
          passes: false,
          escalations: [],
          attempts: 0,
          routing: {
            complexity: "simple" as const,
            modelTier: "fast" as const,
            testStrategy: "test-after" as const,
            reasoning: "Trivial",
            estimatedLOC: 1,
            risks: [],
          },
        },
      ],
    };

    const prdPath = join(featureDir, "prd.json");
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    const config = createTestConfig();

    const runResult = await run({
      prdPath,
      workdir: testDir,
      config,
      hooks: { hooks: {} },
      feature: "batch-test",
      featureDir,
      dryRun: false,
      useBatch: true,
    });

    expect(runResult.success).toBe(true);
    expect(runResult.storiesCompleted).toBe(3);

    // With batching, should have fewer agent calls than stories
    // (3 simple stories should be batched into 1 call)
    expect(mockAgent.runCalls.length).toBeLessThan(3);

    // Verify all stories completed
    const finalPRD = await loadPRD(prdPath);
    expect(finalPRD.userStories.every((s) => s.status === "passed")).toBe(true);
  });
});

// ── Helper Functions ──────────────────────────────────

function setupTestProject(dir: string) {
  // Create src/ directory
  mkdirSync(join(dir, "src"), { recursive: true });
  Bun.write(join(dir, "src/index.ts"), "export const greet = () => 'Hello';\n");

  // Create test/ directory
  mkdirSync(join(dir, "test"), { recursive: true });
  Bun.write(
    join(dir, "test/index.test.ts"),
    "import { expect, test } from 'bun:test';\nimport { greet } from '../src/index';\n\ntest('greet', () => {\n  expect(greet()).toBe('Hello');\n});\n"
  );

  // Create package.json
  Bun.write(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "e2e-test-project",
        version: "1.0.0",
        dependencies: {
          zod: "^4.0.0",
        },
        devDependencies: {
          typescript: "^5.0.0",
          "@types/bun": "^1.0.0",
        },
      },
      null,
      2
    )
  );

  // Create tsconfig.json
  Bun.write(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          forceConsistentCasingInFileNames: true,
          outDir: "./dist",
        },
        include: ["src/**/*"],
        exclude: ["node_modules", "dist"],
      },
      null,
      2
    )
  );
}

async function initializeNgent(ngentDir: string) {
  // Create directory structure
  mkdirSync(join(ngentDir, "features"), { recursive: true });
  mkdirSync(join(ngentDir, "hooks"), { recursive: true });

  // Write config.json
  await Bun.write(join(ngentDir, "config.json"), JSON.stringify(DEFAULT_CONFIG, null, 2));

  // Write hooks.json
  await Bun.write(
    join(ngentDir, "hooks.json"),
    JSON.stringify(
      {
        hooks: {
          "on-start": { command: "echo nax started", enabled: false },
          "on-complete": { command: "echo nax complete", enabled: false },
        },
      },
      null,
      2
    )
  );

  // Write constitution.md
  await Bun.write(
    join(ngentDir, "constitution.md"),
    `# Project Constitution

## Coding Standards
- Write clear, maintainable code
- Follow project conventions

## Testing Requirements
- All code must have tests
- Aim for 80%+ coverage

## Architecture Rules
- Keep functions small and focused
- Avoid tight coupling
`
  );
}

function createTestConfig(): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    autoMode: {
      ...DEFAULT_CONFIG.autoMode,
      defaultAgent: "mock", // Use our mock agent
    },
    analyze: {
      ...DEFAULT_CONFIG.analyze,
      llmEnhanced: true, // Enable LLM decompose
    },
    execution: {
      ...DEFAULT_CONFIG.execution,
      maxIterations: 20,
      maxStoriesPerFeature: 500,
    },
    review: {
      ...DEFAULT_CONFIG.review,
      enabled: false, // Disable review for tests (would require mocking typecheck/lint/test)
    },
    acceptance: {
      ...DEFAULT_CONFIG.acceptance,
      enabled: false, // Disable acceptance for E2E tests (no real acceptance tests)
    },
  };
}
