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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { NaxConfig } from "../../src/config";
import { DEFAULT_CONFIG } from "../../src/config";
import { run } from "../../src/execution";
import type { PRD } from "../../src/prd";
import { loadPRD } from "../../src/prd";

describe("Precheck Integration with nax run", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(import.meta.dir, "..", "..", ".tmp", `precheck-integration-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Initialize as git repo to pass git checks
    const { spawnSync } = await import("bun");
    spawnSync(["git", "init"], { cwd: testDir });
    spawnSync(["git", "config", "user.name", "Test User"], { cwd: testDir });
    spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: testDir });
  });

  afterEach(() => {
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
    const logFile = Bun.file(logFilePath);
    if (!(await logFile.exists())) {
      return null;
    }

    const content = await logFile.text();
    const lines = content.trim().split("\n");

    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.type === "precheck") {
        return entry;
      }
    }

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
    const nonGitDir = join(import.meta.dir, "..", "..", ".tmp", `non-git-${Date.now()}`);
    mkdirSync(nonGitDir, { recursive: true });

    try {
      const prdPath = await setupFeature("skip-test");
      const logFilePath = join(nonGitDir, "nax", "features", "skip-test", "runs", "test.jsonl");
      const statusFilePath = join(nonGitDir, "nax", "features", "skip-test", "status.json");

      const config: NaxConfig = {
        ...DEFAULT_CONFIG,
        execution: {
          ...DEFAULT_CONFIG.execution,
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
      const precheckLog = await readPrecheckLog(logFilePath);
      expect(precheckLog).toBeNull();
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // AC1: Precheck runs automatically before first story
  // ────────────────────────────────────────────────────────────────────────────

  test("AC1: precheck runs automatically before first story", async () => {
    const prdPath = await setupFeature("auto-test");
    const logFilePath = join(testDir, "nax", "features", "auto-test", "runs", "test.jsonl");
    const runsDir = join(testDir, "nax", "features", "auto-test", "runs");

    // Pre-create and commit the runs directory to avoid uncommitted changes during test
    mkdirSync(runsDir, { recursive: true });
    const { spawnSync } = await import("bun");
    spawnSync(["git", "add", "."], { cwd: testDir });
    spawnSync(["git", "commit", "-m", "Add runs dir"], { cwd: testDir });

    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
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
    const dirtyDir = join(import.meta.dir, "..", "..", ".tmp", `dirty-${Date.now()}`);
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

      // Commit the PRD file so the only uncommitted change is test.txt
      spawnSync(["git", "add", "."], { cwd: dirtyDir });
      spawnSync(["git", "commit", "-m", "Add PRD"], { cwd: dirtyDir });

      const logFilePath = join(featureDir, "runs", "test.jsonl");
      const statusFilePath = join(featureDir, "status.json");

      const config: NaxConfig = {
        ...DEFAULT_CONFIG,
        execution: {
          ...DEFAULT_CONFIG.execution,
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

  test("AC3: Tier 2 warnings don't block execution", async () => {
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
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
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
    const precheckLog = await readPrecheckLog(logFilePath);
    expect(precheckLog).not.toBeNull();
    expect(precheckLog.passed).toBe(true);
    // Warnings are OK (don't block execution)
    expect(precheckLog.warnings).toBeDefined();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // AC5: Precheck results included in run JSONL log
  // ────────────────────────────────────────────────────────────────────────────

  test("AC5: precheck results logged to JSONL", async () => {
    const prdPath = await setupFeature("log-test");
    const logFilePath = join(testDir, "nax", "features", "log-test", "runs", "test.jsonl");
    const runsDir = join(testDir, "nax", "features", "log-test", "runs");

    // Pre-create and commit the runs directory to avoid uncommitted changes during test
    mkdirSync(runsDir, { recursive: true });
    const { spawnSync } = await import("bun");
    spawnSync(["git", "add", "."], { cwd: testDir });
    spawnSync(["git", "commit", "-m", "Add runs dir"], { cwd: testDir });

    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
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
    const nonGitDir = join(import.meta.dir, "..", "..", ".tmp", `non-git-status-${Date.now()}`);
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
        ...DEFAULT_CONFIG,
        execution: {
          ...DEFAULT_CONFIG.execution,
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
