/**
 * Tests for displayFeatureDetails() - PostRun status display
 *
 * Tests the new postRun status display feature (US-004) that shows
 * acceptance and regression phase status when postRun field is present.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { displayFeatureStatus } from "../../../src/cli/status";
import type { NaxStatusFile } from "../../../src/execution/status-file";
import type { PRD } from "../../../src/prd";
import { makeTempDir } from "../../helpers/temp";

describe("displayFeatureDetails - PostRun Status Display (US-004)", () => {
  let testDir: string;
  let originalCwd: string;
  let consoleOutput: string[];
  const originalLog = console.log;

  beforeEach(() => {
    const rawTestDir = makeTempDir("nax-test-");
    testDir = realpathSync(rawTestDir);
    originalCwd = process.cwd();

    // Mock console.log to capture output
    consoleOutput = [];
    console.log = mock((message: string) => {
      consoleOutput.push(message);
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    console.log = originalLog;

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
        status: "completed",
        dryRun: false,
        pid: 12345,
      },
      progress: {
        total: 1,
        passed: 1,
        failed: 0,
        paused: 0,
        blocked: 0,
        pending: 0,
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

  // ============================================================================
  // AC-1: Acceptance passed with timestamp
  // ============================================================================

  test("AC-1: displays 'Acceptance: passed' with timestamp when postRun.acceptance.status === 'passed'", async () => {
    // Setup: Create feature with postRun.acceptance.status === "passed"
    const naxDir = join(testDir, ".nax");
    const featuresDir = join(naxDir, "features");
    const featureDir = join(featuresDir, "test-feature");
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), "{}");

    const prd = createTestPRD("test-feature");
    writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

    const acceptanceTimestamp = "2026-04-04T12:00:00.000Z";
    createStatusFile(featureDir, {
      postRun: {
        acceptance: {
          status: "passed",
          lastRunAt: acceptanceTimestamp,
        },
        regression: {
          status: "not-run",
        },
      },
    });

    // Act
    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    // Assert
    const output = consoleOutput.join("\n");
    expect(output).toContain("Acceptance: passed");
    expect(output).toContain(acceptanceTimestamp);
  });

  // ============================================================================
  // AC-2: Regression failed with failedTests count
  // ============================================================================

  test("AC-2: displays 'Regression: failed' with failedTests count when postRun.regression.status === 'failed'", async () => {
    // Setup: Create feature with postRun.regression.status === "failed"
    const naxDir = join(testDir, ".nax");
    const featuresDir = join(naxDir, "features");
    const featureDir = join(featuresDir, "test-feature");
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), "{}");

    const prd = createTestPRD("test-feature");
    writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

    createStatusFile(featureDir, {
      postRun: {
        acceptance: {
          status: "passed",
        },
        regression: {
          status: "failed",
          failedTests: ["test-1", "test-2", "test-3"],
        },
      },
    });

    // Act
    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    // Assert
    const output = consoleOutput.join("\n");
    expect(output).toContain("Regression: failed");
    expect(output).toContain("3"); // failedTests count
  });

  // ============================================================================
  // AC-3: No post-run section when postRun is absent (backward compat)
  // ============================================================================

  test("AC-3: omits post-run section entirely when postRun is absent (backward compat)", async () => {
    // Setup: Create feature WITHOUT postRun field (old status file format)
    const naxDir = join(testDir, ".nax");
    const featuresDir = join(naxDir, "features");
    const featureDir = join(featuresDir, "test-feature");
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), "{}");

    const prd = createTestPRD("test-feature");
    writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

    // Create status file WITHOUT postRun field
    createStatusFile(featureDir);

    // Act
    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    // Assert
    const output = consoleOutput.join("\n");
    expect(output).not.toContain("Acceptance:");
    expect(output).not.toContain("Regression:");
  });

  // ============================================================================
  // AC-4: Regression skipped with smart-skip indicator
  // ============================================================================

  test("AC-4: displays 'Regression: skipped (smart-skip)' when status === 'passed' and skipped === true", async () => {
    // Setup: Create feature with skipped regression
    const naxDir = join(testDir, ".nax");
    const featuresDir = join(naxDir, "features");
    const featureDir = join(featuresDir, "test-feature");
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), "{}");

    const prd = createTestPRD("test-feature");
    writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

    createStatusFile(featureDir, {
      postRun: {
        acceptance: {
          status: "passed",
        },
        regression: {
          status: "passed",
          skipped: true,
        },
      },
    });

    // Act
    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    // Assert
    const output = consoleOutput.join("\n");
    expect(output).toContain("Regression: skipped (smart-skip)");
  });

  // ============================================================================
  // Additional edge cases
  // ============================================================================

  test("displays both acceptance and regression status together", async () => {
    // Setup: Create feature with both phases
    const naxDir = join(testDir, ".nax");
    const featuresDir = join(naxDir, "features");
    const featureDir = join(featuresDir, "test-feature");
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), "{}");

    const prd = createTestPRD("test-feature");
    writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

    const acceptanceTime = "2026-04-04T12:00:00.000Z";
    const regressionTime = "2026-04-04T12:30:00.000Z";

    createStatusFile(featureDir, {
      postRun: {
        acceptance: {
          status: "passed",
          lastRunAt: acceptanceTime,
        },
        regression: {
          status: "failed",
          lastRunAt: regressionTime,
          failedTests: ["test-1"],
        },
      },
    });

    // Act
    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    // Assert
    const output = consoleOutput.join("\n");
    expect(output).toContain("Acceptance: passed");
    expect(output).toContain("Regression: failed");
    expect(output).toContain(acceptanceTime);
    expect(output).toContain(regressionTime);
  });

  test("handles postRun with empty/missing failedTests gracefully", async () => {
    // Setup: Create feature with no failedTests array
    const naxDir = join(testDir, ".nax");
    const featuresDir = join(naxDir, "features");
    const featureDir = join(featuresDir, "test-feature");
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), "{}");

    const prd = createTestPRD("test-feature");
    writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

    createStatusFile(featureDir, {
      postRun: {
        acceptance: {
          status: "failed",
          failedACs: ["AC-1"],
        },
        regression: {
          status: "not-run",
        },
      },
    });

    // Act & Assert: Should not crash
    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("Acceptance: failed");
  });
});
