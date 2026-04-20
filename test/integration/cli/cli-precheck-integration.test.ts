// RE-ARCH: keep
/**
 * Integration tests for precheck functionality
 *
 * Tests the complete precheck workflow including all Tier 1 blockers and Tier 2 warnings.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NaxConfig } from "../../../src/config";
import type { PRD, UserStory } from "../../../src/prd/types";
import { runPrecheck } from "../../../src/precheck";
import { fullDescribe } from "../../helpers/env";
import { makeTempDir } from "../../helpers/temp";

// Requires real claude binary — skipped by default, run with FULL=1.
const describeWithClaude = fullDescribe;

async function setupValidGitEnv(testDir: string): Promise<void> {
  await Bun.spawn(["git", "init"], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
  await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
  await Bun.spawn(["git", "config", "user.email", "test@test.com"], {
    cwd: testDir,
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
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

describeWithClaude("runPrecheck integration", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-precheck-");
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
    mkdirSync(join(testDir, ".git"));
    mkdirSync(join(testDir, "node_modules"));

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    for (const check of result.blockers) {
      expect(check.tier).toBe("blocker");
    }

    for (const check of result.warnings) {
      expect(check.tier).toBe("warning");
    }
  });

  test("includes git repo check in blockers", async () => {
    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    expect(result.blockers.length).toBe(1);
    expect(result.blockers[0].name).toBe("git-repo-exists");
  });

  test("includes working tree check in blockers", async () => {
    mkdirSync(join(testDir, ".git"));

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    const workingTreeCheck = result.blockers.find((c) => c.name === "working-tree-clean");
    expect(workingTreeCheck).toBeDefined();
  });

  test("stale lock check runs after git checks in sequence", async () => {
    await setupValidGitEnv(testDir);
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    writeFileSync(join(testDir, "nax.lock"), JSON.stringify({ pid: 12345, startedAt: threeHoursAgo.toISOString() }));
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add stale lock"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    const staleLockCheck = result.blockers.find((c) => c.name === "no-stale-lock");
    expect(staleLockCheck).toBeDefined();
    expect(staleLockCheck?.passed).toBe(false);
  });

  test("runs PRD validation check after git checks", async () => {
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));

    const config = createMockConfig(testDir);
    const prd = createMockPRD([createMockStory({ id: "", title: "", description: "" })]);

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    const prdValidCheck = result.blockers.find((c) => c.name === "prd-valid");
    expect(prdValidCheck).toBeDefined();
    expect(prdValidCheck?.passed).toBe(false);
  });

  test("Tier 2 warnings only run if all Tier 1 checks pass", async () => {
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));
    writeFileSync(join(testDir, ".gitignore"), "nax.lock\nruns/\ntest/tmp/");
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add gitignore"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    expect(result.blockers.length).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);

    const hasClaudeMd = result.warnings.some((w) => w.name === "claude-md-exists");
    expect(hasClaudeMd).toBe(true);
  });

  test("auto-defaults missing PRD fields in-memory during validation", async () => {
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add node_modules"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const storyWithMissingFields = {
      id: "US-001",
      title: "Test",
      description: "Description",
      passes: false,
    } as any;

    const config = createMockConfig(testDir);
    const prd = createMockPRD([storyWithMissingFields]);

    const { result, output } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    expect(result.blockers.length).toBe(0);
    expect(output.passed).toBe(true);
    expect(prd.userStories[0].tags).toEqual([]);
    expect(prd.userStories[0].status).toBe("pending");
    expect(prd.userStories[0].acceptanceCriteria).toEqual([]);
  });

  test("all blocker checks must pass for a clean environment", async () => {
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));
    writeFileSync(join(testDir, ".gitignore"), "node_modules/\nnax.lock\nnax/features/*/runs/\ntest/tmp/");
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add files"], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD([createMockStory({ id: "US-001", title: "Story 1", description: "Desc 1" })]);

    const { result, output } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    expect(result.blockers.length).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(output.passed).toBe(true);

    for (const warning of result.warnings) {
      expect(typeof warning.passed).toBe("boolean");
    }
  });

  test("handles PRD with multiple stories", async () => {
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));
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

    expect(result.blockers.length).toBe(0);
    expect(output.passed).toBe(true);
  });

  test("detects invalid PRD with missing required fields", async () => {
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));
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

    expect(result.blockers.length).toBe(0);
    expect(output.passed).toBe(true);
    expect(output.summary.failed).toBe(0);
  });

  test("fail-fast stops on first blocker, no warnings collected", async () => {
    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

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

    for (const check of [...result.blockers, ...result.warnings]) {
      expect(check.message).toBeDefined();
      expect(check.message.length).toBeGreaterThan(0);
    }
  });
});
