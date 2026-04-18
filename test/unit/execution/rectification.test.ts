// RE-ARCH: keep
/**
 * Unit tests for rectification core logic (v0.11)
 */

import { describe, expect, test } from "bun:test";
import type { RectificationConfig } from "../../../src/config";
import { RectifierPromptBuilder } from "../../../src/prompts";
import { type RectificationState, shouldRetryRectification } from "../../../src/verification/rectification";
import type { TestFailure } from "../../../src/verification/parser";
import type { UserStory } from "../../../src/prd";

describe("shouldRetryRectification", () => {
  const baseConfig: RectificationConfig = {
    enabled: true,
    maxRetries: 2,
    fullSuiteTimeoutSeconds: 120,
    maxFailureSummaryChars: 2000,
    abortOnIncreasingFailures: true,
    escalateOnExhaustion: true,
    rethinkAtAttempt: 2,
    urgencyAtAttempt: 3,
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


describe("createEscalatedRectificationPrompt", () => {
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
      stackTrace: ["at test/auth.test.ts:15:20"],
    },
    {
      file: "test/middleware.test.ts",
      testName: "JWT middleware > should reject invalid tokens",
      error: "Expected 403, got 200",
      stackTrace: ["at test/middleware.test.ts:25:10"],
    },
  ];

  const baseConfig: RectificationConfig = {
    enabled: true,
    maxRetries: 2,
    fullSuiteTimeoutSeconds: 120,
    maxFailureSummaryChars: 2000,
    abortOnIncreasingFailures: true,
    escalateOnExhaustion: true,
    rethinkAtAttempt: 2,
    urgencyAtAttempt: 3,
  };

  test("should include 'Previous Rectification Attempts' section header", () => {
    const prompt = RectifierPromptBuilder.escalated(
      mockFailures,
      mockStory,
      2,
      "balanced",
      "powerful",
      baseConfig,
    );
    expect(prompt).toContain("Previous Rectification Attempts");
  });

  test("should include prior attempt count and original tier in the section", () => {
    const prompt = RectifierPromptBuilder.escalated(
      mockFailures,
      mockStory,
      2,
      "balanced",
      "powerful",
      baseConfig,
    );
    expect(prompt).toMatch(/(?:prior|previous).*:.*2/i);
    expect(prompt).toContain("balanced");
  });

  test("should list all test names when failures <= 10", () => {
    const prompt = RectifierPromptBuilder.escalated(
      mockFailures,
      mockStory,
      1,
      "fast",
      "balanced",
      baseConfig,
    );
    expect(prompt).toContain("login > should return JWT on valid credentials");
    expect(prompt).toContain("JWT middleware > should reject invalid tokens");
  });

  test("should include first 10 test names and 'and N more' when failures > 10", () => {
    const manyFailures: TestFailure[] = Array.from({ length: 15 }, (_, i) => ({
      file: `test/file${i}.test.ts`,
      testName: `test ${i}`,
      error: `Error ${i}`,
      stackTrace: [],
    }));

    const prompt = RectifierPromptBuilder.escalated(
      manyFailures,
      mockStory,
      2,
      "balanced",
      "powerful",
      baseConfig,
    );

    // Should include first 10 test names
    for (let i = 0; i < 10; i++) {
      expect(prompt).toContain(`test ${i}`);
    }

    // Should include "and 5 more" (15 - 10 = 5)
    expect(prompt).toContain("and 5 more");
  });

  test("should include escalation direction with both source and target tiers", () => {
    const prompt = RectifierPromptBuilder.escalated(
      mockFailures,
      mockStory,
      2,
      "balanced",
      "powerful",
      baseConfig,
    );
    expect(prompt).toContain("balanced");
    expect(prompt).toContain("powerful");
    // Should have some indication of escalation/direction
    expect(prompt.toLowerCase()).toMatch(/escalat/);
  });

  test("should handle escalation from fast to balanced", () => {
    const prompt = RectifierPromptBuilder.escalated(
      mockFailures,
      mockStory,
      1,
      "fast",
      "balanced",
      baseConfig,
    );
    expect(prompt).toContain("fast");
    expect(prompt).toContain("balanced");
  });

  test("should include story context (title, description, acceptance criteria)", () => {
    const prompt = RectifierPromptBuilder.escalated(
      mockFailures,
      mockStory,
      1,
      "balanced",
      "powerful",
      baseConfig,
    );
    expect(prompt).toContain("Add user authentication");
    expect(prompt).toContain("Implement JWT-based authentication for API endpoints");
    expect(prompt).toContain("Users can log in with email/password");
  });

  test("should include failure summary", () => {
    const prompt = RectifierPromptBuilder.escalated(
      mockFailures,
      mockStory,
      1,
      "balanced",
      "powerful",
      baseConfig,
    );
    expect(prompt).toContain("test/auth.test.ts");
    expect(prompt).toContain("Expected status 200, got 401");
  });

  test("should respect maxFailureSummaryChars config", () => {
    const smallConfig: RectificationConfig = {
      enabled: true,
      maxRetries: 2,
      fullSuiteTimeoutSeconds: 120,
      maxFailureSummaryChars: 100,
      abortOnIncreasingFailures: true,
      escalateOnExhaustion: true,
      rethinkAtAttempt: 2,
      urgencyAtAttempt: 3,
    };

    const manyFailures: TestFailure[] = Array.from({ length: 10 }, (_, i) => ({
      file: `test/file${i}.test.ts`,
      testName: `test ${i}`,
      error: `Error ${i}: Some long error message that takes up space`,
      stackTrace: [],
    }));

    const prompt = RectifierPromptBuilder.escalated(
      manyFailures,
      mockStory,
      1,
      "balanced",
      "powerful",
      smallConfig,
    );

    expect(prompt).toMatch(/truncated/i);
  });

  test("should handle exactly 10 failures without 'and N more'", () => {
    const tenFailures: TestFailure[] = Array.from({ length: 10 }, (_, i) => ({
      file: `test/file${i}.test.ts`,
      testName: `test ${i}`,
      error: `Error ${i}`,
      stackTrace: [],
    }));

    const prompt = RectifierPromptBuilder.escalated(
      tenFailures,
      mockStory,
      1,
      "balanced",
      "powerful",
      baseConfig,
    );

    // Should include all 10 test names
    for (let i = 0; i < 10; i++) {
      expect(prompt).toContain(`test ${i}`);
    }

    // Should NOT include "and N more" when exactly 10
    expect(prompt).not.toMatch(/and \d+ more/);
  });

  test("should include instructions for the agent", () => {
    const prompt = RectifierPromptBuilder.escalated(
      mockFailures,
      mockStory,
      1,
      "balanced",
      "powerful",
      baseConfig,
    );
    // Should have some guidance for the escalated attempt
    expect(prompt.toLowerCase()).toMatch(/fix|implement|correct/);
  });

  test("uses configured testCommand in NEVER run filter instruction", () => {
    const prompt = RectifierPromptBuilder.escalated(
      mockFailures,
      mockStory,
      1,
      "balanced",
      "powerful",
      baseConfig,
      "jest",
    );
    expect(prompt).toContain("NEVER run `jest` without a file filter");
    expect(prompt).not.toContain("NEVER run `bun test`");
  });

  test("uses neutral filter instruction when no testCommand provided (#543)", () => {
    const prompt = RectifierPromptBuilder.escalated(
      mockFailures,
      mockStory,
      1,
      "balanced",
      "powerful",
      baseConfig,
    );
    expect(prompt).toContain("never run the full test suite without a file filter");
    expect(prompt).not.toContain("bun test");
  });

  test("references configured test command when provided", () => {
    const prompt = RectifierPromptBuilder.escalated(
      mockFailures,
      mockStory,
      1,
      "balanced",
      "powerful",
      baseConfig,
      "go test",
    );
    expect(prompt).toContain("NEVER run `go test` without a file filter");
  });
});
