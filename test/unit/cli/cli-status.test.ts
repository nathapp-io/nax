// RE-ARCH: keep
/**
 * Tests for src/cli/status.ts - Feature status display with active run detection
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _statusFeaturesDeps, displayFeatureStatus } from "../../../src/cli/status-features";
import type { NaxStatusFile } from "../../../src/execution/status-file";
import type { PRD } from "../../../src/prd";
// Requires real PID checks — skipped by default, run with FULL=1.
import { fullTest as skipInCI } from "../../helpers/env";
import { makeTempDir } from "../../helpers/temp";

describe("displayFeatureStatus", () => {
  let testDir: string;
  let originalCwd: string;
  let origProjectOutputDir: typeof _statusFeaturesDeps.projectOutputDir;
  let consoleOutput: string[];
  const originalLog = console.log;

  beforeEach(() => {
    // Create temp directory for test (resolve symlinks for consistent paths)
    const rawTestDir = makeTempDir("nax-test-");
    testDir = realpathSync(rawTestDir);
    originalCwd = process.cwd();

    // Redirect output dir derivation to testDir/.nax so test fixtures are found
    origProjectOutputDir = _statusFeaturesDeps.projectOutputDir;
    _statusFeaturesDeps.projectOutputDir = () => join(testDir, ".nax");

    // Mock console.log to capture output
    consoleOutput = [];
    console.log = mock((message: string) => {
      consoleOutput.push(message);
    });
  });

  afterEach(() => {
    _statusFeaturesDeps.projectOutputDir = origProjectOutputDir;
    // Restore original CWD and console.log
    process.chdir(originalCwd);
    console.log = originalLog;

    // Clean up test directory
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  /**
   * Helper: Create a minimal PRD for testing
   */
  function createTestPRD(featureName: string, overrides: Partial<PRD> = {}): PRD {
    return {
      project: "test-project",
      feature: featureName,
      branchName: `feat/${featureName}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      userStories: [
        {
          id: "US-001",
          title: "First story",
          description: "Test story 1",
          acceptanceCriteria: ["AC-1"],
          tags: [],
          dependencies: [],
          status: "passed",
          passes: true,
          escalations: [],
          attempts: 1,
        },
        {
          id: "US-002",
          title: "Second story",
          description: "Test story 2",
          acceptanceCriteria: ["AC-2"],
          tags: [],
          dependencies: [],
          status: "failed",
          passes: false,
          escalations: [],
          attempts: 2,
        },
        {
          id: "US-003",
          title: "Third story",
          description: "Test story 3",
          acceptanceCriteria: ["AC-3"],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
      ],
      ...overrides,
    };
  }

  /**
   * Helper: Create a status.json file for testing
   */
  function createStatusFile(featureDir: string, overrides: Partial<NaxStatusFile> = {}): void {
    const status: NaxStatusFile = {
      version: 1,
      run: {
        id: "run-2026-01-01T00-00-00-000Z",
        feature: "test-feature",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "running",
        dryRun: false,
        pid: process.pid, // Use current process PID (alive)
      },
      progress: {
        total: 3,
        passed: 1,
        failed: 1,
        paused: 0,
        blocked: 0,
        pending: 1,
      },
      cost: {
        spent: 0.1234,
        limit: null,
      },
      current: null,
      iterations: 5,
      updatedAt: "2026-01-01T01:00:00.000Z",
      durationMs: 3600000,
      ...overrides,
    };

    writeFileSync(join(featureDir, "status.json"), JSON.stringify(status, null, 2));
  }

  describe("All features table", () => {
    test("shows table with all features", async () => {
      // Setup: Create project with two features
      const naxDir = join(testDir, ".nax");
      const featuresDir = join(naxDir, "features");
      mkdirSync(featuresDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      // Feature 1: structured-logging
      const feature1Dir = join(featuresDir, "structured-logging");
      mkdirSync(feature1Dir, { recursive: true });
      const prd1 = createTestPRD("structured-logging");
      writeFileSync(join(feature1Dir, "prd.json"), JSON.stringify(prd1, null, 2));

      // Feature 2: cli-status
      const feature2Dir = join(featuresDir, "cli-status");
      mkdirSync(feature2Dir, { recursive: true });
      const prd2 = createTestPRD("cli-status", {
        userStories: [
          {
            id: "US-001",
            title: "Status command",
            description: "Test",
            acceptanceCriteria: ["AC-1"],
            tags: [],
            dependencies: [],
            status: "passed",
            passes: true,
            escalations: [],
            attempts: 1,
          },
        ],
      });
      writeFileSync(join(feature2Dir, "prd.json"), JSON.stringify(prd2, null, 2));

      // Act
      await displayFeatureStatus({ dir: testDir });

      // Assert
      const output = consoleOutput.join("\n");
      expect(output).toContain("Features");
      expect(output).toContain("structured-logging");
      expect(output).toContain("cli-status");
    });

    test("shows 'No runs yet' when no runs directory", async () => {
      // Setup: Create project with one feature (no runs/)
      const naxDir = join(testDir, ".nax");
      const featuresDir = join(naxDir, "features");
      mkdirSync(featuresDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      const featureDir = join(featuresDir, "test-feature");
      mkdirSync(featureDir, { recursive: true });
      const prd = createTestPRD("test-feature");
      writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

      // Act
      await displayFeatureStatus({ dir: testDir });

      // Assert
      const output = consoleOutput.join("\n");
      expect(output).toContain("No runs yet");
    });

    test("shows last run timestamp from runs directory", async () => {
      // Setup: Create project with runs
      const naxDir = join(testDir, ".nax");
      const featuresDir = join(naxDir, "features");
      mkdirSync(featuresDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      const featureDir = join(featuresDir, "test-feature");
      const runsDir = join(featureDir, "runs");
      mkdirSync(runsDir, { recursive: true });
      const prd = createTestPRD("test-feature");
      writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

      // Create run log files
      writeFileSync(join(runsDir, "2026-01-01T10-00-00.jsonl"), "");
      writeFileSync(join(runsDir, "2026-01-02T15-30-00.jsonl"), ""); // Latest

      // Act
      await displayFeatureStatus({ dir: testDir });

      // Assert
      const output = consoleOutput.join("\n");
      expect(output).toContain("2026-01-02T15-30-00");
    });

    skipInCI("detects active run via PID check", async () => {
      // Setup: Create project with active status.json
      const naxDir = join(testDir, ".nax");
      const featuresDir = join(naxDir, "features");
      mkdirSync(featuresDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      const featureDir = join(featuresDir, "test-feature");
      mkdirSync(featureDir, { recursive: true });
      const prd = createTestPRD("test-feature");
      writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

      // Create status.json with current PID (alive)
      createStatusFile(featureDir, {
        run: {
          id: "run-2026-01-01T00-00-00-000Z",
          feature: "test-feature",
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "running",
          dryRun: false,
          pid: process.pid, // Current process (alive)
        },
      });

      // Act
      await displayFeatureStatus({ dir: testDir });

      // Assert
      const output = consoleOutput.join("\n");
      expect(output).toContain("Running");
    });

    test("detects crashed run via dead PID", async () => {
      // Setup: Create project with crashed status.json
      const naxDir = join(testDir, ".nax");
      const featuresDir = join(naxDir, "features");
      mkdirSync(featuresDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      const featureDir = join(featuresDir, "test-feature");
      mkdirSync(featureDir, { recursive: true });
      const prd = createTestPRD("test-feature");
      writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

      // Create status.json with fake PID (dead)
      createStatusFile(featureDir, {
        run: {
          id: "run-2026-01-01T00-00-00-000Z",
          feature: "test-feature",
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "running",
          dryRun: false,
          pid: 999999, // Non-existent PID (dead)
        },
      });

      // Act
      await displayFeatureStatus({ dir: testDir });

      // Assert
      const output = consoleOutput.join("\n");
      expect(output).toContain("Crashed");
    });
  });

  describe("Single feature view", () => {
    test("shows detailed feature status with story table", async () => {
      // Setup: Create project with one feature
      const naxDir = join(testDir, ".nax");
      const featuresDir = join(naxDir, "features");
      mkdirSync(featuresDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      const featureDir = join(featuresDir, "test-feature");
      mkdirSync(featureDir, { recursive: true });
      const prd = createTestPRD("test-feature");
      writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

      // Act
      await displayFeatureStatus({ dir: testDir, feature: "test-feature" });

      // Assert
      const output = consoleOutput.join("\n");
      expect(output).toContain("test-feature");
      expect(output).toContain("Progress:");
      expect(output).toContain("Stories:");
      expect(output).toContain("US-001");
      expect(output).toContain("US-002");
      expect(output).toContain("US-003");
    });

    skipInCI("shows active run details with current story", async () => {
      // Setup: Create project with active run
      const naxDir = join(testDir, ".nax");
      const featuresDir = join(naxDir, "features");
      mkdirSync(featuresDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      const featureDir = join(featuresDir, "test-feature");
      mkdirSync(featureDir, { recursive: true });
      const prd = createTestPRD("test-feature");
      writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

      // Create status.json with active run
      createStatusFile(featureDir, {
        run: {
          id: "run-2026-01-01T00-00-00-000Z",
          feature: "test-feature",
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "running",
          dryRun: false,
          pid: process.pid,
        },
        current: {
          storyId: "US-002",
          title: "Second story",
          complexity: "medium",
          tddStrategy: "test-after",
          model: "claude-sonnet-4.5",
          attempt: 1,
          phase: "execution",
        },
      });

      // Act
      await displayFeatureStatus({ dir: testDir, feature: "test-feature" });

      // Assert
      const output = consoleOutput.join("\n");
      expect(output).toContain("Active Run:");
      expect(output).toContain("US-002");
      expect(output).toContain("Second story");
    });

    test("shows crashed run with recovery hints", async () => {
      // Setup: Create project with crashed run
      const naxDir = join(testDir, ".nax");
      const featuresDir = join(naxDir, "features");
      mkdirSync(featuresDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      const featureDir = join(featuresDir, "test-feature");
      mkdirSync(featureDir, { recursive: true });
      const prd = createTestPRD("test-feature");
      writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

      // Create status.json with crashed run
      createStatusFile(featureDir, {
        run: {
          id: "run-2026-01-01T00-00-00-000Z",
          feature: "test-feature",
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "running",
          dryRun: false,
          pid: 999999, // Dead PID
          crashedAt: "2026-01-01T01:00:00.000Z",
          crashSignal: "SIGTERM",
        },
      });

      // Act
      await displayFeatureStatus({ dir: testDir, feature: "test-feature" });

      // Assert
      const output = consoleOutput.join("\n");
      expect(output).toContain("Crashed Run Detected");
      expect(output).toContain("Recovery Hints");
      expect(output).toContain("nax run -f test-feature");
    });

    test("shows 'No active run' when status.json not found", async () => {
      // Setup: Create project without status.json
      const naxDir = join(testDir, ".nax");
      const featuresDir = join(naxDir, "features");
      mkdirSync(featuresDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      const featureDir = join(featuresDir, "test-feature");
      mkdirSync(featureDir, { recursive: true });
      const prd = createTestPRD("test-feature");
      writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

      // Act
      await displayFeatureStatus({ dir: testDir, feature: "test-feature" });

      // Assert
      const output = consoleOutput.join("\n");
      expect(output).toContain("No active run");
    });
  });
});
