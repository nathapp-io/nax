// RE-ARCH: keep
/**
 * Integration tests for precheck individual check behaviors:
 * stale lock detection, .gitignore validation, orchestrator behavior (US-002 AC tests)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NaxConfig } from "../../../src/config";
import type { PRD, UserStory } from "../../../src/prd/types";
import { EXIT_CODES, runPrecheck } from "../../../src/precheck";
import { fullDescribe, fullTest } from "../../helpers/env";
import { makeTempDir } from "../../helpers/temp";

// Requires real claude binary — skipped by default, run with FULL=1.
const describeWithClaude = fullDescribe;
const skipInCI = fullTest;

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

describeWithClaude("precheck with stale lock detection", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-precheck-");
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
    const lockPath = join(testDir, "nax.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 12345, startedAt: new Date().toISOString() }));
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add fresh lock"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result, output } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    expect(result.blockers.length).toBe(0);
    expect(output.passed).toBe(true);
  });
});

describeWithClaude("precheck with .gitignore validation", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-precheck-");
    mkdirSync(join(testDir, ".git"));
    mkdirSync(join(testDir, "node_modules"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("passes when .gitignore covers all nax runtime files", async () => {
    await setupValidGitEnv(testDir);
    writeFileSync(
      join(testDir, ".gitignore"),
      `
node_modules/
nax.lock
nax/features/*/runs/
test/tmp/
`.trim(),
    );
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add gitignore"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result, output } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    expect(result.blockers.length).toBe(0);
    const gitignoreCheck = result.warnings.find((c) => c.name === "gitignore-covers-nax");
    expect(gitignoreCheck).toBeUndefined();
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
    testDir = makeTempDir("nax-test-precheck-orch-");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("stops on first Tier 1 blocker (fail-fast)", async () => {
    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    expect(result.blockers.length).toBe(1);
    expect(result.blockers[0].name).toBe("git-repo-exists");
    expect(result.blockers[0].passed).toBe(false);
    expect(result.warnings.length).toBe(0);
  });

  test("runs all Tier 2 checks even if some warn", async () => {
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add node_modules"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    expect(result.blockers.length).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);

    const hasClaudeMd = result.warnings.some((c) => c.name === "claude-md-exists");
    const hasGitignore = result.warnings.some((c) => c.name === "gitignore-covers-nax");
    expect(hasClaudeMd || hasGitignore).toBe(true);
  });

  test("JSON output matches spec schema", async () => {
    mkdirSync(join(testDir, ".git"));
    mkdirSync(join(testDir, "node_modules"));

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const originalLog = console.log;
    let jsonOutput = "";
    console.log = (msg: string) => {
      jsonOutput += msg;
    };

    try {
      await runPrecheck(config, prd, { workdir: testDir, format: "json" });

      const output = JSON.parse(jsonOutput);

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
    mkdirSync(join(testDir, ".git"));
    mkdirSync(join(testDir, "node_modules"));

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const originalLog = console.log;
    const outputs: string[] = [];
    console.log = (msg: string) => {
      outputs.push(msg);
    };

    try {
      await runPrecheck(config, prd, { workdir: testDir, format: "human" });

      const hasCheckmark = outputs.some((line) => line.includes("✓"));
      const hasCross = outputs.some((line) => line.includes("✗"));
      const hasWarning = outputs.some((line) => line.includes("⚠"));

      expect(hasCheckmark || hasCross || hasWarning).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  test("summary line shows total checks/passed/failed/warnings", async () => {
    mkdirSync(join(testDir, ".git"));
    mkdirSync(join(testDir, "node_modules"));

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const originalLog = console.log;
    const outputs: string[] = [];
    console.log = (msg: string) => {
      outputs.push(msg);
    };

    try {
      await runPrecheck(config, prd, { workdir: testDir, format: "human" });

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
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));
    writeFileSync(join(testDir, "CLAUDE.md"), "# Project");
    writeFileSync(join(testDir, ".gitignore"), "nax.lock\nruns/\ntest/tmp/");
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add files"], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { exitCode } = await runPrecheck(config, prd, { workdir: testDir, format: "human" });

    expect(exitCode).toBe(0);
  });

  test("exit code 1 for blocker", async () => {
    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { exitCode } = await runPrecheck(config, prd, { workdir: testDir, format: "human" });

    expect(exitCode).toBe(1);
  });

  test("exit code 2 for invalid PRD", async () => {
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));

    const config = createMockConfig(testDir);
    const prd = createMockPRD([
      createMockStory({ id: "", title: "", description: "" }),
    ]);

    const { exitCode } = await runPrecheck(config, prd, { workdir: testDir, format: "human" });

    expect(exitCode).toBe(2);
  });

  test("collects all Tier 2 warnings even if some fail", async () => {
    await setupValidGitEnv(testDir);
    mkdirSync(join(testDir, "node_modules"));
    await Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "commit", "-m", "Add node_modules"], { cwd: testDir, stdout: "ignore", stderr: "ignore" })
      .exited;

    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    expect(result.blockers.length).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(1);

    const claudeMdCheck = result.warnings.find((c) => c.name === "claude-md-exists");
    const gitignoreCheck = result.warnings.find((c) => c.name === "gitignore-covers-nax");

    expect(claudeMdCheck).toBeDefined();
    expect(gitignoreCheck).toBeDefined();
  });

  test("does not run Tier 2 checks if Tier 1 blocker fails", async () => {
    const config = createMockConfig(testDir);
    const prd = createMockPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

    expect(result.blockers.length).toBe(1);
    expect(result.warnings.length).toBe(0);
  });
});
