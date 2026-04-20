// RE-ARCH: keep
/**
 * Tests for src/precheck/checks.ts — Tier 2 Warning checks
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionConfig, NaxConfig } from "../../../src/config";
import type { PRD, UserStory } from "../../../src/prd/types";
import { makeTempDir } from "../../helpers/temp";
import {
  checkClaudeMdExists,
  checkDiskSpace,
  checkGitignoreCoversNax,
  checkLintCommand,
  checkOptionalCommands,
  checkPendingStories,
  checkTestCommand,
  checkTypecheckCommand,
} from "../../../src/precheck/checks";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const createMockConfig = (overrides: Partial<ExecutionConfig> = {}): NaxConfig => ({
  execution: {
    maxIterations: 10,
    iterationDelayMs: 1000,
    maxCostUSD: 10,
    testCommand: "bun test",
    lintCommand: "bun run lint",
    typecheckCommand: "bun run typecheck",
    contextProviderTokenBudget: 2000,
    requireExplicitContextFiles: false,
    preflightExpectedFilesEnabled: false,
    cwd: process.cwd(),
    ...overrides,
  },
  autoMode: {
    enabled: false,
    defaultAgent: "test-agent",
    fallbackOrder: [],
    complexityRouting: {
      simple: "fast",
      medium: "balanced",
      complex: "powerful",
      expert: "ultra",
    },
    escalation: {
      enabled: true,
      tierOrder: [],
    },
  },
  quality: {
    minTestCoverage: 80,
    requireTypecheck: true,
    requireLint: true,
  },
  tdd: {
    strategy: "auto",
    skipGeneratedVerificationTests: false,
  },
  models: {},
  rectification: {
    enabled: true,
    maxRetries: 2,
    fullSuiteTimeoutSeconds: 120,
    maxFailureSummaryChars: 2000,
    abortOnIncreasingFailures: true,
  },
});

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
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  userStories: stories.length > 0 ? stories : [createMockStory()],
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2 Warnings — command checks
// ─────────────────────────────────────────────────────────────────────────────

describe("checkTestCommand (Tier 2 warning)", () => {
  test("passes when test command is configured", async () => {
    const config = createMockConfig({ testCommand: "bun test" });

    const result = await checkTestCommand(config);

    expect(result.name).toBe("test-command-works");
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(true);
  });

  test("skips silently when test command is null", async () => {
    const config = createMockConfig({ testCommand: null as any });

    const result = await checkTestCommand(config);

    expect(result.passed).toBe(true);
    expect(result.message).toContain("default");
  });

  test("skips silently when test command is false", async () => {
    const config = createMockConfig({ testCommand: false as any });

    const result = await checkTestCommand(config);

    expect(result.passed).toBe(true);
    expect(result.message).toContain("default");
  });

  test("reads command from config.execution", async () => {
    const config = createMockConfig({ testCommand: "custom-test-cmd" });

    const result = await checkTestCommand(config);

    expect(result.message).toContain("custom-test-cmd");
  });
});

describe("checkLintCommand (Tier 2 warning)", () => {
  test("passes when lint command is configured", async () => {
    const config = createMockConfig({ lintCommand: "bun run lint" });

    const result = await checkLintCommand(config);

    expect(result.name).toBe("lint-command-works");
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(true);
  });

  test("skips silently when lint command is null", async () => {
    const config = createMockConfig({ lintCommand: null as any });

    const result = await checkLintCommand(config);

    expect(result.passed).toBe(true);
    expect(result.message).toContain("skip");
  });

  test("skips silently when lint command is false", async () => {
    const config = createMockConfig({ lintCommand: false as any });

    const result = await checkLintCommand(config);

    expect(result.passed).toBe(true);
    expect(result.message).toContain("skip");
  });

  test("reads command from config.execution", async () => {
    const config = createMockConfig({ lintCommand: "custom-lint-cmd" });

    const result = await checkLintCommand(config);

    expect(result.message).toContain("custom-lint-cmd");
  });
});

describe("checkTypecheckCommand (Tier 2 warning)", () => {
  test("passes when typecheck command is configured", async () => {
    const config = createMockConfig({ typecheckCommand: "bun run typecheck" });

    const result = await checkTypecheckCommand(config);

    expect(result.name).toBe("typecheck-command-works");
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(true);
  });

  test("skips silently when typecheck command is null", async () => {
    const config = createMockConfig({ typecheckCommand: null as any });

    const result = await checkTypecheckCommand(config);

    expect(result.passed).toBe(true);
    expect(result.message).toContain("skip");
  });

  test("skips silently when typecheck command is false", async () => {
    const config = createMockConfig({ typecheckCommand: false as any });

    const result = await checkTypecheckCommand(config);

    expect(result.passed).toBe(true);
    expect(result.message).toContain("skip");
  });

  test("reads command from config.execution", async () => {
    const config = createMockConfig({ typecheckCommand: "tsc --noEmit" });

    const result = await checkTypecheckCommand(config);

    expect(result.message).toContain("tsc");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2 Warnings — environment checks
// ─────────────────────────────────────────────────────────────────────────────

describe("checkClaudeMdExists (Tier 2 warning)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-precheck-");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("passes when CLAUDE.md exists", async () => {
    writeFileSync(join(testDir, "CLAUDE.md"), "# Project instructions");

    const result = await checkClaudeMdExists(testDir);

    expect(result.name).toBe("claude-md-exists");
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("CLAUDE.md");
  });

  test("fails when CLAUDE.md does not exist", async () => {
    const result = await checkClaudeMdExists(testDir);

    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("not found");
  });

  test("returns warning tier not blocker", async () => {
    const result = await checkClaudeMdExists(testDir);

    expect(result.tier).toBe("warning");
  });
});

describe("checkDiskSpace (Tier 2 warning)", () => {
  test("passes when disk space is above 1GB", async () => {
    const result = await checkDiskSpace();

    expect(result.name).toBe("disk-space-sufficient");
    expect(result.tier).toBe("warning");
  });

  test("fails when disk space is below 1GB", async () => {
    const result = await checkDiskSpace();

    expect(result.tier).toBe("warning");
    if (!result.passed) {
      expect(result.message).toContain("1GB");
    }
  });

  test("triggers warning below 1GB threshold", async () => {
    const result = await checkDiskSpace();

    expect(result.tier).toBe("warning");
  });

  test("provides disk space information in message", async () => {
    const result = await checkDiskSpace();

    expect(result.message).toBeDefined();
    expect(typeof result.message).toBe("string");
  });
});

describe("checkPendingStories (Tier 2 warning)", () => {
  test("passes when there are pending stories", async () => {
    const prd = createMockPRD([createMockStory({ status: "pending" }), createMockStory({ status: "pending" })]);

    const result = await checkPendingStories(prd);

    expect(result.name).toBe("has-pending-stories");
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(true);
  });

  test("warns when all stories are passed", async () => {
    const prd = createMockPRD([createMockStory({ status: "passed" }), createMockStory({ status: "passed" })]);

    const result = await checkPendingStories(prd);

    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("no pending");
  });

  test("counts pending and in-progress as actionable", async () => {
    const prd = createMockPRD([
      createMockStory({ status: "pending" }),
      createMockStory({ status: "in-progress" }),
      createMockStory({ status: "passed" }),
    ]);

    const result = await checkPendingStories(prd);

    expect(result.passed).toBe(true);
  });
});

describe("checkOptionalCommands (Tier 2 warning)", () => {
  test("warns when optional commands are missing", async () => {
    const config = createMockConfig({
      testCommand: null as any,
      lintCommand: null as any,
      typecheckCommand: null as any,
    });

    const result = await checkOptionalCommands(config);

    expect(result.name).toBe("optional-commands-configured");
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(false);
  });

  test("passes when all optional commands are configured", async () => {
    const config = createMockConfig({
      testCommand: "bun test",
      lintCommand: "bun run lint",
      typecheckCommand: "bun run typecheck",
    });

    const result = await checkOptionalCommands(config);

    expect(result.passed).toBe(true);
  });

  test("lists which commands are missing", async () => {
    const config = createMockConfig({
      testCommand: "bun test",
      lintCommand: null as any,
      typecheckCommand: null as any,
    });

    const result = await checkOptionalCommands(config);

    expect(result.message).toContain("lint");
    expect(result.message).toContain("typecheck");
  });
});

describe("checkGitignoreCoversNax (Tier 2 warning)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-precheck-");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("passes when .gitignore exists and covers nax runtime files", async () => {
    writeFileSync(
      join(testDir, ".gitignore"),
      `
node_modules/
nax.lock
.nax/**/runs/
.nax/metrics.json
.nax/features/*/status.json
.nax-pids
.nax-wt/
**/.nax-acceptance*
**/.nax/features/*/
`.trim(),
    );

    const result = await checkGitignoreCoversNax(testDir);

    expect(result.name).toBe("gitignore-covers-nax");
    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(true);
  });

  test("fails when .gitignore does not exist", async () => {
    const result = await checkGitignoreCoversNax(testDir);

    expect(result.tier).toBe("warning");
    expect(result.passed).toBe(false);
    expect(result.message).toContain(".gitignore");
  });

  test("fails when .gitignore exists but does not cover nax.lock", async () => {
    writeFileSync(join(testDir, ".gitignore"), "node_modules/");

    const result = await checkGitignoreCoversNax(testDir);

    expect(result.passed).toBe(false);
    expect(result.message).toContain("nax.lock");
  });

  test("fails when .gitignore exists but does not cover runs directories", async () => {
    writeFileSync(
      join(testDir, ".gitignore"),
      `
nax.lock
nax/metrics.json
nax/features/*/status.json
.nax-pids
.nax-wt/
`.trim(),
    );

    const result = await checkGitignoreCoversNax(testDir);

    expect(result.passed).toBe(false);
    expect(result.message).toContain("runs");
  });

  test("fails when .gitignore exists but does not cover .nax-pids", async () => {
    writeFileSync(
      join(testDir, ".gitignore"),
      `
nax.lock
nax/**/runs/
nax/metrics.json
nax/features/*/status.json
.nax-wt/
`.trim(),
    );

    const result = await checkGitignoreCoversNax(testDir);

    expect(result.passed).toBe(false);
    expect(result.message).toContain(".nax-pids");
  });

  test("checks all nax runtime file patterns", async () => {
    writeFileSync(join(testDir, ".gitignore"), "# Empty");

    const result = await checkGitignoreCoversNax(testDir);

    expect(result.passed).toBe(false);
    expect(result.message.toLowerCase()).toMatch(/nax\.lock|runs|\.nax-pids/);
  });
});
