// RE-ARCH: keep
/**
 * Unit tests for rectification core logic (v0.11)
 */

import { describe, expect, test } from "bun:test";
import type { RectificationConfig } from "../../src/config";
import {
  type RectificationState,
  createRectificationPrompt,
  shouldRetryRectification,
} from "../../src/execution/rectification";
import type { TestFailure } from "../../src/execution/test-output-parser";
import type { UserStory } from "../../src/prd";

describe("shouldRetryRectification", () => {
  const baseConfig: RectificationConfig = {
    enabled: true,
    maxRetries: 2,
    fullSuiteTimeoutSeconds: 120,
    maxFailureSummaryChars: 2000,
    abortOnIncreasingFailures: true,
  };

  test("should retry when attempt < maxRetries and failures exist", () => {
    const state: RectificationState = {
      attempt: 0,
      initialFailures: 5,
      currentFailures: 3,
    };
    expect(shouldRetryRectification(state, baseConfig)).toBe(true);
  });

  test("should retry on attempt 1 when maxRetries is 2", () => {
    const state: RectificationState = {
      attempt: 1,
      initialFailures: 5,
      currentFailures: 2,
    };
    expect(shouldRetryRectification(state, baseConfig)).toBe(true);
  });

  test("should NOT retry when attempt >= maxRetries", () => {
    const state: RectificationState = {
      attempt: 2,
      initialFailures: 5,
      currentFailures: 3,
    };
    expect(shouldRetryRectification(state, baseConfig)).toBe(false);
  });

  test("should NOT retry when currentFailures = 0 (all passing)", () => {
    const state: RectificationState = {
      attempt: 0,
      initialFailures: 5,
      currentFailures: 0,
    };
    expect(shouldRetryRectification(state, baseConfig)).toBe(false);
  });

  test("should abort when failures increase and abortOnIncreasingFailures = true", () => {
    const state: RectificationState = {
      attempt: 1,
      initialFailures: 3,
      currentFailures: 5, // regression!
    };
    expect(shouldRetryRectification(state, baseConfig)).toBe(false);
  });

  test("should continue when failures increase but abortOnIncreasingFailures = false", () => {
    const config: RectificationConfig = {
      ...baseConfig,
      abortOnIncreasingFailures: false,
    };
    const state: RectificationState = {
      attempt: 1,
      initialFailures: 3,
      currentFailures: 5,
    };
    expect(shouldRetryRectification(state, config)).toBe(true);
  });

  test("should retry when failures decreased (progress)", () => {
    const state: RectificationState = {
      attempt: 1,
      initialFailures: 5,
      currentFailures: 2,
    };
    expect(shouldRetryRectification(state, baseConfig)).toBe(true);
  });

  test("should retry when failures stayed same", () => {
    const state: RectificationState = {
      attempt: 1,
      initialFailures: 5,
      currentFailures: 5,
    };
    expect(shouldRetryRectification(state, baseConfig)).toBe(true);
  });

  test("should NOT retry at maxRetries even if failures exist", () => {
    const state: RectificationState = {
      attempt: 2,
      initialFailures: 5,
      currentFailures: 1,
    };
    expect(shouldRetryRectification(state, baseConfig)).toBe(false);
  });

  test("should handle maxRetries = 0 (no retries allowed)", () => {
    const config: RectificationConfig = {
      ...baseConfig,
      maxRetries: 0,
    };
    const state: RectificationState = {
      attempt: 0,
      initialFailures: 5,
      currentFailures: 5,
    };
    expect(shouldRetryRectification(state, config)).toBe(false);
  });
});

describe("createRectificationPrompt", () => {
  const mockStory: UserStory = {
    id: "US-001",
    title: "Add user authentication",
    description: "Implement JWT-based authentication for API endpoints",
    acceptanceCriteria: [
      "Users can log in with email/password",
      "JWT tokens are issued on successful login",
      "Protected endpoints validate JWT tokens",
    ],
    tags: ["security"],
    dependencies: [],
    status: "in-progress",
    passes: false,
    escalations: [],
    attempts: 1,
  };

  const mockFailures: TestFailure[] = [
    {
      file: "test/auth.test.ts",
      testName: "login > should return JWT on valid credentials",
      error: "Expected status 200, got 401",
      stackTrace: ["at test/auth.test.ts:15:20", "at Object.test (test/auth.test.ts:10:3)"],
    },
    {
      file: "test/middleware.test.ts",
      testName: "JWT middleware > should reject invalid tokens",
      error: "Expected 403, got 200",
      stackTrace: ["at test/middleware.test.ts:25:10"],
    },
  ];

  test("should include story title and description", () => {
    const prompt = createRectificationPrompt(mockFailures, mockStory);
    expect(prompt).toContain("Add user authentication");
    expect(prompt).toContain("Implement JWT-based authentication for API endpoints");
  });

  test("should include all acceptance criteria", () => {
    const prompt = createRectificationPrompt(mockFailures, mockStory);
    expect(prompt).toContain("1. Users can log in with email/password");
    expect(prompt).toContain("2. JWT tokens are issued on successful login");
    expect(prompt).toContain("3. Protected endpoints validate JWT tokens");
  });

  test("should include formatted failure summary from R1's formatFailureSummary", () => {
    const prompt = createRectificationPrompt(mockFailures, mockStory);
    expect(prompt).toContain("test/auth.test.ts > login > should return JWT on valid credentials");
    expect(prompt).toContain("Expected status 200, got 401");
    expect(prompt).toContain("test/middleware.test.ts > JWT middleware > should reject invalid tokens");
    expect(prompt).toContain("Expected 403, got 200");
  });

  test("should include specific bun test commands for failing files", () => {
    const prompt = createRectificationPrompt(mockFailures, mockStory);
    expect(prompt).toContain("bun test test/auth.test.ts");
    expect(prompt).toContain("bun test test/middleware.test.ts");
  });

  test("should include clear instructions about fixing regressions", () => {
    const prompt = createRectificationPrompt(mockFailures, mockStory);
    expect(prompt).toContain("Your changes caused test regressions");
    expect(prompt).toContain("Fix these without breaking existing logic");
  });

  test("should warn against loosening assertions", () => {
    const prompt = createRectificationPrompt(mockFailures, mockStory);
    expect(prompt).toContain("Do NOT loosen assertions to mask implementation bugs");
  });

  test("should warn against modifying tests unnecessarily", () => {
    const prompt = createRectificationPrompt(mockFailures, mockStory);
    expect(prompt).toContain("Do NOT modify test files unless there is a legitimate bug in the test itself");
  });

  test("should respect maxFailureSummaryChars config", () => {
    const config: RectificationConfig = {
      enabled: true,
      maxRetries: 2,
      fullSuiteTimeoutSeconds: 120,
      maxFailureSummaryChars: 100, // very small limit
      abortOnIncreasingFailures: true,
    };

    const manyFailures: TestFailure[] = Array.from({ length: 20 }, (_, i) => ({
      file: `test/file${i}.test.ts`,
      testName: `test ${i}`,
      error: `Error ${i}: Some long error message that takes up space`,
      stackTrace: [`at test/file${i}.test.ts:${i}:0`],
    }));

    const prompt = createRectificationPrompt(manyFailures, mockStory, config);
    // Should contain truncation message
    expect(prompt).toMatch(/truncated/i);
  });

  test("should handle single failure", () => {
    const singleFailure: TestFailure[] = [mockFailures[0]];
    const prompt = createRectificationPrompt(singleFailure, mockStory);
    expect(prompt).toContain("test/auth.test.ts > login > should return JWT on valid credentials");
    expect(prompt).toContain("bun test test/auth.test.ts");
  });

  test("should deduplicate test commands for same file", () => {
    const duplicateFileFailures: TestFailure[] = [
      {
        file: "test/auth.test.ts",
        testName: "test 1",
        error: "error 1",
        stackTrace: [],
      },
      {
        file: "test/auth.test.ts",
        testName: "test 2",
        error: "error 2",
        stackTrace: [],
      },
      {
        file: "test/middleware.test.ts",
        testName: "test 3",
        error: "error 3",
        stackTrace: [],
      },
    ];

    const prompt = createRectificationPrompt(duplicateFileFailures, mockStory);

    // Should only have 2 unique bun test commands
    const testCommands = prompt.match(/bun test test\//g);
    expect(testCommands).not.toBeNull();
    expect(testCommands?.length).toBe(2);

    // Should contain both unique files
    expect(prompt).toContain("bun test test/auth.test.ts");
    expect(prompt).toContain("bun test test/middleware.test.ts");
  });

  test("should use default maxChars when config not provided", () => {
    const prompt = createRectificationPrompt(mockFailures, mockStory);
    // Should not be truncated with default 2000 chars for just 2 failures
    expect(prompt).not.toMatch(/truncated/i);
    expect(prompt).toContain("test/auth.test.ts");
    expect(prompt).toContain("test/middleware.test.ts");
  });

  test("should handle empty acceptance criteria array", () => {
    const storyNoAC: UserStory = {
      ...mockStory,
      acceptanceCriteria: [],
    };
    const prompt = createRectificationPrompt(mockFailures, storyNoAC);
    expect(prompt).toContain("Acceptance Criteria:");
    // Should not crash, just show empty list
  });

  test("should include instructions to run ONLY failing tests", () => {
    const prompt = createRectificationPrompt(mockFailures, mockStory);
    expect(prompt).toContain("run ONLY the failing test files shown above");
    expect(prompt).toContain("NEVER run `bun test` without a file filter");
  });
});
