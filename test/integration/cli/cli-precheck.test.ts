// RE-ARCH: keep
/**
 * Integration tests for CLI precheck command
 *
 * Tests:
 * - Command registration and flag parsing
 * - Directory resolution via resolveProject()
 * - Human and JSON output formats
 * - Exit codes (0=pass, 1=blocker, 2=invalid PRD)
 * - Error handling for missing feature/prd.json
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { precheckCommand } from "../../../src/commands/precheck";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config";
import { run } from "../../../src/execution";
import type { PRD, UserStory } from "../../../src/prd/types";
import { loadPRD } from "../../../src/prd";
import { EXIT_CODES, runPrecheck } from "../../../src/precheck";
import type { PrecheckResult } from "../../../src/precheck/types";

const TEMP_DIR = join(import.meta.dir, "tmp-precheck-cli");

/**
 * Helper to create a test project structure
 */
function setupTestProject(name: string): {
  projectDir: string;
  naxDir: string;
  featureDir: string;
  prdPath: string;
} {
  const projectDir = join(TEMP_DIR, name);
  const naxDir = join(projectDir, "nax");
  const featureDir = join(naxDir, "features", "test-feature");
  const prdPath = join(featureDir, "prd.json");

  mkdirSync(featureDir, { recursive: true });

  // Write minimal config.json
  Bun.write(
    join(naxDir, "config.json"),
    JSON.stringify(
      {
        feature: "test-feature",
        routing: { enabled: true, tierLabels: { fast: 1, balanced: 2, powerful: 3 } },
        quality: { test: { enabled: true, command: "echo test" } },
      },
      null,
      2,
    ),
  );

  // Initialize git repo to satisfy checks
  Bun.spawnSync(["git", "init", "-q"], { cwd: projectDir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: projectDir });
  Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: projectDir });

  // Create node_modules to satisfy dependencies check
  mkdirSync(join(projectDir, "node_modules"), { recursive: true });

  return { projectDir, naxDir, featureDir, prdPath };
}

/**
 * Helper to create a valid PRD
 */
function createValidPRD(): PRD {
  return {
    version: "0.1.0",
    project: "test-project",
    feature: "test-feature",
    branch: "feat/test-feature",
    branchName: "feat/test-feature",
    userStories: [
      {
        id: "US-001",
        title: "Test Story",
        description: "Test description",
        acceptanceCriteria: [{ id: "AC-1", criterion: "Test criterion", testStrategy: "integration" }],
        tags: [],
        routing: {
          tier: "fast",
          complexity: "simple",
          estimatedCost: 0.01,
          security: false,
          thinkingBudget: 1000,
        },
        dependencies: [],
      },
    ],
    totalStories: 1,
    completedStories: 0,
    progress: 0,
  };
}

describe("CLI precheck command", () => {
  beforeEach(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
    mkdirSync(TEMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  test("should resolve project directory with -d flag", async () => {
    const { projectDir, prdPath } = setupTestProject("test-d-flag");

    // Write valid PRD
    await Bun.write(prdPath, JSON.stringify(createValidPRD()));

    // Commit everything to satisfy working-tree-clean check
    Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
    Bun.spawnSync(["git", "commit", "-m", "init", "-q"], { cwd: projectDir });

    // Mock process.exit to capture exit code
    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      // Don't actually exit in tests
    }) as never;

    try {
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: false,
      });
    } catch (err) {
      // Expected - command calls process.exit
    } finally {
      process.exit = originalExit;
    }

    // Should exit with code 0 (success) or 1 (warning)
    expect(exitCode).toBeDefined();
    expect([EXIT_CODES.SUCCESS, EXIT_CODES.BLOCKER]).toContain(exitCode);
  });

  test("should accept -f flag for feature name", async () => {
    const { projectDir, prdPath } = setupTestProject("test-f-flag");

    // Write valid PRD
    await Bun.write(prdPath, JSON.stringify(createValidPRD()));

    // Commit to satisfy checks
    Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
    Bun.spawnSync(["git", "commit", "-m", "init", "-q"], { cwd: projectDir });

    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
    }) as never;

    try {
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: false,
      });
    } catch (err) {
      // Expected
    } finally {
      process.exit = originalExit;
    }

    expect(exitCode).toBeDefined();
  });

  test("should output JSON format with --json flag", async () => {
    const { projectDir, prdPath } = setupTestProject("test-json-flag");

    // Write valid PRD
    await Bun.write(prdPath, JSON.stringify(createValidPRD()));

    // Commit to satisfy checks
    Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
    Bun.spawnSync(["git", "commit", "-m", "init", "-q"], { cwd: projectDir });

    // Capture console.log output
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => {
      logs.push(msg);
    };

    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
    }) as never;

    try {
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: true,
      });
    } catch (err) {
      // Expected
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
    }

    // Should have JSON output
    expect(logs.length).toBeGreaterThan(0);

    // Try to parse first log as JSON
    const jsonOutput = JSON.parse(logs[0]);
    expect(jsonOutput).toHaveProperty("passed");
    expect(jsonOutput).toHaveProperty("blockers");
    expect(jsonOutput).toHaveProperty("warnings");
    expect(jsonOutput).toHaveProperty("summary");
    expect(jsonOutput).toHaveProperty("feature");
    expect(jsonOutput.feature).toBe("test-feature");
  });

  test("should exit with code 2 for invalid PRD", async () => {
    const { projectDir, prdPath } = setupTestProject("test-invalid-prd");

    // Write PRD that will pass loading but fail validation
    await Bun.write(
      prdPath,
      JSON.stringify({
        version: "0.1.0",
        // Missing required fields: project, feature, branchName
        userStories: [],
        totalStories: 0,
        completedStories: 0,
        progress: 0,
      }),
    );

    // Commit to satisfy git checks
    Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
    Bun.spawnSync(["git", "commit", "-m", "init", "-q"], { cwd: projectDir });

    let exitCode: number | undefined;
    const originalExit = process.exit;
    const originalError = console.error;
    const originalLog = console.log;
    console.error = () => {}; // Suppress error output
    console.log = () => {}; // Suppress check output

    process.exit = ((code?: number) => {
      exitCode = code;
    }) as never;

    try {
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: false,
      });
    } catch (err) {
      // Expected
    } finally {
      process.exit = originalExit;
      console.error = originalError;
      console.log = originalLog;
    }

    expect(exitCode).toBe(EXIT_CODES.INVALID_PRD);
  });

  test("should exit with code 2 when prd.json is missing", async () => {
    const { projectDir } = setupTestProject("test-missing-prd");

    // Don't create prd.json

    let exitCode: number | undefined;
    const originalExit = process.exit;
    const originalError = console.error;
    console.error = () => {}; // Suppress error output

    process.exit = ((code?: number) => {
      exitCode = code;
    }) as never;

    try {
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: false,
      });
    } catch (err) {
      // Expected
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }

    expect(exitCode).toBe(EXIT_CODES.INVALID_PRD);
  });

  test("should handle missing feature flag with error", async () => {
    const { projectDir, naxDir } = setupTestProject("test-no-feature");

    // Remove feature from config
    await Bun.write(
      join(naxDir, "config.json"),
      JSON.stringify(
        {
          routing: { enabled: true },
          quality: { test: { enabled: true } },
        },
        null,
        2,
      ),
    );

    let exitCode: number | undefined;
    const originalExit = process.exit;
    const originalError = console.error;
    console.error = () => {}; // Suppress error output

    process.exit = ((code?: number) => {
      exitCode = code;
    }) as never;

    try {
      await precheckCommand({
        dir: projectDir,
        json: false,
      });
    } catch (err) {
      // Expected
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }

    expect(exitCode).toBe(1);
  });

  test("should use resolveProject() for directory resolution", async () => {
    const { projectDir, prdPath } = setupTestProject("test-resolve-project");

    // Write valid PRD
    await Bun.write(prdPath, JSON.stringify(createValidPRD()));

    // Commit to satisfy checks
    Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
    Bun.spawnSync(["git", "commit", "-m", "init", "-q"], { cwd: projectDir });

    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
    }) as never;

    try {
      // Should resolve project from explicit -d flag
      await precheckCommand({
        feature: "test-feature",
        dir: projectDir,
        json: false,
      });
    } catch (err) {
      // Expected
    } finally {
      process.exit = originalExit;
    }

    // Should succeed (or have blockers, but not fail to resolve)
    expect(exitCode).toBeDefined();
    expect(exitCode).not.toBe(undefined);
  });
});
/**
 * Integration tests for precheck functionality
 *
 * Tests the complete precheck workflow including all Tier 1 blockers and Tier 2 warnings.
 */

// These integration tests run the full precheck pipeline including checkClaudeCLI
// (a Tier 1 blocker). In CI, the `claude` binary is not installed, so checkClaudeCLI
// always adds a blocker — causing all assertions like `expect(blockers.length).toBe(0)`
// to fail. The test logic is sound; the environment is simply incomplete.
// Run these tests locally on Mac01/VPS where claude is installed.
const describeWithClaude = process.env.CI ? describe.skip : describe;

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
    iterationDelayMs: 0,
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

describeWithClaude("runPrecheck integration", () => {
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

describeWithClaude("precheck with stale lock detection", () => {
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

describeWithClaude("precheck with .gitignore validation", () => {
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

describeWithClaude("precheck orchestrator behavior (US-002)", () => {
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

/**
 * US-002: Precheck orchestrator with formatted output
 *
 * Acceptance criteria verification tests
 */

// Skip in CI: AC2, AC5, AC6 call runPrecheck() which includes checkClaudeCLI as a
// Tier 1 blocker. Without the claude binary installed, blockers.length > 0 always,
// breaking assertions like expect(blockers.length).toBe(0). These ACs test correct
// orchestration behaviour and pass reliably on Mac01/VPS where claude is installed.
const skipInCI = process.env.CI ? test.skip : test;

// Helper to create a minimal valid git environment
async function setupGitRepo(dir: string): Promise<void> {
  mkdirSync(join(dir, ".git"));
  await Bun.spawn(["git", "init"], { cwd: dir, stdout: "ignore", stderr: "ignore" }).exited;
  await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: dir, stdout: "ignore", stderr: "ignore" }).exited;
  await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: dir, stdout: "ignore", stderr: "ignore" })
    .exited;
  writeFileSync(join(dir, "README.md"), "# Test");
  await Bun.spawn(["git", "add", "."], { cwd: dir, stdout: "ignore", stderr: "ignore" }).exited;
  await Bun.spawn(["git", "commit", "-m", "init"], { cwd: dir, stdout: "ignore", stderr: "ignore" }).exited;
}

const createConfig = (workdir: string): NaxConfig =>
  ({
    execution: {
      maxIterations: 10,
      iterationDelayMs: 0,
      maxCostUSD: 10,
      testCommand: "echo test",
      lintCommand: "echo lint",
      typecheckCommand: "echo typecheck",
      contextProviderTokenBudget: 2000,
      requireExplicitContextFiles: false,
      preflightExpectedFilesEnabled: false,
      cwd: workdir,
    },
    autoMode: {
      enabled: false,
      defaultAgent: "test",
      fallbackOrder: [],
      complexityRouting: {},
      escalation: { enabled: false, tierOrder: [] },
    },
    quality: { minTestCoverage: 80, requireTypecheck: true, requireLint: true },
    tdd: { strategy: "auto", skipGeneratedVerificationTests: false },
    models: {},
    rectification: {
      enabled: true,
      maxRetries: 2,
      fullSuiteTimeoutSeconds: 120,
      maxFailureSummaryChars: 2000,
      abortOnIncreasingFailures: true,
    },
  }) as NaxConfig;

const createPRD = (): PRD => ({
  project: "test",
  feature: "test-feature",
  branchName: "test",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  userStories: [
    {
      id: "US-001",
      title: "Test",
      description: "Test description",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    },
  ],
});

describe("US-002: Precheck orchestrator acceptance criteria", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "nax-test-us002-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("AC1: Runs Tier 1 checks first, stops on first failure", async () => {
    // No .git directory - should fail on first check
    const config = createConfig(testDir);
    const prd = createPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json", silent: true });

    // Should have exactly 1 blocker (fail-fast)
    expect(result.blockers.length).toBe(1);
    expect(result.blockers[0].name).toBe("git-repo-exists");
  });

  skipInCI("AC2: Runs all Tier 2 checks even if some warn", async () => {
    // Create valid Tier 1 environment
    await setupGitRepo(testDir);
    mkdirSync(join(testDir, "node_modules"));

    const config = createConfig(testDir);
    const prd = createPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json", silent: true });

    // No blockers
    expect(result.blockers.length).toBe(0);

    // All Tier 2 checks should run (5 total)
    // At least 2 will fail (CLAUDE.md, .gitignore)
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });

  test("AC3: Human output shows emoji per check result", async () => {
    await setupGitRepo(testDir);
    mkdirSync(join(testDir, "node_modules"));

    const config = createConfig(testDir);
    const prd = createPRD();

    // Capture console output
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (msg: string) => logs.push(msg);

    try {
      await runPrecheck(config, prd, { workdir: testDir, format: "human" });

      // Should have emoji indicators
      const hasCheckmark = logs.some((l) => l.includes("✓"));
      const hasWarning = logs.some((l) => l.includes("⚠"));

      expect(hasCheckmark || hasWarning).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  test("AC4: JSON output matches spec schema", async () => {
    await setupGitRepo(testDir);
    mkdirSync(join(testDir, "node_modules"));

    const config = createConfig(testDir);
    const prd = createPRD();

    const originalLog = console.log;
    let jsonOutput = "";
    console.log = (msg: string) => {
      jsonOutput += msg;
    };

    try {
      await runPrecheck(config, prd, { workdir: testDir, format: "json" });

      const output = JSON.parse(jsonOutput);

      // Verify schema fields
      expect(typeof output.passed).toBe("boolean");
      expect(Array.isArray(output.blockers)).toBe(true);
      expect(Array.isArray(output.warnings)).toBe(true);
      expect(output.summary).toBeDefined();
      expect(typeof output.summary.total).toBe("number");
      expect(typeof output.summary.passed).toBe("number");
      expect(typeof output.summary.failed).toBe("number");
      expect(typeof output.summary.warnings).toBe("number");
      expect(output.feature).toBe("test-feature");
    } finally {
      console.log = originalLog;
    }
  });

  skipInCI("AC5: Exit code 0 for pass, 1 for blocker, 2 for invalid PRD", async () => {
    // Test exit code 0 (pass)
    await setupGitRepo(testDir);
    mkdirSync(join(testDir, "node_modules"));
    writeFileSync(join(testDir, "CLAUDE.md"), "# Test");
    writeFileSync(join(testDir, ".gitignore"), "nax.lock\nruns/\ntest/tmp/");
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "add"], { cwd: testDir, stdout: "ignore" }).exited;

    let config = createConfig(testDir);
    const prd = createPRD();
    let result = await runPrecheck(config, prd, { workdir: testDir, format: "json", silent: true });
    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);

    // Test exit code 1 (blocker)
    const testDir2 = mkdtempSync(join(tmpdir(), "nax-test-blocker-"));
    config = createConfig(testDir2);
    result = await runPrecheck(config, prd, { workdir: testDir2, format: "json", silent: true });
    expect(result.exitCode).toBe(EXIT_CODES.BLOCKER);
    rmSync(testDir2, { recursive: true, force: true });

    // Test exit code 2 (invalid PRD)
    const testDir3 = mkdtempSync(join(tmpdir(), "nax-test-invalid-prd-"));
    await setupGitRepo(testDir3);
    mkdirSync(join(testDir3, "node_modules"));
    config = createConfig(testDir3);
    const invalidPRD: PRD = {
      ...prd,
      userStories: [{ ...prd.userStories[0], id: "", title: "", description: "" }],
    };
    result = await runPrecheck(config, invalidPRD, { workdir: testDir3, format: "json", silent: true });
    expect(result.exitCode).toBe(EXIT_CODES.INVALID_PRD);
    rmSync(testDir3, { recursive: true, force: true });
  });

  test("AC6: Summary line shows total checks/passed/failed/warnings", async () => {
    await setupGitRepo(testDir);
    mkdirSync(join(testDir, "node_modules"));

    const config = createConfig(testDir);
    const prd = createPRD();

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (msg: string) => logs.push(msg);

    try {
      await runPrecheck(config, prd, { workdir: testDir, format: "human" });

      // Should have summary with counts
      const hasSummary = logs.some(
        (l) => l.includes("total") && l.includes("passed") && (l.includes("failed") || l.includes("warnings")),
      );

      expect(hasSummary).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });
});

/**
 * Integration tests for precheck integration with nax run
 *
 * Tests US-004: Integrate precheck into nax run
 * - AC1: Precheck runs automatically before first story
 * - AC2: Tier 1 blocker aborts run with descriptive error
 * - AC3: Tier 2 warnings logged but don't block execution
 * - AC4: --skip-precheck flag bypasses all checks
 * - AC5: Precheck results included in run JSONL log
 * - AC6: Failed precheck updates status.json with precheck-failed status
 */

// Skip in CI: these tests call run() which invokes the full nax execution pipeline
// including spawning real agent subprocesses. CI runners lack the claude binary and
// have restricted process/file system environments. These are end-to-end smoke tests
// that must run in a properly configured dev environment (local, Mac01, or VPS).

// Zero out iterationDelayMs — DEFAULT_CONFIG has 2000ms which adds real waits per iteration
const PRECHECK_TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  execution: { ...DEFAULT_CONFIG.execution, iterationDelayMs: 0 },
};

describe("Precheck Integration with nax run", () => {
  let testDir: string;
  let savedSkipPrecheck: string | undefined;

  beforeEach(async () => {
    // Temporarily remove NAX_SKIP_PRECHECK so precheck actually runs in these tests
    savedSkipPrecheck = process.env.NAX_SKIP_PRECHECK;
    delete process.env.NAX_SKIP_PRECHECK;

    testDir = join(import.meta.dir, "..", "..", "..", ".tmp", `precheck-integration-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Initialize as git repo to pass git checks
    const { spawnSync } = await import("bun");
    spawnSync(["git", "init"], { cwd: testDir });
    spawnSync(["git", "config", "user.name", "Test User"], { cwd: testDir });
    spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: testDir });
  });

  afterEach(() => {
    // Restore NAX_SKIP_PRECHECK to its original value
    if (savedSkipPrecheck !== undefined) {
      process.env.NAX_SKIP_PRECHECK = savedSkipPrecheck;
    } else {
      delete process.env.NAX_SKIP_PRECHECK;
    }

    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  /**
   * Helper to create a basic PRD with one simple story
   */
  function createBasicPRD(feature: string): PRD {
    return {
      feature,
      project: "test-project",
      branchName: `feat/${feature}`,
      userStories: [
        {
          id: "US-001",
          title: "Test Story",
          description: "A test story",
          acceptanceCriteria: ["Story works"],
          status: "pending",
          dependencies: [],
          tags: [],
          estimatedComplexity: "simple",
        },
      ],
    };
  }

  /**
   * Helper to create feature directory and PRD file
   */
  async function setupFeature(feature: string): Promise<string> {
    const naxDir = join(testDir, "nax");
    const featuresDir = join(naxDir, "features");
    const featureDir = join(featuresDir, feature);
    mkdirSync(featureDir, { recursive: true });

    // Create .gitignore to exclude nax runtime files
    await Bun.write(join(testDir, ".gitignore"), "nax.lock\n*.jsonl\nstatus.json\n.nax-wt/\n");

    // Create dummy package.json and node_modules to pass dependency check
    await Bun.write(join(testDir, "package.json"), JSON.stringify({ name: "test", version: "1.0.0" }, null, 2));
    mkdirSync(join(testDir, "node_modules"), { recursive: true });

    const prd = createBasicPRD(feature);
    const prdPath = join(featureDir, "prd.json");
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    // Commit the PRD file and .gitignore to avoid "working tree not clean" errors
    const { spawnSync } = await import("bun");
    spawnSync(["git", "add", "."], { cwd: testDir });
    spawnSync(["git", "commit", "-m", `Setup ${feature} feature`], { cwd: testDir });

    return prdPath;
  }

  /**
   * Helper to read JSONL log and parse precheck entry
   */
  async function readPrecheckLog(logFilePath: string): Promise<any | null> {
    const { existsSync, readFileSync } = await import("node:fs");
    if (!existsSync(logFilePath)) return null;

    const content = readFileSync(logFilePath, "utf8");
    if (!content.trim()) return null;

    const lines = content.trim().split("\n");
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "precheck") return entry;
      } catch {
        // ignore
      }
    }

    console.log(`[DEBUG] precheckLog not found. Content=<<<${content}>>>`);
    return null;
  }

  /**
   * Helper to read status.json
   */
  async function readStatusFile(statusFilePath: string): Promise<any | null> {
    const statusFile = Bun.file(statusFilePath);
    if (!(await statusFile.exists())) {
      return null;
    }

    return await statusFile.json();
  }

  // ────────────────────────────────────────────────────────────────────────────
  // AC4: --skip-precheck flag bypasses all checks
  // ────────────────────────────────────────────────────────────────────────────

  test("AC4: --skip-precheck bypasses precheck validations", async () => {
    // Create non-git temp directory (will fail precheck)
    const nonGitDir = join(import.meta.dir, "..", "..", "..", ".tmp", `non-git-${Date.now()}`);
    mkdirSync(nonGitDir, { recursive: true });

    try {
      const prdPath = await setupFeature("skip-test");
      const logFilePath = join(nonGitDir, "nax", "features", "skip-test", "runs", "test.jsonl");
      const statusFilePath = join(nonGitDir, "nax", "features", "skip-test", "status.json");

      const config: NaxConfig = {
        ...PRECHECK_TEST_CONFIG,
        execution: {
          ...PRECHECK_TEST_CONFIG.execution,
          maxIterations: 1,
        },
      };

      // Run with skipPrecheck: true (should succeed even without git repo)
      const result = await run({
        prdPath,
        workdir: nonGitDir,
        config,
        hooks: { hooks: {} },
        feature: "skip-test",
        dryRun: true, // Use dry-run to avoid actual agent execution
        skipPrecheck: true,
        logFilePath,
        statusFile: statusFilePath,
      });

      // Should complete without error
      expect(result.success).toBe(true);

      // Verify precheck was NOT logged to JSONL
      console.log(`[DEBUG] TEST READING FROM: ${logFilePath}`);
    const precheckLog = await readPrecheckLog(logFilePath);
      expect(precheckLog).toBeNull();
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // AC1: Precheck runs automatically before first story
  // ────────────────────────────────────────────────────────────────────────────

  skipInCI("AC1: precheck runs automatically before first story", async () => {
    const prdPath = await setupFeature("auto-test");
    const logFilePath = join(testDir, "nax", "features", "auto-test", "runs", "test.jsonl");
    const runsDir = join(testDir, "nax", "features", "auto-test", "runs");

    // Pre-create and commit the runs directory to avoid uncommitted changes during test
    mkdirSync(runsDir, { recursive: true });
    const { spawnSync } = await import("bun");
    spawnSync(["git", "add", "."], { cwd: testDir });
    spawnSync(["git", "commit", "-m", "Add runs dir"], { cwd: testDir });

    const config: NaxConfig = {
      ...PRECHECK_TEST_CONFIG,
      execution: {
        ...PRECHECK_TEST_CONFIG.execution,
        maxIterations: 1,
      },
    };

    // Run without skipPrecheck (default behavior)
    await run({
      prdPath,
      workdir: testDir,
      config,
      hooks: { hooks: {} },
      feature: "auto-test",
      dryRun: true,
      logFilePath,
    });

    // Verify precheck was logged to JSONL (AC5)
    console.log(`[DEBUG] TEST READING FROM: ${logFilePath}`);
    const precheckLog = await readPrecheckLog(logFilePath);
    expect(precheckLog).not.toBeNull();
    expect(precheckLog.type).toBe("precheck");
    expect(precheckLog.passed).toBeDefined();
    expect(precheckLog.summary).toBeDefined();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // AC2: Tier 1 blocker aborts run with descriptive error
  // ────────────────────────────────────────────────────────────────────────────

  test("AC2: Tier 1 blocker aborts run with descriptive error", async () => {
    // Create directory with uncommitted changes (will fail working-tree-clean check)
    const dirtyDir = join(import.meta.dir, "..", "..", "..", ".tmp", `dirty-${Date.now()}`);
    mkdirSync(dirtyDir, { recursive: true });

    try {
      // Initialize git and create a dirty state
      const { spawnSync } = await import("bun");
      spawnSync(["git", "init"], { cwd: dirtyDir });
      spawnSync(["git", "config", "user.name", "Test User"], { cwd: dirtyDir });
      spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: dirtyDir });

      // Create a file, add it, then modify it (creating uncommitted changes)
      await Bun.write(join(dirtyDir, "test.txt"), "initial");
      spawnSync(["git", "add", "test.txt"], { cwd: dirtyDir });
      spawnSync(["git", "commit", "-m", "initial"], { cwd: dirtyDir });
      await Bun.write(join(dirtyDir, "test.txt"), "modified");

      // Setup feature
      const naxDir = join(dirtyDir, "nax");
      const featuresDir = join(naxDir, "features");
      const featureDir = join(featuresDir, "blocker-test");
      mkdirSync(featureDir, { recursive: true });

      const prd = createBasicPRD("blocker-test");
      const prdPath = join(featureDir, "prd.json");
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      // Commit the PRD file
      spawnSync(["git", "add", "."], { cwd: dirtyDir });
      spawnSync(["git", "commit", "-m", "Add PRD"], { cwd: dirtyDir });

      // Create a new dirty file AFTER the commit so working tree is actually dirty
      await Bun.write(join(dirtyDir, "dirty.txt"), "uncommitted change");

      const logFilePath = join(featureDir, "runs", "test.jsonl");
      const statusFilePath = join(featureDir, "status.json");

      const config: NaxConfig = {
        ...PRECHECK_TEST_CONFIG,
        execution: {
          ...PRECHECK_TEST_CONFIG.execution,
          maxIterations: 1,
        },
      };

      // Run should throw error due to precheck failure
      try {
        await run({
          prdPath,
          workdir: dirtyDir,
          config,
          hooks: { hooks: {} },
          feature: "blocker-test",
          dryRun: true,
          logFilePath,
          statusFile: statusFilePath,
        });
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        // Verify error message is descriptive
        expect((error as Error).message).toContain("Precheck failed");
        expect((error as Error).message).toContain("working-tree-clean");
      }

      // Verify precheck failure was logged (AC5)
      console.log(`[DEBUG] TEST READING FROM: ${logFilePath}`);
    const precheckLog = await readPrecheckLog(logFilePath);
      expect(precheckLog).not.toBeNull();
      expect(precheckLog.passed).toBe(false);
      expect(precheckLog.blockers.length).toBeGreaterThan(0);

      // Verify status.json shows precheck-failed (AC6)
      const status = await readStatusFile(statusFilePath);
      expect(status).not.toBeNull();
      expect(status.run.status).toBe("precheck-failed");
    } finally {
      rmSync(dirtyDir, { recursive: true, force: true });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // AC3: Tier 2 warnings logged but don't block execution
  // ────────────────────────────────────────────────────────────────────────────

  skipInCI("AC3: Tier 2 warnings don't block execution", async () => {
    // Setup feature (clean git repo should pass all Tier 1 but may have Tier 2 warnings)
    const prdPath = await setupFeature("warning-test");
    const logFilePath = join(testDir, "nax", "features", "warning-test", "runs", "test.jsonl");
    const runsDir = join(testDir, "nax", "features", "warning-test", "runs");

    // Pre-create and commit the runs directory to avoid uncommitted changes during test
    mkdirSync(runsDir, { recursive: true });
    const { spawnSync } = await import("bun");
    spawnSync(["git", "add", "."], { cwd: testDir });
    spawnSync(["git", "commit", "-m", "Add runs dir"], { cwd: testDir });

    const config: NaxConfig = {
      ...PRECHECK_TEST_CONFIG,
      execution: {
        ...PRECHECK_TEST_CONFIG.execution,
        maxIterations: 1,
      },
    };

    // Run should succeed even with warnings
    const result = await run({
      prdPath,
      workdir: testDir,
      config,
      hooks: { hooks: {} },
      feature: "warning-test",
      dryRun: true,
      logFilePath,
    });

    // Should complete successfully
    expect(result.success).toBe(true);

    // Verify precheck passed (may have warnings)
    console.log(`[DEBUG] TEST READING FROM: ${logFilePath}`);
    const precheckLog = await readPrecheckLog(logFilePath);
    expect(precheckLog).not.toBeNull();
    expect(precheckLog.passed).toBe(true);
    // Warnings are OK (don't block execution)
    expect(precheckLog.warnings).toBeDefined();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // AC5: Precheck results included in run JSONL log
  // ────────────────────────────────────────────────────────────────────────────

  skipInCI("AC5: precheck results logged to JSONL", async () => {
    const prdPath = await setupFeature("log-test");
    const logFilePath = join(testDir, "nax", "features", "log-test", "runs", "test.jsonl");
    const runsDir = join(testDir, "nax", "features", "log-test", "runs");

    // Pre-create and commit the runs directory to avoid uncommitted changes during test
    mkdirSync(runsDir, { recursive: true });
    const { spawnSync } = await import("bun");
    spawnSync(["git", "add", "."], { cwd: testDir });
    spawnSync(["git", "commit", "-m", "Add runs dir"], { cwd: testDir });

    const config: NaxConfig = {
      ...PRECHECK_TEST_CONFIG,
      execution: {
        ...PRECHECK_TEST_CONFIG.execution,
        maxIterations: 1,
      },
    };

    await run({
      prdPath,
      workdir: testDir,
      config,
      hooks: { hooks: {} },
      feature: "log-test",
      dryRun: true,
      logFilePath,
    });

    // Verify precheck entry structure
    console.log(`[DEBUG] TEST READING FROM: ${logFilePath}`);
    const precheckLog = await readPrecheckLog(logFilePath);
    expect(precheckLog).not.toBeNull();
    expect(precheckLog.type).toBe("precheck");
    expect(precheckLog.timestamp).toBeDefined();
    expect(precheckLog.passed).toBeDefined();
    expect(precheckLog.blockers).toBeDefined();
    expect(precheckLog.warnings).toBeDefined();
    expect(precheckLog.summary).toBeDefined();
    expect(precheckLog.summary.total).toBeGreaterThan(0);
    expect(precheckLog.summary.passed).toBeGreaterThan(0);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // AC6: Failed precheck updates status.json with precheck-failed status
  // ────────────────────────────────────────────────────────────────────────────

  test("AC6: failed precheck updates status.json", async () => {
    // Create non-git directory (will fail precheck)
    const nonGitDir = join(import.meta.dir, "..", "..", "..", ".tmp", `non-git-status-${Date.now()}`);
    mkdirSync(nonGitDir, { recursive: true });

    try {
      // Setup feature (intentionally no git repo to fail precheck)
      const naxDir = join(nonGitDir, "nax");
      const featuresDir = join(naxDir, "features");
      const featureDir = join(featuresDir, "status-test");
      mkdirSync(featureDir, { recursive: true });

      const prd = createBasicPRD("status-test");
      const prdPath = join(featureDir, "prd.json");
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      // Note: NOT committing to git since this test needs to verify precheck failure

      const statusFilePath = join(featureDir, "status.json");

      const config: NaxConfig = {
        ...PRECHECK_TEST_CONFIG,
        execution: {
          ...PRECHECK_TEST_CONFIG.execution,
          maxIterations: 1,
        },
      };

      // Run should fail due to precheck
      try {
        await run({
          prdPath,
          workdir: nonGitDir,
          config,
          hooks: { hooks: {} },
          feature: "status-test",
          dryRun: true,
          statusFile: statusFilePath,
        });
      } catch (error) {
        // Expected failure
      }

      // Verify status.json exists and has precheck-failed status
      const status = await readStatusFile(statusFilePath);
      expect(status).not.toBeNull();
      expect(status.run).toBeDefined();
      expect(status.run.status).toBe("precheck-failed");
      expect(status.run.feature).toBe("status-test");
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});

import type { AgentAdapter, AgentRunOptions } from "../../../src/agents";
import { ClaudeCodeAdapter, _claudeAdapterDeps } from "../../../src/agents/claude";
import { describeAgentCapabilities, validateAgentFeature, validateAgentForTier } from "../../../src/agents/validation";

describe("Agent Validation and Retry Logic", () => {
  describe("ClaudeCodeAdapter.isInstalled", () => {
    test("returns true when binary exists in PATH", async () => {
      const adapter = new ClaudeCodeAdapter();
      // Mock successful which command
      const originalSpawn = Bun.spawn;
      (Bun as any).spawn = mock((cmd: string[]) => {
        if (cmd[0] === "which" && cmd[1] === "claude") {
          return {
            exited: Promise.resolve(0),
            stdout: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
            stderr: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
          };
        }
        return originalSpawn(cmd);
      });

      const installed = await adapter.isInstalled();
      expect(installed).toBe(true);

      Bun.spawn = originalSpawn;
    });

    test("returns false when binary does not exist", async () => {
      const adapter = new ClaudeCodeAdapter();
      // Mock failed which command
      const originalSpawn = Bun.spawn;
      (Bun as any).spawn = mock((cmd: string[]) => {
        if (cmd[0] === "which" && cmd[1] === "claude") {
          return {
            exited: Promise.resolve(1),
            stdout: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
            stderr: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
          };
        }
        return originalSpawn(cmd);
      });

      const installed = await adapter.isInstalled();
      expect(installed).toBe(false);

      Bun.spawn = originalSpawn;
    });

    test("returns false on exception", async () => {
      const adapter = new ClaudeCodeAdapter();
      const originalSpawn = Bun.spawn;
      (Bun as any).spawn = mock(() => {
        throw new Error("Command not found");
      });

      const installed = await adapter.isInstalled();
      expect(installed).toBe(false);

      Bun.spawn = originalSpawn;
    });
  });

  describe("ClaudeCodeAdapter timeout handling", () => {
    test("distinguishes timeout from normal failure", async () => {
      const adapter = new ClaudeCodeAdapter();
      const originalSpawn = Bun.spawn;

      // Mock process that times out
      (Bun as any).spawn = mock(() => {
        let killed = false;
        return {
          exited: new Promise((resolve) => {
            setTimeout(() => resolve(killed ? 143 : 0), 100);
          }),
          kill: (signal: string) => {
            if (signal === "SIGTERM") killed = true;
          },
          stdout: new Response("").body,
          stderr: new Response("").body,
        };
      });

      const options: AgentRunOptions = {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "balanced",
        modelDef: { provider: "anthropic", model: "claude-sonnet-4.5", env: {} },
        timeoutSeconds: 0.05, // 50ms timeout
      };

      const result = await adapter.run(options);

      // Should be marked as timeout (exit code 124)
      expect(result.exitCode).toBe(124);
      expect(result.success).toBe(false);

      Bun.spawn = originalSpawn;
    });
  });

  describe("ClaudeCodeAdapter retry logic", () => {
    test("retries on rate limit with exponential backoff", async () => {
      const adapter = new ClaudeCodeAdapter();
      const originalSpawn = Bun.spawn;
      const originalSleep = _claudeAdapterDeps.sleep;
      let attemptCount = 0;
      const sleepCalls: number[] = [];

      // Replace sleep with instant no-op spy — avoids real 2s+4s waits
      _claudeAdapterDeps.sleep = async (ms: number) => {
        sleepCalls.push(ms);
      };

      // Mock rate-limited response that succeeds on 3rd try
      (Bun as any).spawn = mock(() => {
        attemptCount++;
        const isRateLimited = attemptCount < 3;

        return {
          exited: Promise.resolve(isRateLimited ? 1 : 0),
          kill: () => {},
          stdout: new Response(isRateLimited ? "" : "success").body,
          stderr: new Response(isRateLimited ? "rate limit exceeded" : "").body,
        };
      });

      const options: AgentRunOptions = {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "balanced",
        modelDef: { provider: "anthropic", model: "claude-sonnet-4.5", env: {} },
        timeoutSeconds: 60,
      };

      const result = await adapter.run(options);

      // Should succeed after retries
      expect(result.success).toBe(true);
      expect(attemptCount).toBe(3);

      // Should have slept with exponential backoff: 2^1*1000=2s, 2^2*1000=4s
      expect(sleepCalls).toEqual([2000, 4000]);

      Bun.spawn = originalSpawn;
      _claudeAdapterDeps.sleep = originalSleep;
    });

    test(
      "fails immediately on agent execution errors (no retry)",
      async () => {
        const adapter = new ClaudeCodeAdapter();
        const originalSpawn = Bun.spawn;
        let attemptCount = 0;

        // Mock agent execution failure (exit code 1)
        // These are not retried because they're likely legitimate agent failures
        (Bun as any).spawn = mock(() => {
          attemptCount++;
          return {
            exited: Promise.resolve(1),
            kill: () => {},
            stdout: new Response("").body,
            stderr: new Response("agent error").body,
          };
        });

        const options: AgentRunOptions = {
          prompt: "test",
          workdir: "/tmp",
          modelTier: "balanced",
          modelDef: { provider: "anthropic", model: "claude-sonnet-4.5", env: {} },
          timeoutSeconds: 60,
        };

        const result = await adapter.run(options);

        // Should fail after 1 attempt (no retry for agent errors)
        expect(result.success).toBe(false);
        expect(attemptCount).toBe(1);

        Bun.spawn = originalSpawn;
      },
      { timeout: 15000 },
    );

    test("succeeds immediately on first attempt if no error", async () => {
      const adapter = new ClaudeCodeAdapter();
      const originalSpawn = Bun.spawn;
      let attemptCount = 0;

      // Mock successful execution
      (Bun as any).spawn = mock(() => {
        attemptCount++;
        return {
          exited: Promise.resolve(0),
          kill: () => {},
          stdout: new Response("success").body,
          stderr: new Response("").body,
        };
      });

      const options: AgentRunOptions = {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "balanced",
        modelDef: { provider: "anthropic", model: "claude-sonnet-4.5", env: {} },
        timeoutSeconds: 60,
      };

      const result = await adapter.run(options);

      // Should succeed on first try
      expect(result.success).toBe(true);
      expect(attemptCount).toBe(1);

      Bun.spawn = originalSpawn;
    });

    test("does not retry on timeout (exit code 124)", async () => {
      const adapter = new ClaudeCodeAdapter();
      const originalSpawn = Bun.spawn;
      let attemptCount = 0;

      // Mock timeout
      (Bun as any).spawn = mock(() => {
        attemptCount++;
        let killed = false;
        return {
          exited: new Promise((resolve) => {
            setTimeout(() => resolve(killed ? 143 : 0), 100);
          }),
          kill: (signal: string) => {
            if (signal === "SIGTERM") killed = true;
          },
          stdout: new Response("").body,
          stderr: new Response("").body,
        };
      });

      const options: AgentRunOptions = {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "balanced",
        modelDef: { provider: "anthropic", model: "claude-sonnet-4.5", env: {} },
        timeoutSeconds: 0.05, // 50ms timeout
      };

      const result = await adapter.run(options);

      // Should not retry on timeout
      expect(result.exitCode).toBe(124);
      expect(attemptCount).toBe(1);

      Bun.spawn = originalSpawn;
    });
  });

  describe("ClaudeCodeAdapter command building", () => {
    test("builds correct command with model and prompt", () => {
      const adapter = new ClaudeCodeAdapter();
      const options: AgentRunOptions = {
        prompt: "test prompt",
        workdir: "/tmp",
        modelTier: "balanced",
        modelDef: { provider: "anthropic", model: "claude-sonnet-4.5", env: {} },
        timeoutSeconds: 60,
      };

      const cmd = adapter.buildCommand(options);

      expect(cmd).toEqual([
        "claude",
        "--model",
        "claude-sonnet-4.5",
        "--dangerously-skip-permissions",
        "-p",
        "test prompt",
      ]);
    });
  });

  describe("Agent Capability Metadata", () => {
    const claudeAdapter = new ClaudeCodeAdapter();

    describe("ClaudeCodeAdapter capabilities", () => {
      test("declares all expected tiers", () => {
        const caps = claudeAdapter.capabilities;
        expect(caps.supportedTiers).toContain("fast");
        expect(caps.supportedTiers).toContain("balanced");
        expect(caps.supportedTiers).toContain("powerful");
        expect(caps.supportedTiers.length).toBe(3);
      });

      test("declares all expected features", () => {
        const caps = claudeAdapter.capabilities;
        expect(caps.features.has("tdd")).toBe(true);
        expect(caps.features.has("review")).toBe(true);
        expect(caps.features.has("refactor")).toBe(true);
        expect(caps.features.has("batch")).toBe(true);
        expect(caps.features.size).toBe(4);
      });

      test("declares 200k token context window", () => {
        expect(claudeAdapter.capabilities.maxContextTokens).toBe(200_000);
      });
    });

    describe("validateAgentForTier", () => {
      test("returns true for supported tiers", () => {
        expect(validateAgentForTier(claudeAdapter, "fast")).toBe(true);
        expect(validateAgentForTier(claudeAdapter, "balanced")).toBe(true);
        expect(validateAgentForTier(claudeAdapter, "powerful")).toBe(true);
      });

      test("returns false for unsupported tiers (custom agent)", () => {
        // Create a mock agent that only supports fast tier
        const limitedAgent: AgentAdapter = {
          name: "limited",
          displayName: "Limited Agent",
          binary: "limited",
          capabilities: {
            supportedTiers: ["fast"],
            maxContextTokens: 50_000,
            features: new Set(["review"]),
          },
          async isInstalled() {
            return true;
          },
          async run() {
            return {
              success: true,
              exitCode: 0,
              output: "",
              rateLimited: false,
              durationMs: 1000,
              estimatedCost: 0.01,
            };
          },
          buildCommand() {
            return ["limited"];
          },
        };

        expect(validateAgentForTier(limitedAgent, "fast")).toBe(true);
        expect(validateAgentForTier(limitedAgent, "balanced")).toBe(false);
        expect(validateAgentForTier(limitedAgent, "powerful")).toBe(false);
      });
    });

    describe("validateAgentFeature", () => {
      test("returns true for supported features", () => {
        expect(validateAgentFeature(claudeAdapter, "tdd")).toBe(true);
        expect(validateAgentFeature(claudeAdapter, "review")).toBe(true);
        expect(validateAgentFeature(claudeAdapter, "refactor")).toBe(true);
        expect(validateAgentFeature(claudeAdapter, "batch")).toBe(true);
      });

      test("returns false for unsupported features (custom agent)", () => {
        const reviewOnlyAgent: AgentAdapter = {
          name: "reviewer",
          displayName: "Review Agent",
          binary: "reviewer",
          capabilities: {
            supportedTiers: ["fast", "balanced"],
            maxContextTokens: 100_000,
            features: new Set(["review"]),
          },
          async isInstalled() {
            return true;
          },
          async run() {
            return {
              success: true,
              exitCode: 0,
              output: "",
              rateLimited: false,
              durationMs: 1000,
              estimatedCost: 0.01,
            };
          },
          buildCommand() {
            return ["reviewer"];
          },
        };

        expect(validateAgentFeature(reviewOnlyAgent, "review")).toBe(true);
        expect(validateAgentFeature(reviewOnlyAgent, "tdd")).toBe(false);
        expect(validateAgentFeature(reviewOnlyAgent, "refactor")).toBe(false);
        expect(validateAgentFeature(reviewOnlyAgent, "batch")).toBe(false);
      });
    });

    describe("describeAgentCapabilities", () => {
      test("formats Claude Code capabilities correctly", () => {
        const description = describeAgentCapabilities(claudeAdapter);
        expect(description).toContain("claude:");
        expect(description).toContain("tiers=[fast,balanced,powerful]");
        expect(description).toContain("maxTokens=200000");
        expect(description).toContain("features=");
        expect(description).toContain("tdd");
        expect(description).toContain("review");
        expect(description).toContain("refactor");
        expect(description).toContain("batch");
      });

      test("formats limited agent capabilities correctly", () => {
        const limitedAgent: AgentAdapter = {
          name: "tiny",
          displayName: "Tiny Agent",
          binary: "tiny",
          capabilities: {
            supportedTiers: ["fast"],
            maxContextTokens: 10_000,
            features: new Set(["review"]),
          },
          async isInstalled() {
            return true;
          },
          async run() {
            return {
              success: true,
              exitCode: 0,
              output: "",
              rateLimited: false,
              durationMs: 1000,
              estimatedCost: 0.01,
            };
          },
          buildCommand() {
            return ["tiny"];
          },
        };

        const description = describeAgentCapabilities(limitedAgent);
        expect(description).toBe("tiny: tiers=[fast], maxTokens=10000, features=[review]");
      });
    });
  });
});

