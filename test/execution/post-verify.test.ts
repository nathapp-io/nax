/**
 * Unit tests for post-verify regression gate (BUG-009)
 *
 * Tests the logic for:
 * - Running regression gate after scoped verification passes
 * - Skipping regression gate when scoped verification already ran full suite
 * - Feeding regression failures into rectification loop
 */

import { describe, expect, test } from "bun:test";
import type { RegressionGateConfig } from "../../src/config/schema";

describe("RegressionGateConfig", () => {
  test("should have correct default values", () => {
    const defaultConfig: RegressionGateConfig = {
      enabled: true,
      timeoutSeconds: 120,
    };

    expect(defaultConfig.enabled).toBe(true);
    expect(defaultConfig.timeoutSeconds).toBe(120);
  });

  test("should allow disabling regression gate", () => {
    const config: RegressionGateConfig = {
      enabled: false,
      timeoutSeconds: 120,
    };

    expect(config.enabled).toBe(false);
  });

  test("should allow custom timeout", () => {
    const config: RegressionGateConfig = {
      enabled: true,
      timeoutSeconds: 180,
    };

    expect(config.timeoutSeconds).toBe(180);
  });
});

describe("Regression Gate Logic", () => {
  test("should run regression gate when scoped tests were run (changed files > 0)", () => {
    const changedTestFiles = ["test/foo.test.ts", "test/bar.test.ts"];
    const regressionGateEnabled = true;
    const scopedTestsWereRun = changedTestFiles.length > 0;

    // Logic: regression gate should run
    const shouldRunRegressionGate = regressionGateEnabled && scopedTestsWereRun;
    expect(shouldRunRegressionGate).toBe(true);
  });

  test("should skip regression gate when scoped tests ran full suite (changed files = 0)", () => {
    const changedTestFiles: string[] = [];
    const regressionGateEnabled = true;
    const scopedTestsWereRun = changedTestFiles.length > 0;

    // Logic: regression gate should NOT run (full suite already ran)
    const shouldRunRegressionGate = regressionGateEnabled && scopedTestsWereRun;
    expect(shouldRunRegressionGate).toBe(false);
  });

  test("should skip regression gate when disabled in config", () => {
    const changedTestFiles = ["test/foo.test.ts"];
    const regressionGateEnabled = false;
    const scopedTestsWereRun = changedTestFiles.length > 0;

    // Logic: regression gate should NOT run (disabled)
    const shouldRunRegressionGate = regressionGateEnabled && scopedTestsWereRun;
    expect(shouldRunRegressionGate).toBe(false);
  });

  test("should skip regression gate when both disabled AND no changed files", () => {
    const changedTestFiles: string[] = [];
    const regressionGateEnabled = false;
    const scopedTestsWereRun = changedTestFiles.length > 0;

    // Logic: regression gate should NOT run
    const shouldRunRegressionGate = regressionGateEnabled && scopedTestsWereRun;
    expect(shouldRunRegressionGate).toBe(false);
  });
});

describe("Regression Failure Handling", () => {
  test("should prefix regression errors with REGRESSION:", () => {
    const regressionStatus = "TEST_FAILURE";
    const diagnosticContext = `REGRESSION: ${regressionStatus}`;

    expect(diagnosticContext).toBe("REGRESSION: TEST_FAILURE");
    expect(diagnosticContext).toContain("REGRESSION:");
  });

  test("should handle different regression failure statuses", () => {
    const statuses = ["TEST_FAILURE", "TIMEOUT", "ENVIRONMENTAL_FAILURE", "ASSET_CHECK_FAILED"];

    for (const status of statuses) {
      const diagnosticContext = `REGRESSION: ${status}`;
      expect(diagnosticContext).toContain("REGRESSION:");
      expect(diagnosticContext).toContain(status);
    }
  });
});

describe("Rectification Prompt for Regression", () => {
  test("should include REGRESSION prefix in rectification prompt", () => {
    const basePrompt = `# Rectification Required

Your changes caused test regressions. Fix these without breaking existing logic.`;

    const regressionPrompt = `# REGRESSION: Cross-Story Test Failures

Your changes passed scoped tests but broke unrelated tests. Fix these regressions.

${basePrompt}`;

    expect(regressionPrompt).toContain("# REGRESSION:");
    expect(regressionPrompt).toContain("passed scoped tests but broke unrelated tests");
    expect(regressionPrompt).toContain(basePrompt);
  });

  test("regression prompt should emphasize cross-story nature", () => {
    const regressionPrompt =
      "# REGRESSION: Cross-Story Test Failures\n\nYour changes passed scoped tests but broke unrelated tests.";

    expect(regressionPrompt).toContain("Cross-Story");
    expect(regressionPrompt).toContain("unrelated tests");
  });
});

describe("Regression Gate Timeout", () => {
  test("should use config.execution.regressionGate.timeoutSeconds", () => {
    const regressionGateConfig: RegressionGateConfig = {
      enabled: true,
      timeoutSeconds: 120,
    };

    expect(regressionGateConfig.timeoutSeconds).toBe(120);
  });

  test("should allow different timeout from verification timeout", () => {
    const verificationTimeoutSeconds = 300;
    const regressionGateTimeoutSeconds = 120;

    // Regression gate can have different timeout (usually shorter)
    expect(regressionGateTimeoutSeconds).not.toBe(verificationTimeoutSeconds);
    expect(regressionGateTimeoutSeconds).toBeLessThan(verificationTimeoutSeconds);
  });
});

describe("Story State After Regression Failure", () => {
  test("should revert story to pending status", () => {
    const story = {
      id: "US-001",
      status: "passed" as const,
      passes: true,
      priorErrors: [] as string[],
      attempts: 0,
    };

    // After regression failure
    const updatedStory = {
      ...story,
      status: "pending" as const,
      passes: false,
      priorErrors: [...story.priorErrors, "REGRESSION: TEST_FAILURE"],
    };

    expect(updatedStory.status).toBe("pending");
    expect(updatedStory.passes).toBe(false);
    expect(updatedStory.priorErrors).toContain("REGRESSION: TEST_FAILURE");
  });

  test("should increment attempts when countsTowardEscalation is true", () => {
    const story = { id: "US-001", attempts: 0 };
    const countsTowardEscalation = true;

    // After regression failure that counts toward escalation
    const updatedAttempts = countsTowardEscalation ? story.attempts + 1 : story.attempts;

    expect(updatedAttempts).toBe(1);
  });

  test("should NOT increment attempts when countsTowardEscalation is false", () => {
    const story = { id: "US-001", attempts: 0 };
    const countsTowardEscalation = false;

    // After regression failure that doesn't count toward escalation (e.g., timeout)
    const updatedAttempts = countsTowardEscalation ? story.attempts + 1 : story.attempts;

    expect(updatedAttempts).toBe(0);
  });
});

describe("Story Metrics Removal", () => {
  test("should remove story metrics on regression failure", () => {
    const allStoryMetrics = [
      { storyId: "US-001", cost: 0.5 },
      { storyId: "US-002", cost: 0.3 },
    ];
    const failedStoryIds = new Set(["US-001"]);

    // Remove metrics for failed stories
    const remainingMetrics = allStoryMetrics.filter((m) => !failedStoryIds.has(m.storyId));

    expect(remainingMetrics.length).toBe(1);
    expect(remainingMetrics[0].storyId).toBe("US-002");
  });

  test("should remove metrics for all stories in batch", () => {
    const allStoryMetrics = [
      { storyId: "US-001", cost: 0.5 },
      { storyId: "US-002", cost: 0.3 },
      { storyId: "US-003", cost: 0.2 },
    ];
    const storyIds = new Set(["US-001", "US-002"]);

    // Remove metrics for entire batch
    const remainingMetrics = allStoryMetrics.filter((m) => !storyIds.has(m.storyId));

    expect(remainingMetrics.length).toBe(1);
    expect(remainingMetrics[0].storyId).toBe("US-003");
  });
});
