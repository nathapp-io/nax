/**
 * Integration tests for precheck functionality
 *
 * Tests the complete precheck workflow including all Tier 1 blockers and Tier 2 warnings.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NaxConfig } from "../../src/config";
import type { PRD, UserStory } from "../../src/prd/types";
import { runPrecheck } from "../../src/precheck";
import type { PrecheckResult } from "../../src/precheck/types";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a valid git environment to allow checks to progress
 */
async function setupValidGitEnv(testDir: string): Promise<void> {
  await Bun.spawn(["git", "init"], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
  await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
  await Bun.spawn(["git", "config", "user.email", "test@test.com"], {
    cwd: testDir,
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
  // Create initial commit to make working tree clean
  writeFileSync(join(testDir, "README.md"), "# Test");
  await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
  await Bun.spawn(["git", "commit", "-m", "Initial"], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
}

const createMockConfig = (cwd: string, overrides: any = {}): NaxConfig => ({
  execution: {
    maxIterations: 10,
    iterationDelayMs: 1000,
    maxCostUSD: 10,
    testCommand: "echo 'test'",
    lintCommand: "echo 'lint'",
    typecheckCommand: "echo 'typecheck'",
    contextProviderTokenBudget: 2000,
    requireExplicitContextFiles: false,
    preflightExpectedFilesEnabled: false,
    cwd,
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
// Integration Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("runPrecheck integration", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "nax-test-precheck-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("returns PrecheckResult with blockers and warnings arrays", async () => {
    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result, exitCode, output } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    expect(result).toBeDefined();
    expect(result.blockers).toBeDefined();
    expect(Array.isArray(result.blockers)).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(exitCode).toBeDefined();
    expect(output).toBeDefined();
  });

  test("separates blocker checks from warning checks", async () => {
    // Create a minimal valid environment
    mkdirSync(join(testDir, ".git"));
    mkdirSync(join(testDir, "node_modules"));

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // All items in blockers should have tier: "blocker"
    for (const check of result.blockers) {
      expect(check.tier).toBe("blocker");
    }

    // All items in warnings should have tier: "warning"
    for (const check of result.warnings) {
      expect(check.tier).toBe("warning");
    }
  });

  test("includes git repo check in blockers", async () => {
    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // Fail-fast: only first blocker is collected (git-repo-exists fails first)
    expect(result.blockers.length).toBe(1);
    expect(result.blockers[0].name).toBe("git-repo-exists");
  });

  test("includes working tree check in blockers", async () => {
    mkdirSync(join(testDir, ".git"));

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // With fail-fast, if git repo passes, working-tree-clean is checked next
    // In test environment, working tree is often dirty
    const workingTreeCheck = result.blockers.find((c) => c.name === "working-tree-clean");
    expect(workingTreeCheck).toBeDefined();
  });

  test("stale lock check runs after git checks in sequence", async () => {
    // Create a stale lock to trigger the check
    await setupValidGitEnv(testDir);
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    writeFileSync(join(testDir, "nax.lock"), JSON.stringify({ pid: 12345, startedAt: threeHoursAgo.toISOString() }));
    // Commit the lock file to keep working tree clean
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add stale lock"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // Stale lock check should fail and be in blockers
    const staleLockCheck = result.blockers.find((c) => c.name === "no-stale-lock");
    expect(staleLockCheck).toBeDefined();
    expect(staleLockCheck?.passed).toBe(false);
  });

  test("runs PRD validation check after git checks", async () => {
    // Setup valid git environment to let precheck progress to PRD check
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));

    const config = createMockConfig(testDir);
    // Invalid PRD - will fail at PRD check
    const prd = createMockPRD([createMockStory({ id: "", title: "", description: "" })]);

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // Should have prd-valid check in blockers (failed)
    const prdValidCheck = result.blockers.find((c) => c.name === "prd-valid");
    expect(prdValidCheck).toBeDefined();
    expect(prdValidCheck?.passed).toBe(false);
  });

  // Note: Individual check implementations are tested in unit tests (test/unit/precheck-checks.test.ts)
  // Integration tests focus on orchestrator behavior (fail-fast, output formatting, etc.)

  test("Tier 2 warnings only run if all Tier 1 checks pass", async () => {
    // Setup complete valid environment to let Tier 2 checks run
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));
    // Add gitignore to avoid one warning
    writeFileSync(join(testDir, ".gitignore"), "nax.lock\nruns/\ntest/tmp/");
    // Commit the new file to keep working tree clean
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add gitignore"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // All Tier 1 should pass (no blockers)
    expect(result.blockers.length).toBe(0);

    // Tier 2 should run - some will fail (warnings), producing warnings array
    // Without CLAUDE.md, we should get at least one warning
    expect(result.warnings.length).toBeGreaterThan(0);

    // Verify CLAUDE.md warning (should fail since we didn't create it)
    const hasClaudeMd = result.warnings.some((w) => w.name === "claude-md-exists");
    expect(hasClaudeMd).toBe(true);
  });

  test("auto-defaults missing PRD fields in-memory during validation", async () => {
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));
    // Commit node_modules to keep working tree clean
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add node_modules"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const storyWithMissingFields = {
      id: "US-001",
      title: "Test",
      description: "Description",
      // tags, status, acceptanceCriteria intentionally omitted
      passes: false,
    } as any;

    const config = createMockConfig(testDir);
    const prd = createMockPRD([storyWithMissingFields]);

    const { result, output } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // PRD validation should pass after auto-defaulting (all Tier 1 passed means no blockers)
    expect(result.blockers.length).toBe(0);
    expect(output.passed).toBe(true);

    // The story should now have defaults
    expect(prd.userStories[0].tags).toEqual([]);
    expect(prd.userStories[0].status).toBe("pending");
    expect(prd.userStories[0].acceptanceCriteria).toEqual([]);
  });

  test("all blocker checks must pass for a clean environment", async () => {
    // Create a fully valid environment
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));
    writeFileSync(join(testDir, ".gitignore"), "node_modules/\nnax.lock\nnax/features/*/runs/\ntest/tmp/");
    // Commit these files to keep working tree clean
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add files"], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD([createMockStory({ id: "US-001", title: "Story 1", description: "Desc 1" })]);

    const { result, output } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // All Tier 1 checks should pass (no blockers)
    expect(result.blockers.length).toBe(0);
    // Tier 2 warnings should run
    expect(result.warnings.length).toBeGreaterThan(0);
    // Overall should pass
    expect(output.passed).toBe(true);

    // Each check should have passed/failed status
    for (const warning of result.warnings) {
      expect(typeof warning.passed).toBe("boolean");
    }
  });

  test("handles PRD with multiple stories", async () => {
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));
    // Commit node_modules to keep working tree clean
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add node_modules"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD([
      createMockStory({ id: "US-001", title: "Story 1", description: "Desc 1" }),
      createMockStory({ id: "US-002", title: "Story 2", description: "Desc 2" }),
      createMockStory({ id: "US-003", title: "Story 3", description: "Desc 3" }),
    ]);

    const { result, output } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // PRD validation should pass (all Tier 1 passed means no blockers)
    expect(result.blockers.length).toBe(0);
    expect(output.passed).toBe(true);
  });

  test("detects invalid PRD with missing required fields", async () => {
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));
    // Commit node_modules to keep working tree clean
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add node_modules"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD([createMockStory({ id: "", title: "No ID", description: "Desc" })]);

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    const prdValidCheck = result.blockers.find((c) => c.name === "prd-valid");
    expect(prdValidCheck?.passed).toBe(false);
  });

  test("skips command checks when commands are set to null", async () => {
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));
    // Commit node_modules to keep working tree clean
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add node_modules"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const config = createMockConfig(testDir, {
      testCommand: null,
      lintCommand: null,
      typecheckCommand: null,
    });
    const prd = createMockPRD();

    const { result, output } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // All Tier 1 checks should pass (commands are skipped, which counts as passing)
    expect(result.blockers.length).toBe(0);
    expect(output.passed).toBe(true);
    // Verify that the summary shows all checks passed
    expect(output.summary.failed).toBe(0);
  });

  test("fail-fast stops on first blocker, no warnings collected", async () => {
    // Missing .git directory - this will cause git repo check to fail immediately
    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // Fail-fast: only first blocker collected, no warnings run
    expect(result.blockers.length).toBe(1);
    expect(result.blockers[0].name).toBe("git-repo-exists");
    expect(result.warnings.length).toBe(0);
  });

  test("provides detailed messages for each check", async () => {
    mkdirSync(join(testDir, ".git"));
    mkdirSync(join(testDir, "node_modules"));

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // Every check should have a message
    for (const check of [...result.blockers, ...result.warnings]) {
      expect(check.message).toBeDefined();
      expect(check.message.length).toBeGreaterThan(0);
    }
  });
});

describe("precheck with stale lock detection", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "nax-test-precheck-"));
    mkdirSync(join(testDir, ".git"));
    mkdirSync(join(testDir, "node_modules"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("detects stale lock file older than 2 hours", async () => {
    await setupValidGitEnv(testDir);
    const lockPath = join(testDir, "nax.lock");
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    writeFileSync(lockPath, JSON.stringify({ pid: 12345, startedAt: threeHoursAgo.toISOString() }));
    // Commit the lock file to keep working tree clean
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add stale lock"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    const staleLockCheck = result.blockers.find((c) => c.name === "no-stale-lock");
    expect(staleLockCheck?.passed).toBe(false);
    expect(staleLockCheck?.message).toContain("stale");
  });

  test("passes with fresh lock file", async () => {
    await setupValidGitEnv(testDir);
    // node_modules already created in beforeEach
    const lockPath = join(testDir, "nax.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 12345, startedAt: new Date().toISOString() }));
    // Commit the lock file to keep working tree clean
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add fresh lock"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result, output } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // Fresh lock should pass, no blockers
    expect(result.blockers.length).toBe(0);
    expect(output.passed).toBe(true);
  });
});

describe("precheck with .gitignore validation", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "nax-test-precheck-"));
    mkdirSync(join(testDir, ".git"));
    mkdirSync(join(testDir, "node_modules"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("passes when .gitignore covers all nax runtime files", async () => {
    await setupValidGitEnv(testDir);
    // node_modules already created in beforeEach
    writeFileSync(
      join(testDir, ".gitignore"),
      `
node_modules/
nax.lock
nax/features/*/runs/
test/tmp/
`.trim(),
    );
    // Commit the gitignore to keep working tree clean
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add gitignore"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result, output } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // All Tier 1 should pass
    expect(result.blockers.length).toBe(0);
    // gitignore check should pass, so NOT in warnings array
    const gitignoreCheck = result.warnings.find((c) => c.name === "gitignore-covers-nax");
    expect(gitignoreCheck).toBeUndefined();
    // Overall should pass
    expect(output.passed).toBe(true);
  });

  test("warns when .gitignore is missing", async () => {
    await setupValidGitEnv(testDir);
    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    const gitignoreCheck = result.warnings.find((c) => c.name === "gitignore-covers-nax");
    expect(gitignoreCheck?.passed).toBe(false);
    expect(gitignoreCheck?.message).toContain("not found");
  });

  test("warns when .gitignore does not cover nax.lock", async () => {
    await setupValidGitEnv(testDir);
    writeFileSync(join(testDir, ".gitignore"), "node_modules/");
    // Commit the gitignore to keep working tree clean
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add incomplete gitignore"], {
      cwd: testDir,
      stdout: "ignore",
      stderr: "ignore",
    }).exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    const gitignoreCheck = result.warnings.find((c) => c.name === "gitignore-covers-nax");
    expect(gitignoreCheck?.passed).toBe(false);
    expect(gitignoreCheck?.message).toContain("nax.lock");
  });

  test("warns when .gitignore does not cover runs directories", async () => {
    await setupValidGitEnv(testDir);
    writeFileSync(
      join(testDir, ".gitignore"),
      `
nax.lock
test/tmp/
`.trim(),
    );
    // Commit the gitignore to keep working tree clean
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add incomplete gitignore"], {
      cwd: testDir,
      stdout: "ignore",
      stderr: "ignore",
    }).exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    const gitignoreCheck = result.warnings.find((c) => c.name === "gitignore-covers-nax");
    expect(gitignoreCheck?.passed).toBe(false);
    expect(gitignoreCheck?.message).toContain("runs");
  });
});

describe("precheck orchestrator behavior (US-002)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "nax-test-precheck-orch-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("stops on first Tier 1 blocker (fail-fast)", async () => {
    // No .git directory - first blocker should fail
    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // Should have exactly 1 blocker (git-repo-exists)
    expect(result.blockers.length).toBe(1);
    expect(result.blockers[0].name).toBe("git-repo-exists");
    expect(result.blockers[0].passed).toBe(false);

    // No warnings should be collected (fail-fast stops before Tier 2)
    expect(result.warnings.length).toBe(0);
  });

  test("runs all Tier 2 checks even if some warn", async () => {
    // Create a valid Tier 1 environment so Tier 2 checks run
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));
    // Commit node_modules directory to keep working tree clean
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add node_modules"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // No blockers (all Tier 1 passed)
    expect(result.blockers.length).toBe(0);

    // All Tier 2 checks should run, some will fail (produce warnings)
    // We expect at least warnings for missing CLAUDE.md and .gitignore
    expect(result.warnings.length).toBeGreaterThan(0);

    const hasClaudeMd = result.warnings.some((c) => c.name === "claude-md-exists");
    const hasGitignore = result.warnings.some((c) => c.name === "gitignore-covers-nax");
    expect(hasClaudeMd || hasGitignore).toBe(true);
  });

  test("JSON output matches spec schema", async () => {
    // Create minimal valid environment
    mkdirSync(join(testDir, ".git"));
    mkdirSync(join(testDir, "node_modules"));

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    // Capture console output
    const originalLog = console.log;
    let jsonOutput = "";
    console.log = (msg: string) => {
      jsonOutput += msg;
    };

    try {
      await runPrecheck(config, prd, { workdir: testDir, format: "json" });

      const output = JSON.parse(jsonOutput);

      // Verify schema: passed (boolean), blockers, warnings, summary, feature
      expect(output.passed).toBeDefined();
      expect(typeof output.passed).toBe("boolean");
      expect(output.blockers).toBeDefined();
      expect(Array.isArray(output.blockers)).toBe(true);
      expect(output.warnings).toBeDefined();
      expect(Array.isArray(output.warnings)).toBe(true);
      expect(output.summary).toBeDefined();
      expect(output.summary.total).toBeTypeOf("number");
      expect(output.summary.passed).toBeTypeOf("number");
      expect(output.summary.failed).toBeTypeOf("number");
      expect(output.summary.warnings).toBeTypeOf("number");
      expect(output.feature).toBe("test-feature");
    } finally {
      console.log = originalLog;
    }
  });

  test("human output shows emoji per check result", async () => {
    // Create minimal valid environment
    mkdirSync(join(testDir, ".git"));
    mkdirSync(join(testDir, "node_modules"));

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    // Capture console output
    const originalLog = console.log;
    const outputs: string[] = [];
    console.log = (msg: string) => {
      outputs.push(msg);
    };

    try {
      await runPrecheck(config, prd, { workdir: testDir, format: "human" });

      // Should have emoji indicators
      const hasCheckmark = outputs.some((line) => line.includes("✓"));
      const hasCross = outputs.some((line) => line.includes("✗"));
      const hasWarning = outputs.some((line) => line.includes("⚠"));

      // At least one emoji type should be present
      expect(hasCheckmark || hasCross || hasWarning).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  test("summary line shows total checks/passed/failed/warnings", async () => {
    // Create minimal valid environment
    mkdirSync(join(testDir, ".git"));
    mkdirSync(join(testDir, "node_modules"));

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    // Capture console output
    const originalLog = console.log;
    const outputs: string[] = [];
    console.log = (msg: string) => {
      outputs.push(msg);
    };

    try {
      await runPrecheck(config, prd, { workdir: testDir, format: "human" });

      // Find summary line
      const summaryLine = outputs.find((line) => line.includes("Checks:") && line.includes("total"));
      expect(summaryLine).toBeDefined();
      expect(summaryLine).toContain("passed");
      expect(summaryLine).toContain("failed");
      expect(summaryLine).toContain("warnings");
    } finally {
      console.log = originalLog;
    }
  });

  test("exit code 0 for pass", async () => {
    // Create fully valid environment
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));
    writeFileSync(join(testDir, "CLAUDE.md"), "# Project");
    writeFileSync(join(testDir, ".gitignore"), "nax.lock\nruns/\ntest/tmp/");
    // Commit these new files to keep working tree clean
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add files"], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { exitCode } = await runPrecheck(config, prd, { workdir: testDir, format: "human" });

    expect(exitCode).toBe(0);
  });

  test("exit code 1 for blocker", async () => {
    // Missing .git directory
    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { exitCode } = await runPrecheck(config, prd, { workdir: testDir, format: "human" });

    expect(exitCode).toBe(1);
  });

  test("exit code 2 for invalid PRD", async () => {
    // Create valid git environment to reach PRD check
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));

    const config = createMockConfig(testDir);
    const prd = createMockPRD([
      createMockStory({ id: "", title: "", description: "" }), // Invalid story
    ]);

    const { exitCode } = await runPrecheck(config, prd, { workdir: testDir, format: "human" });

    // Invalid PRD should return exit code 2 (per US-002 acceptance criteria)
    expect(exitCode).toBe(2);
  });

  test("collects all Tier 2 warnings even if some fail", async () => {
    // Create environment without CLAUDE.md and .gitignore
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));
    // Commit node_modules to keep working tree clean
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add node_modules"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // No blockers (Tier 1 passed)
    expect(result.blockers.length).toBe(0);

    // Should have multiple warnings
    expect(result.warnings.length).toBeGreaterThan(1);

    // Warnings should include CLAUDE.md and gitignore checks
    const claudeMdCheck = result.warnings.find((c) => c.name === "claude-md-exists");
    const gitignoreCheck = result.warnings.find((c) => c.name === "gitignore-covers-nax");

    expect(claudeMdCheck).toBeDefined();
    expect(gitignoreCheck).toBeDefined();
  });

  test("does not run Tier 2 checks if Tier 1 blocker fails", async () => {
    // No .git directory - first Tier 1 check fails
    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    // Should have 1 blocker
    expect(result.blockers.length).toBe(1);

    // Should have 0 warnings (Tier 2 checks not run)
    expect(result.warnings.length).toBe(0);
  });
});
