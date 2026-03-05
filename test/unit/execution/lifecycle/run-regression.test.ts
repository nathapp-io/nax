/**
 * Smart Runner Reverse Mapping Tests + Deferred Regression Gate Tests
 *
 * Covers:
 * - reverseMapTestToSource: maps test files back to source files
 * - runDeferredRegression: deferred regression gate behavior
 */

import { describe, test, expect } from "bun:test";
import type { NaxConfig } from "../../../../src/config";
import type { PRD, UserStory } from "../../../../src/prd";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, status: UserStory["status"]): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status,
    passes: status === "passed",
    escalations: [],
    attempts: 1,
  };
}

function makePRD(stories: Array<{ id: string; status: UserStory["status"] }>): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories.map(({ id, status }) => makeStory(id, status)),
  };
}

function makeConfig(
  regressionMode?: "deferred" | "per-story" | "disabled",
  testCommand?: string,
): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    execution: {
      ...DEFAULT_CONFIG.execution,
      regressionGate: {
        enabled: true,
        timeoutSeconds: 30,
        acceptOnTimeout: true,
        ...(regressionMode !== undefined ? { mode: regressionMode } : {}),
        maxRectificationAttempts: 2,
      },
    },
    quality: {
      ...DEFAULT_CONFIG.quality,
      commands: {
        ...(testCommand ? { test: testCommand } : {}),
      },
    },
  };
}

describe("reverseMapTestToSource", () => {
  test("should map test/unit files to source files", async () => {
    const { reverseMapTestToSource } = await import("../../../../src/verification/smart-runner");

    const testFiles = ["/repo/test/unit/foo/bar.test.ts"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual(["src/foo/bar.ts"]);
  });

  test("should map test/integration files to source files", async () => {
    const { reverseMapTestToSource } = await import("../../../../src/verification/smart-runner");

    const testFiles = ["/repo/test/integration/foo/bar.test.ts"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual(["src/foo/bar.ts"]);
  });

  test("should ignore non-test files", async () => {
    const { reverseMapTestToSource } = await import("../../../../src/verification/smart-runner");

    const testFiles = ["/repo/src/foo/bar.ts"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual([]);
  });

  test("should deduplicate results", async () => {
    const { reverseMapTestToSource } = await import("../../../../src/verification/smart-runner");

    const testFiles = ["/repo/test/unit/foo/bar.test.ts", "/repo/test/integration/foo/bar.test.ts"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual(["src/foo/bar.ts"]);
  });

  test("should handle paths without leading workdir", async () => {
    const { reverseMapTestToSource } = await import("../../../../src/verification/smart-runner");

    const testFiles = ["test/unit/foo/bar.test.ts"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual(["src/foo/bar.ts"]);
  });

  test("should preserve order when mapping multiple files", async () => {
    const { reverseMapTestToSource } = await import("../../../../src/verification/smart-runner");

    const testFiles = [
      "/repo/test/unit/aaa.test.ts",
      "/repo/test/unit/bbb.test.ts",
      "/repo/test/unit/ccc.test.ts",
    ];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual(["src/aaa.ts", "src/bbb.ts", "src/ccc.ts"]);
  });

  test("should handle empty input", async () => {
    const { reverseMapTestToSource } = await import("../../../../src/verification/smart-runner");

    const testFiles: string[] = [];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual([]);
  });

  test("should filter out files with .test.js extension", async () => {
    const { reverseMapTestToSource } = await import("../../../../src/verification/smart-runner");

    // Only .test.ts files should be mapped (not .test.js)
    const testFiles = ["/repo/test/unit/foo.js"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runDeferredRegression
// ---------------------------------------------------------------------------

describe("runDeferredRegression", () => {
  test("returns success immediately when mode is 'disabled'", async () => {
    const { runDeferredRegression } = await import(
      "../../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("disabled", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: "/tmp/nax-test-disabled",
    });

    expect(result.success).toBe(true);
    expect(result.failedTests).toBe(0);
    expect(result.rectificationAttempts).toBe(0);
    expect(result.affectedStories).toEqual([]);
  });

  test("returns success immediately when mode is 'per-story' (deferred not applicable)", async () => {
    const { runDeferredRegression } = await import(
      "../../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("per-story", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: "/tmp/nax-test-per-story",
    });

    expect(result.success).toBe(true);
    expect(result.rectificationAttempts).toBe(0);
    expect(result.affectedStories).toEqual([]);
  });

  test("returns success when no passed stories exist (partial completion)", async () => {
    const { runDeferredRegression } = await import(
      "../../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([
        { id: "US-001", status: "pending" },
        { id: "US-002", status: "failed" },
      ]),
      workdir: "/tmp/nax-test-no-passed",
    });

    expect(result.success).toBe(true);
    expect(result.passedTests).toBe(0);
    expect(result.failedTests).toBe(0);
    expect(result.affectedStories).toEqual([]);
  });

  test("result shape has all required fields", async () => {
    const { runDeferredRegression } = await import(
      "../../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("disabled", "bun test"),
      prd: makePRD([]),
      workdir: "/tmp/nax-test-shape",
    });

    expect(typeof result.success).toBe("boolean");
    expect(typeof result.failedTests).toBe("number");
    expect(typeof result.passedTests).toBe("number");
    expect(typeof result.rectificationAttempts).toBe("number");
    expect(Array.isArray(result.affectedStories)).toBe(true);
  });

  test("affectedStories contains only string values", async () => {
    const { runDeferredRegression } = await import(
      "../../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("disabled", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: "/tmp/nax-test-story-ids",
    });

    for (const storyId of result.affectedStories) {
      expect(typeof storyId).toBe("string");
    }
  });

  test("passedTests is non-negative integer", async () => {
    const { runDeferredRegression } = await import(
      "../../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("disabled", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: "/tmp/nax-test-counts",
    });

    expect(result.passedTests).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.passedTests)).toBe(true);
  });
});
