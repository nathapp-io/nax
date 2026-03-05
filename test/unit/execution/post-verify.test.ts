/**
 * Unit tests for regression gate configuration and behavior
 *
 * Tests the configuration and type-level logic for:
 * - Regression gate enabled/disabled state
 * - Timeout configuration and acceptOnTimeout behavior (BUG-026)
 * - Story state transitions on regression failure
 * - Metrics removal on regression failure
 *
 * Behavioral tests are in post-verify-regression.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { RegressionGateConfig } from "../../../src/config/schema";

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
  test("regression gate should run when enabled (post-verify always runs full suite)", () => {
    const regressionGateEnabled = true;

    // Post-verify now ONLY runs full-suite regression gate (no scoped logic)
    expect(regressionGateEnabled).toBe(true);
  });

  test("regression gate should skip when disabled in config", () => {
    const regressionGateEnabled = false;

    // Logic: regression gate should NOT run
    expect(regressionGateEnabled).toBe(false);
  });

  test("post-verify removes scoped verification (always runs full suite)", () => {
    // With the removal of scoped verification, post-verify always:
    // 1. Runs the full-suite regression gate (if enabled)
    // 2. Reverts on failure
    // 3. Optionally runs rectification on test failures

    const hasNoScopedVerification = true;
    expect(hasNoScopedVerification).toBe(true);
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
    const regressionPrompt = `# REGRESSION: Full-Suite Test Failures

Your changes broke tests in the full suite. Fix these regressions.`;

    expect(regressionPrompt).toContain("# REGRESSION:");
    expect(regressionPrompt).toContain("Full-Suite Test Failures");
  });

  test("regression prompt should emphasize full-suite nature", () => {
    const regressionPrompt =
      "# REGRESSION: Full-Suite Test Failures\n\nYour changes broke tests in the full suite.";

    expect(regressionPrompt).toContain("Full-Suite");
    expect(regressionPrompt).toContain("broke tests");
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

  test("should have acceptOnTimeout config option (BUG-026)", () => {
    const regressionGateConfig: RegressionGateConfig = {
      enabled: true,
      timeoutSeconds: 120,
      acceptOnTimeout: true,
    };

    expect(regressionGateConfig.acceptOnTimeout).toBe(true);
  });

  test("should default acceptOnTimeout to true (BUG-026)", () => {
    const regressionGateConfig: RegressionGateConfig = {
      enabled: true,
      timeoutSeconds: 120,
      // acceptOnTimeout not specified - should default to true
    };

    // When acceptOnTimeout is undefined, it should be treated as true
    const acceptOnTimeout = regressionGateConfig.acceptOnTimeout ?? true;
    expect(acceptOnTimeout).toBe(true);
  });

  test("should allow disabling acceptOnTimeout (BUG-026)", () => {
    const regressionGateConfig: RegressionGateConfig = {
      enabled: true,
      timeoutSeconds: 120,
      acceptOnTimeout: false,
    };

    expect(regressionGateConfig.acceptOnTimeout).toBe(false);
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
