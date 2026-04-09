// RE-ARCH: keep
/**
 * Unit tests for rectification core logic (v0.11)
 */

import { describe, expect, test } from "bun:test";
import type { RectificationConfig } from "../../../src/config";
import {
  type RectificationState,
  createRectificationPrompt,
  createEscalatedRectificationPrompt,
  shouldRetryRectification,
} from "../../../src/verification/rectification";
import type { TestFailure } from "../../../src/verification/parser";
import type { UserStory } from "../../../src/prd";

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

  describe("progressive prompt escalation", () => {
    const escalationConfig: RectificationConfig = {
      enabled: true,
      maxRetries: 4,
      fullSuiteTimeoutSeconds: 120,
      maxFailureSummaryChars: 2000,
      abortOnIncreasingFailures: true,
      escalateOnExhaustion: true,
      rethinkAtAttempt: 2,
      urgencyAtAttempt: 3,
    };

    test("attempt 1 — no preamble injected", () => {
      const prompt = createRectificationPrompt(mockFailures, mockStory, escalationConfig, 1);
      expect(prompt).not.toContain("Previous Attempt Did Not Fix");
      expect(prompt).not.toContain("Final Rectification Attempt");
      expect(prompt).toContain("# Rectification Required");
    });

    test("attempt 2 (= rethinkAtAttempt) — rethink section injected, no urgency", () => {
      const prompt = createRectificationPrompt(mockFailures, mockStory, escalationConfig, 2);
      expect(prompt).toContain("Previous Attempt Did Not Fix");
      expect(prompt).toContain("fundamentally different strategy");
      expect(prompt).not.toContain("Final Rectification Attempt");
    });

    test("attempt 3 (= urgencyAtAttempt) — both rethink and urgency injected", () => {
      const prompt = createRectificationPrompt(mockFailures, mockStory, escalationConfig, 3);
      expect(prompt).toContain("Previous Attempt Did Not Fix");
      expect(prompt).toContain("Final Rectification Attempt");
      expect(prompt).toContain("escalate to a stronger model tier");
    });

    test("attempt 4 (> urgencyAtAttempt) — both sections still present", () => {
      const prompt = createRectificationPrompt(mockFailures, mockStory, escalationConfig, 4);
      expect(prompt).toContain("Previous Attempt Did Not Fix");
      expect(prompt).toContain("Final Rectification Attempt");
      expect(prompt).toContain("attempt 4");
    });

    test("attempt number appears in preamble context", () => {
      const prompt = createRectificationPrompt(mockFailures, mockStory, escalationConfig, 2);
      expect(prompt).toContain("attempt 2");
    });

    test("no injection when attempt is undefined (backward compat)", () => {
      const prompt = createRectificationPrompt(mockFailures, mockStory, escalationConfig, undefined);
      expect(prompt).not.toContain("Previous Attempt Did Not Fix");
      expect(prompt).not.toContain("Final Rectification Attempt");
    });

    test("no injection when config is undefined", () => {
      const prompt = createRectificationPrompt(mockFailures, mockStory, undefined, 3);
      expect(prompt).not.toContain("Previous Attempt Did Not Fix");
      expect(prompt).not.toContain("Final Rectification Attempt");
    });

    test("rethink clamped to maxRetries when rethinkAtAttempt > maxRetries", () => {
      // rethinkAtAttempt=99 > maxRetries=4 → clamped to 4 → fires on attempt 4
      const highThresholdConfig: RectificationConfig = {
        ...escalationConfig,
        rethinkAtAttempt: 99,
        urgencyAtAttempt: 99,
      };
      const promptAttempt3 = createRectificationPrompt(mockFailures, mockStory, highThresholdConfig, 3);
      expect(promptAttempt3).not.toContain("Previous Attempt Did Not Fix");

      const promptAttempt4 = createRectificationPrompt(mockFailures, mockStory, highThresholdConfig, 4);
      expect(promptAttempt4).toContain("Previous Attempt Did Not Fix");
      expect(promptAttempt4).toContain("Final Rectification Attempt"); // urgency also clamped to 4
    });

    test("default urgencyAtAttempt=3 fires on final attempt when maxRetries=2", () => {
      // Key regression: with default maxRetries=2, urgencyAtAttempt=3 was dead — clamping fixes this
      const defaultMaxConfig: RectificationConfig = {
        ...escalationConfig,
        maxRetries: 2,
        rethinkAtAttempt: 2,
        urgencyAtAttempt: 3, // > maxRetries=2 → clamped to 2
      };
      const prompt = createRectificationPrompt(mockFailures, mockStory, defaultMaxConfig, 2);
      expect(prompt).toContain("Previous Attempt Did Not Fix");
      expect(prompt).toContain("Final Rectification Attempt"); // urgency fires because clamped to 2
    });

    test("rethink but no urgency when urgencyAtAttempt > attempt", () => {
      const lateUrgencyConfig: RectificationConfig = {
        ...escalationConfig,
        rethinkAtAttempt: 2,
        urgencyAtAttempt: 10, // effectively disabled
      };
      const prompt = createRectificationPrompt(mockFailures, mockStory, lateUrgencyConfig, 3);
      expect(prompt).toContain("Previous Attempt Did Not Fix");
      expect(prompt).not.toContain("Final Rectification Attempt");
    });

    test("core prompt structure still present when preamble is injected", () => {
      const prompt = createRectificationPrompt(mockFailures, mockStory, escalationConfig, 3);
      expect(prompt).toContain("# Rectification Required");
      expect(prompt).toContain("## Story Context");
      expect(prompt).toContain("## Test Failures");
      expect(prompt).toContain("## Instructions");
    });
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
  };

  test("should include 'Previous Rectification Attempts' section header", () => {
    const prompt = createEscalatedRectificationPrompt(
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
    const prompt = createEscalatedRectificationPrompt(
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
    const prompt = createEscalatedRectificationPrompt(
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

    const prompt = createEscalatedRectificationPrompt(
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
    const prompt = createEscalatedRectificationPrompt(
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
    const prompt = createEscalatedRectificationPrompt(
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
    const prompt = createEscalatedRectificationPrompt(
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
    const prompt = createEscalatedRectificationPrompt(
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
    };

    const manyFailures: TestFailure[] = Array.from({ length: 10 }, (_, i) => ({
      file: `test/file${i}.test.ts`,
      testName: `test ${i}`,
      error: `Error ${i}: Some long error message that takes up space`,
      stackTrace: [],
    }));

    const prompt = createEscalatedRectificationPrompt(
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

    const prompt = createEscalatedRectificationPrompt(
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
    const prompt = createEscalatedRectificationPrompt(
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
});
