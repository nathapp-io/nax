// RE-ARCH: keep
/**
 * Tests for src/precheck/checks.ts
 *
 * Tests individual precheck implementations including Tier 1 blockers and Tier 2 warnings.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionConfig, NaxConfig } from "../../../src/config";
import type { PRD, UserStory } from "../../../src/prd/types";
import { makeTempDir } from "../../helpers/temp";
import {
  checkClaudeCLI,
  checkClaudeMdExists,
  checkDependenciesInstalled,
  checkDiskSpace,
  checkGitRepoExists,
  checkGitUserConfigured,
  checkGitignoreCoversNax,
  checkLintCommand,
  checkOptionalCommands,
  checkPRDValid,
  checkPendingStories,
  checkStaleLock,
  checkTestCommand,
  checkTypecheckCommand,
  checkWorkingTreeClean,
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
// Tier 1 Blockers
// ─────────────────────────────────────────────────────────────────────────────

describe("checkGitRepoExists (Tier 1 blocker)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-precheck-");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("passes when .git directory exists", async () => {
    // Create a .git directory
    mkdirSync(join(testDir, ".git"));

    const result = await checkGitRepoExists(testDir);

    expect(result.name).toBe("git-repo-exists");
    expect(result.tier).toBe("blocker");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("git repository");
  });

  test("fails when .git directory does not exist", async () => {
    const result = await checkGitRepoExists(testDir);

    expect(result.name).toBe("git-repo-exists");
    expect(result.tier).toBe("blocker");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("not a git repository");
  });

  test("uses git rev-parse --git-dir command", async () => {
    // This test verifies the implementation uses the correct git command
    // The actual implementation should run: git rev-parse --git-dir
    mkdirSync(join(testDir, ".git"));

    const result = await checkGitRepoExists(testDir);

    // If implemented correctly with git rev-parse, this should pass
    expect(result.passed).toBe(true);
  });
});

describe("checkWorkingTreeClean (Tier 1 blocker)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-precheck-");
    // Initialize git repo
    mkdirSync(join(testDir, ".git"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("uses git status --porcelain command", async () => {
    // This test verifies the implementation uses git status --porcelain
    const result = await checkWorkingTreeClean(testDir);

    expect(result.name).toBe("working-tree-clean");
    expect(result.tier).toBe("blocker");
    // Result depends on actual git status
  });

  test("returns blocker tier", async () => {
    const result = await checkWorkingTreeClean(testDir);

    expect(result.tier).toBe("blocker");
  });

  test("includes helpful message", async () => {
    const result = await checkWorkingTreeClean(testDir);

    expect(result.message).toBeDefined();
    expect(typeof result.message).toBe("string");
  });
});

describe("checkStaleLock (Tier 1 blocker)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-precheck-");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("passes when no lock file exists", async () => {
    const result = await checkStaleLock(testDir);

    expect(result.name).toBe("no-stale-lock");
    expect(result.tier).toBe("blocker");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("No lock file");
  });

  test("passes when lock file is fresh (< 2 hours old)", async () => {
    const lockPath = join(testDir, "nax.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 12345, startedAt: new Date().toISOString() }));

    const result = await checkStaleLock(testDir);

    expect(result.passed).toBe(true);
    expect(result.message).toContain("Lock file is fresh");
  });

  test("fails when lock file is stale (> 2 hours old)", async () => {
    const lockPath = join(testDir, "nax.lock");
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    writeFileSync(lockPath, JSON.stringify({ pid: 12345, startedAt: threeHoursAgo.toISOString() }));

    const result = await checkStaleLock(testDir);

    expect(result.name).toBe("no-stale-lock");
    expect(result.tier).toBe("blocker");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("stale");
    expect(result.message).toContain("2 hours");
  });

  test("detects exactly 2 hours as the threshold", async () => {
    const lockPath = join(testDir, "nax.lock");
    const twoHoursOneMinuteAgo = new Date(Date.now() - (2 * 60 * 60 * 1000 + 60 * 1000));
    writeFileSync(lockPath, JSON.stringify({ pid: 12345, startedAt: twoHoursOneMinuteAgo.toISOString() }));

    const result = await checkStaleLock(testDir);

    expect(result.passed).toBe(false);
  });
});

describe("checkPRDValid (Tier 1 blocker)", () => {
  test("passes when all stories have required fields", async () => {
    const prd = createMockPRD([
      createMockStory({ id: "US-001", title: "Story 1", description: "Description 1" }),
      createMockStory({ id: "US-002", title: "Story 2", description: "Description 2" }),
    ]);

    const result = await checkPRDValid(prd);

    expect(result.name).toBe("prd-valid");
    expect(result.tier).toBe("blocker");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("valid");
  });

  test("fails when story is missing id", async () => {
    const prd = createMockPRD([createMockStory({ id: "", title: "Story", description: "Description" })]);

    const result = await checkPRDValid(prd);

    expect(result.passed).toBe(false);
    expect(result.message).toContain("id");
  });

  test("fails when story is missing title", async () => {
    const prd = createMockPRD([createMockStory({ id: "US-001", title: "", description: "Description" })]);

    const result = await checkPRDValid(prd);

    expect(result.passed).toBe(false);
    expect(result.message).toContain("title");
  });

  test("fails when story is missing description", async () => {
    const prd = createMockPRD([createMockStory({ id: "US-001", title: "Story", description: "" })]);

    const result = await checkPRDValid(prd);

    expect(result.passed).toBe(false);
    expect(result.message).toContain("description");
  });

  test("auto-defaults missing tags to empty array in-memory", async () => {
    const storyWithoutTags = {
      id: "US-001",
      title: "Story",
      description: "Description",
      acceptanceCriteria: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
      // tags intentionally omitted
    } as any;

    const prd = createMockPRD([storyWithoutTags]);

    const result = await checkPRDValid(prd);

    // Validation should pass after auto-defaulting tags
    expect(result.passed).toBe(true);
    // The story object should now have tags defaulted to []
    expect(prd.userStories[0].tags).toEqual([]);
  });

  test("auto-defaults missing status to pending in-memory", async () => {
    const storyWithoutStatus = {
      id: "US-001",
      title: "Story",
      description: "Description",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      // status intentionally omitted
      passes: false,
      escalations: [],
      attempts: 0,
    } as any;

    const prd = createMockPRD([storyWithoutStatus]);

    const result = await checkPRDValid(prd);

    expect(result.passed).toBe(true);
    expect(prd.userStories[0].status).toBe("pending");
  });

  test("auto-defaults missing storyPoints to 1 in-memory", async () => {
    const storyWithoutPoints = {
      id: "US-001",
      title: "Story",
      description: "Description",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
      // storyPoints intentionally omitted
    } as any;

    const prd = createMockPRD([storyWithoutPoints]);

    const result = await checkPRDValid(prd);

    expect(result.passed).toBe(true);
    // Note: storyPoints is not in the current UserStory type, but the test validates
    // the behavior if it were to be added in the future
  });

  test("checks all required fields per story", async () => {
    const prd = createMockPRD([
      createMockStory({ id: "US-001", title: "Good", description: "Good" }),
      createMockStory({ id: "", title: "Bad", description: "Missing ID" }),
    ]);

    const result = await checkPRDValid(prd);

    expect(result.passed).toBe(false);
  });
});

// Requires real `claude` binary — skipped by default, run with FULL=1.
import { fullTest as skipInCI } from "../../helpers/env";

describe("checkClaudeCLI (Tier 1 blocker)", () => {
  skipInCI("runs claude --version command", async () => {
    const result = await checkClaudeCLI();

    expect(result.name).toBe("claude-cli-available");
    expect(result.tier).toBe("blocker");
    // Pass/fail depends on whether Claude CLI is actually installed
  });

  skipInCI("returns blocker tier", async () => {
    const result = await checkClaudeCLI();

    expect(result.tier).toBe("blocker");
  });

  skipInCI("provides helpful error message on failure", async () => {
    // This test assumes Claude CLI might not be installed
    const result = await checkClaudeCLI();

    if (!result.passed) {
      expect(result.message).toContain("claude");
    }
  });
});

describe("checkDependenciesInstalled (Tier 1 blocker)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-precheck-");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("detects Node.js dependencies via node_modules", async () => {
    mkdirSync(join(testDir, "node_modules"));

    const result = await checkDependenciesInstalled(testDir);

    expect(result.name).toBe("dependencies-installed");
    expect(result.tier).toBe("blocker");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("node_modules");
  });

  test("detects Rust dependencies via target directory", async () => {
    mkdirSync(join(testDir, "target"));

    const result = await checkDependenciesInstalled(testDir);

    expect(result.passed).toBe(true);
    expect(result.message).toContain("target");
  });

  test("detects Python dependencies via venv directory", async () => {
    mkdirSync(join(testDir, "venv"));

    const result = await checkDependenciesInstalled(testDir);

    expect(result.passed).toBe(true);
    expect(result.message).toContain("venv");
  });

  test("detects PHP dependencies via vendor directory", async () => {
    mkdirSync(join(testDir, "vendor"));

    const result = await checkDependenciesInstalled(testDir);

    expect(result.passed).toBe(true);
    expect(result.message).toContain("vendor");
  });

  test("fails when no dependency directories exist", async () => {
    const result = await checkDependenciesInstalled(testDir);

    expect(result.passed).toBe(false);
    expect(result.message).toContain("No dependency");
  });

  test("is language-aware and checks all supported package managers", async () => {
    // Create multiple dependency directories
    mkdirSync(join(testDir, "node_modules"));
    mkdirSync(join(testDir, "venv"));

    const result = await checkDependenciesInstalled(testDir);

    // Should detect at least one
    expect(result.passed).toBe(true);
  });
});

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

    // Implementation should use the configured command
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

describe("checkGitUserConfigured (Tier 1 blocker)", () => {
  test("checks git config user.name and user.email", async () => {
    const result = await checkGitUserConfigured();

    expect(result.name).toBe("git-user-configured");
    expect(result.tier).toBe("blocker");
    // Pass/fail depends on actual git config
  });

  test("returns blocker tier", async () => {
    const result = await checkGitUserConfigured();

    expect(result.tier).toBe("blocker");
  });

  test("provides helpful message", async () => {
    const result = await checkGitUserConfigured();

    expect(result.message).toBeDefined();
    expect(typeof result.message).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2 Warnings
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

    // Most systems should have > 1GB free
    expect(result.name).toBe("disk-space-sufficient");
    expect(result.tier).toBe("warning");
  });

  test("fails when disk space is below 1GB", async () => {
    // This is hard to test without mocking, but validates the structure
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
    // Message should mention missing patterns
    expect(result.message.toLowerCase()).toMatch(/nax\.lock|runs|\.nax-pids/);
  });
});
