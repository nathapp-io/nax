/**
 * US-002: Precheck orchestrator with formatted output
 *
 * Acceptance criteria verification tests
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Skip in CI: AC2, AC5, AC6 call runPrecheck() which includes checkClaudeCLI as a
// Tier 1 blocker. Without the claude binary installed, blockers.length > 0 always,
// breaking assertions like expect(blockers.length).toBe(0). These ACs test correct
// orchestration behaviour and pass reliably on Mac01/VPS where claude is installed.
const skipInCI = process.env.CI ? test.skip : test;
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NaxConfig } from "../src/config";
import type { PRD } from "../src/prd/types";
import { EXIT_CODES, runPrecheck } from "../src/precheck";

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
      iterationDelayMs: 1000,
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

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

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

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json" });

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
    let result = await runPrecheck(config, prd, { workdir: testDir, format: "json" });
    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);

    // Test exit code 1 (blocker)
    const testDir2 = mkdtempSync(join(tmpdir(), "nax-test-blocker-"));
    config = createConfig(testDir2);
    result = await runPrecheck(config, prd, { workdir: testDir2, format: "json" });
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
    result = await runPrecheck(config, invalidPRD, { workdir: testDir3, format: "json" });
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
