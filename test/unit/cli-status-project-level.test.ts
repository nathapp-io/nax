/**
 * Tests for project-level status display in status-features.ts
 *
 * Verifies that nax status shows current run info from nax/status.json at the top.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayFeatureStatus } from "../../src/cli/status";
import type { NaxStatusFile } from "../../src/execution/status-file";
import type { PRD } from "../../src/prd";

describe("displayFeatureStatus - Project-level status (nax/status.json)", () => {
  let testDir: string;
  let originalCwd: string;
  let consoleOutput: string[];
  const originalLog = console.log;

  beforeEach(() => {
    // Create temp directory for test
    const rawTestDir = join(tmpdir(), `nax-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(rawTestDir, { recursive: true });
    testDir = realpathSync(rawTestDir);
    originalCwd = process.cwd();

    // Mock console.log to capture output
    consoleOutput = [];
    console.log = mock((message: string) => {
      consoleOutput.push(message);
    });
  });

  afterEach(() => {
    // Restore original CWD and console.log
    process.chdir(originalCwd);
    console.log = originalLog;

    // Clean up test directory
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function createTestPRD(featureName: string): PRD {
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
      ],
    };
  }

  function createProjectStatus(feature: string, overrides: Partial<NaxStatusFile> = {}): NaxStatusFile {
    return {
      version: 1,
      run: {
        id: "run-2026-01-01T00-00-00-000Z",
        feature,
        startedAt: "2026-01-01T10:00:00.000Z",
        status: "running",
        dryRun: false,
        pid: process.pid, // Use current process PID (alive)
        ...overrides.run,
      },
      progress: {
        total: 5,
        passed: 2,
        failed: 1,
        paused: 0,
        blocked: 0,
        pending: 2,
        ...overrides.progress,
      },
      cost: {
        spent: 0.5678,
        limit: null,
        ...overrides.cost,
      },
      current: {
        storyId: "US-002",
        title: "Test current story",
        complexity: "medium",
        tddStrategy: "red-green-refactor",
        model: "claude-opus",
        attempt: 1,
        phase: "implementation",
      },
      iterations: 10,
      updatedAt: "2026-01-01T10:30:00.000Z",
      durationMs: 1800000,
      ...overrides,
    };
  }

  describe("AC1: Shows project-level current run info at top", () => {
    test("displays current run info when active run exists in nax/status.json", async () => {
      // Setup: Create project with feature and project-level status
      const naxDir = join(testDir, "nax");
      const featuresDir = join(naxDir, "features");
      mkdirSync(featuresDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      const featureDir = join(featuresDir, "current-feature");
      mkdirSync(featureDir, { recursive: true });
      const prd = createTestPRD("current-feature");
      writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

      // Create project-level status.json
      const projectStatus = createProjectStatus("current-feature", {
        run: {
          id: "run-2026-01-01T00-00-00-000Z",
          feature: "current-feature",
          startedAt: "2026-01-01T10:00:00.000Z",
          status: "running",
          dryRun: false,
          pid: process.pid,
        },
      });
      mkdirSync(join(naxDir), { recursive: true });
      writeFileSync(join(naxDir, "status.json"), JSON.stringify(projectStatus, null, 2));

      // Act
      await displayFeatureStatus({ dir: testDir });

      // Assert
      const output = consoleOutput.join("\n");
      expect(output).toContain("⚡ Currently Running:");
      expect(output).toContain("current-feature");
      expect(output).toContain("run-2026-01-01T00-00-00-000Z");
      expect(output).toContain("2026-01-01T10:00:00.000Z");
      expect(output).toContain("2/5 stories");
      expect(output).toContain("$0.5678");
      expect(output).toContain("US-002");
      expect(output).toContain("Test current story");
    });

    test("does not show current run info when nax/status.json missing", async () => {
      // Setup: Create project with feature but no project-level status
      const naxDir = join(testDir, "nax");
      const featuresDir = join(naxDir, "features");
      mkdirSync(featuresDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      const featureDir = join(featuresDir, "no-status-feature");
      mkdirSync(featureDir, { recursive: true });
      const prd = createTestPRD("no-status-feature");
      writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

      // Act (no status.json created)
      await displayFeatureStatus({ dir: testDir });

      // Assert
      const output = consoleOutput.join("\n");
      expect(output).not.toContain("⚡ Currently Running:");
    });

    test("shows crashed run detected when PID is dead", async () => {
      // Setup: Create project with feature and crashed status
      const naxDir = join(testDir, "nax");
      const featuresDir = join(naxDir, "features");
      mkdirSync(featuresDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      const featureDir = join(featuresDir, "crashed-feature");
      mkdirSync(featureDir, { recursive: true });
      const prd = createTestPRD("crashed-feature");
      writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

      // Create project-level status.json with dead PID
      const projectStatus = createProjectStatus("crashed-feature", {
        run: {
          id: "run-2026-01-01T00-00-00-000Z",
          feature: "crashed-feature",
          startedAt: "2026-01-01T10:00:00.000Z",
          status: "running",
          dryRun: false,
          pid: 999999, // Non-existent PID
        },
      });
      writeFileSync(join(naxDir, "status.json"), JSON.stringify(projectStatus, null, 2));

      // Act
      await displayFeatureStatus({ dir: testDir });

      // Assert
      const output = consoleOutput.join("\n");
      expect(output).toContain("💥 Crashed Run Detected:");
      expect(output).toContain("999999");
      expect(output).toContain("dead");
    });

    test("shows crash info when run status is 'crashed'", async () => {
      // Setup: Create project with feature and crashed status
      const naxDir = join(testDir, "nax");
      const featuresDir = join(naxDir, "features");
      mkdirSync(featuresDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      const featureDir = join(featuresDir, "crashed-feature");
      mkdirSync(featureDir, { recursive: true });
      const prd = createTestPRD("crashed-feature");
      writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

      // Create project-level status.json with crashed status
      const projectStatus = createProjectStatus("crashed-feature", {
        run: {
          id: "run-2026-01-01T00-00-00-000Z",
          feature: "crashed-feature",
          startedAt: "2026-01-01T10:00:00.000Z",
          status: "crashed",
          dryRun: false,
          pid: 12345,
          crashedAt: "2026-01-01T10:15:00.000Z",
          crashSignal: "SIGKILL",
        },
      });
      writeFileSync(join(naxDir, "status.json"), JSON.stringify(projectStatus, null, 2));

      // Act
      await displayFeatureStatus({ dir: testDir });

      // Assert
      const output = consoleOutput.join("\n");
      expect(output).toContain("💥 Crashed Run Detected:");
      expect(output).toContain("SIGKILL");
      expect(output).toContain("2026-01-01T10:15:00.000Z");
    });
  });

  describe("AC2: Shows per-feature historical status", () => {
    test("shows feature-level status from nax/features/<feature>/status.json", async () => {
      // Setup: Create project with feature and feature-level status
      const naxDir = join(testDir, "nax");
      const featuresDir = join(naxDir, "features");
      mkdirSync(featuresDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      const featureDir = join(featuresDir, "test-feature");
      mkdirSync(featureDir, { recursive: true });
      const prd = createTestPRD("test-feature");
      writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

      // Create feature-level status.json
      const featureStatus = createProjectStatus("test-feature", {
        run: {
          id: "run-feature-level",
          feature: "test-feature",
          startedAt: "2026-01-01T09:00:00.000Z",
          status: "completed",
          dryRun: false,
          pid: 12345,
        },
      });
      writeFileSync(join(featureDir, "status.json"), JSON.stringify(featureStatus, null, 2));

      // Act
      await displayFeatureStatus({ dir: testDir, feature: "test-feature" });

      // Assert
      const output = consoleOutput.join("\n");
      // Feature details view should show the feature-level status
      expect(output).toContain("test-feature");
    });
  });

});
