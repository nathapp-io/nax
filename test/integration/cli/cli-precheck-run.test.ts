// RE-ARCH: keep
/**
 * Integration tests for precheck: US-002 acceptance criteria and nax run integration
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config";
import { run } from "../../../src/execution";
import type { PRD } from "../../../src/prd/types";
import { EXIT_CODES, runPrecheck } from "../../../src/precheck";
import { fullTest } from "../../helpers/env";
import { makeTempDir } from "../../helpers/temp";

// Requires real claude binary — skipped by default, run with FULL=1.
const skipInCI = fullTest;

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
    testDir = makeTempDir("nax-test-us002-");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("AC1: Runs Tier 1 checks first, stops on first failure", async () => {
    const config = createConfig(testDir);
    const prd = createPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json", silent: true });

    expect(result.blockers.length).toBe(1);
    expect(result.blockers[0].name).toBe("git-repo-exists");
  });

  skipInCI("AC2: Runs all Tier 2 checks even if some warn", async () => {
    await setupGitRepo(testDir);
    mkdirSync(join(testDir, "node_modules"));

    const config = createConfig(testDir);
    const prd = createPRD();

    const { result } = await runPrecheck(config, prd, { workdir: testDir, format: "json", silent: true });

    expect(result.blockers.length).toBe(0);
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });

  test("AC3: Human output shows emoji per check result", async () => {
    await setupGitRepo(testDir);
    mkdirSync(join(testDir, "node_modules"));

    const config = createConfig(testDir);
    const prd = createPRD();

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (msg: string) => logs.push(msg);

    try {
      await runPrecheck(config, prd, { workdir: testDir, format: "human" });

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

    const testDir2 = makeTempDir("nax-test-blocker-");
    config = createConfig(testDir2);
    result = await runPrecheck(config, prd, { workdir: testDir2, format: "json", silent: true });
    expect(result.exitCode).toBe(EXIT_CODES.BLOCKER);
    rmSync(testDir2, { recursive: true, force: true });

    const testDir3 = makeTempDir("nax-test-invalid-prd-");
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

      const hasSummary = logs.some(
        (l) => l.includes("total") && l.includes("passed") && (l.includes("failed") || l.includes("warnings")),
      );

      expect(hasSummary).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });
});

// Zero out iterationDelayMs — DEFAULT_CONFIG has 2000ms which adds real waits per iteration
const PRECHECK_TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  execution: { ...DEFAULT_CONFIG.execution, iterationDelayMs: 0 },
};

describe("Precheck Integration with nax run", () => {
  let testDir: string;
  let savedNaxPrecheck: string | undefined;

  beforeEach(async () => {
    savedNaxPrecheck = process.env.NAX_PRECHECK;
    process.env.NAX_PRECHECK = "1";

    testDir = makeTempDir("nax-precheck-integration-");

    const { spawnSync } = await import("bun");
    spawnSync(["git", "init"], { cwd: testDir });
    spawnSync(["git", "config", "user.name", "Test User"], { cwd: testDir });
    spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: testDir });
  });

  afterEach(() => {
    if (savedNaxPrecheck !== undefined) {
      process.env.NAX_PRECHECK = savedNaxPrecheck;
    } else {
      process.env.NAX_PRECHECK = undefined;
    }

    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

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

  async function setupFeature(feature: string): Promise<string> {
    const naxDir = join(testDir, ".nax");
    const featuresDir = join(naxDir, "features");
    const featureDir = join(featuresDir, feature);
    mkdirSync(featureDir, { recursive: true });

    await Bun.write(join(testDir, ".gitignore"), "nax.lock\n*.jsonl\nstatus.json\n.nax-wt/\n");
    await Bun.write(join(testDir, "package.json"), JSON.stringify({ name: "test", version: "1.0.0" }, null, 2));
    mkdirSync(join(testDir, "node_modules"), { recursive: true });

    const prd = createBasicPRD(feature);
    const prdPath = join(featureDir, "prd.json");
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    const { spawnSync } = await import("bun");
    spawnSync(["git", "add", "."], { cwd: testDir });
    spawnSync(["git", "commit", "-m", `Setup ${feature} feature`], { cwd: testDir });

    return prdPath;
  }

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

    return null;
  }

  async function readStatusFile(statusFilePath: string): Promise<any | null> {
    const statusFile = Bun.file(statusFilePath);
    if (!(await statusFile.exists())) {
      return null;
    }

    return await statusFile.json();
  }

  test("AC4: --skip-precheck bypasses precheck validations", async () => {
    const nonGitDir = makeTempDir("nax-precheck-non-git-");

    try {
      const prdPath = await setupFeature("skip-test");
      const logFilePath = join(nonGitDir, ".nax", "features", "skip-test", "runs", "test.jsonl");
      const statusFilePath = join(nonGitDir, ".nax", "features", "skip-test", "status.json");

      const config: NaxConfig = {
        ...PRECHECK_TEST_CONFIG,
        execution: {
          ...PRECHECK_TEST_CONFIG.execution,
          maxIterations: 1,
        },
      };

      const result = await run({
        prdPath,
        workdir: nonGitDir,
        config,
        hooks: { hooks: {} },
        feature: "skip-test",
        dryRun: true,
        skipPrecheck: true,
        logFilePath,
        statusFile: statusFilePath,
      });

      expect(result.success).toBe(true);

      const precheckLog = await readPrecheckLog(logFilePath);
      expect(precheckLog).toBeNull();
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  skipInCI("AC1: precheck runs automatically before first story", async () => {
    const prdPath = await setupFeature("auto-test");
    const logFilePath = join(testDir, ".nax", "features", "auto-test", "runs", "test.jsonl");
    const runsDir = join(testDir, ".nax", "features", "auto-test", "runs");

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
      feature: "auto-test",
      dryRun: true,
      logFilePath,
    });

    const precheckLog = await readPrecheckLog(logFilePath);
    expect(precheckLog).not.toBeNull();
    expect(precheckLog.type).toBe("precheck");
    expect(precheckLog.passed).toBeDefined();
    expect(precheckLog.summary).toBeDefined();
  });

  test("AC2: Tier 1 blocker aborts run with descriptive error", async () => {
    const dirtyDir = makeTempDir("nax-precheck-dirty-");

    try {
      const { spawnSync } = await import("bun");
      spawnSync(["git", "init"], { cwd: dirtyDir });
      spawnSync(["git", "config", "user.name", "Test User"], { cwd: dirtyDir });
      spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: dirtyDir });

      await Bun.write(join(dirtyDir, "test.txt"), "initial");
      spawnSync(["git", "add", "test.txt"], { cwd: dirtyDir });
      spawnSync(["git", "commit", "-m", "initial"], { cwd: dirtyDir });
      await Bun.write(join(dirtyDir, "test.txt"), "modified");

      const naxDir = join(dirtyDir, ".nax");
      const featuresDir = join(naxDir, "features");
      const featureDir = join(featuresDir, "blocker-test");
      mkdirSync(featureDir, { recursive: true });

      const prd = {
        feature: "blocker-test",
        project: "test-project",
        branchName: "feat/blocker-test",
        userStories: [
          {
            id: "US-001",
            title: "Test Story",
            description: "A test story",
            acceptanceCriteria: ["Story works"],
            status: "pending",
            dependencies: [],
            tags: [],
          },
        ],
      };
      const prdPath = join(featureDir, "prd.json");
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      spawnSync(["git", "add", "."], { cwd: dirtyDir });
      spawnSync(["git", "commit", "-m", "Add PRD"], { cwd: dirtyDir });

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
        expect((error as Error).message).toContain("Precheck failed");
        expect((error as Error).message).toContain("working-tree-clean");
      }

      const precheckLog = await readPrecheckLog(logFilePath);
      expect(precheckLog).not.toBeNull();
      expect(precheckLog.passed).toBe(false);
      expect(precheckLog.blockers.length).toBeGreaterThan(0);

      const status = await readStatusFile(statusFilePath);
      expect(status).not.toBeNull();
      expect(status.run.status).toBe("precheck-failed");
    } finally {
      rmSync(dirtyDir, { recursive: true, force: true });
    }
  });

  skipInCI("AC3: Tier 2 warnings don't block execution", async () => {
    const prdPath = await setupFeature("warning-test");
    const logFilePath = join(testDir, ".nax", "features", "warning-test", "runs", "test.jsonl");
    const runsDir = join(testDir, ".nax", "features", "warning-test", "runs");

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

    const result = await run({
      prdPath,
      workdir: testDir,
      config,
      hooks: { hooks: {} },
      feature: "warning-test",
      dryRun: true,
      logFilePath,
    });

    expect(result.success).toBe(true);

    const precheckLog = await readPrecheckLog(logFilePath);
    expect(precheckLog).not.toBeNull();
    expect(precheckLog.passed).toBe(true);
    expect(precheckLog.warnings).toBeDefined();
  });

  skipInCI("AC5: precheck results logged to JSONL", async () => {
    const prdPath = await setupFeature("log-test");
    const logFilePath = join(testDir, ".nax", "features", "log-test", "runs", "test.jsonl");
    const runsDir = join(testDir, ".nax", "features", "log-test", "runs");

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

  test("AC6: failed precheck updates status.json", async () => {
    const nonGitDir = makeTempDir("nax-precheck-non-git-status-");

    try {
      const naxDir = join(nonGitDir, ".nax");
      const featuresDir = join(naxDir, "features");
      const featureDir = join(featuresDir, "status-test");
      mkdirSync(featureDir, { recursive: true });

      const prd = {
        feature: "status-test",
        project: "test-project",
        branchName: "feat/status-test",
        userStories: [
          {
            id: "US-001",
            title: "Test Story",
            description: "A test story",
            acceptanceCriteria: ["Story works"],
            status: "pending",
            dependencies: [],
            tags: [],
          },
        ],
      };
      const prdPath = join(featureDir, "prd.json");
      await Bun.write(prdPath, JSON.stringify(prd, null, 2));

      const statusFilePath = join(featureDir, "status.json");

      const config: NaxConfig = {
        ...PRECHECK_TEST_CONFIG,
        execution: {
          ...PRECHECK_TEST_CONFIG.execution,
          maxIterations: 1,
        },
      };

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

      const statusFile = Bun.file(statusFilePath);
      const status = (await statusFile.exists()) ? await statusFile.json() : null;
      expect(status).not.toBeNull();
      expect(status.run).toBeDefined();
      expect(status.run.status).toBe("precheck-failed");
      expect(status.run.feature).toBe("status-test");
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});
