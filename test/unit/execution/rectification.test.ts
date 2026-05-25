// RE-ARCH: keep
/**
 * Unit tests for rectification core logic (v0.11)
 */

import { describe, expect, test } from "bun:test";
import type { RectificationConfig } from "../../../src/config";
import { RectifierPromptBuilder } from "../../../src/prompts";
import { type RectificationState, shouldRetryRectification } from "../../../src/verification/rectification";
import type { TestFailure } from "../../../src/test-runners";
import type { UserStory } from "../../../src/prd";

describe("shouldRetryRectification", () => {
  const baseConfig: RectificationConfig = {
    enabled: true,
    maxAttemptsTotal: 2,
    maxAttemptsPerStrategy: 3,
    fullSuiteTimeoutSeconds: 120,
    maxFailureSummaryChars: 2000,
    abortOnIncreasingFailures: true,
    escalateOnExhaustion: true,
    rethinkAtAttempt: 2,
    urgencyAtAttempt: 3,
  };

  test("returns true when attempt < maxRetries and failures exist, decreased, stable, or increased with abort=false", () => {
    const trueScenarios: Array<{ state: RectificationState; config: RectificationConfig; label: string }> = [
      { state: { attempt: 0, initialFailures: 5, currentFailures: 3 }, config: baseConfig, label: "attempt 0, failures decreasing" },
      { state: { attempt: 1, initialFailures: 5, currentFailures: 2 }, config: baseConfig, label: "attempt 1, progress" },
      { state: { attempt: 1, initialFailures: 5, currentFailures: 5 }, config: baseConfig, label: "attempt 1, failures same" },
      { state: { attempt: 1, initialFailures: 3, currentFailures: 5 }, config: { ...baseConfig, abortOnIncreasingFailures: false }, label: "increased but abort=false" },
    ];
    for (const { state, config, label } of trueScenarios) {
      expect(shouldRetryRectification(state, config), label).toBe(true);
    }
  });

  test("returns false when attempt >= maxRetries, no failures, increasing failures with abort=true, or maxRetries=0", () => {
    const falseScenarios: Array<{ state: RectificationState; config: RectificationConfig; label: string }> = [
      { state: { attempt: 2, initialFailures: 5, currentFailures: 3 }, config: baseConfig, label: "attempt >= maxRetries" },
      { state: { attempt: 0, initialFailures: 5, currentFailures: 0 }, config: baseConfig, label: "currentFailures = 0" },
      { state: { attempt: 1, initialFailures: 3, currentFailures: 5 }, config: baseConfig, label: "failures increased with abort=true" },
      { state: { attempt: 2, initialFailures: 5, currentFailures: 1 }, config: baseConfig, label: "at maxRetries even if failures exist" },
      { state: { attempt: 0, initialFailures: 5, currentFailures: 5 }, config: { ...baseConfig, maxAttemptsTotal: 0 }, label: "maxAttemptsTotal=0" },
    ];
    for (const { state, config, label } of falseScenarios) {
      expect(shouldRetryRectification(state, config), label).toBe(false);
    }
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
    maxAttemptsTotal: 2,
    maxAttemptsPerStrategy: 3,
    fullSuiteTimeoutSeconds: 120,
    maxFailureSummaryChars: 2000,
    abortOnIncreasingFailures: true,
    escalateOnExhaustion: true,
    rethinkAtAttempt: 2,
    urgencyAtAttempt: 3,
  };

  test("includes 'Previous Rectification Attempts' header, prior attempt count, and original tier", () => {
    const prompt = RectifierPromptBuilder.escalated(mockFailures, mockStory, 2, "balanced", "powerful", baseConfig);
    expect(prompt).toContain("Previous Rectification Attempts");
    expect(prompt).toMatch(/(?:prior|previous).*:.*2/i);
    expect(prompt).toContain("balanced");
  });

  test("lists all test names when failures <= 10; includes first 10 and 'and N more' when failures > 10; handles exactly 10 without 'and N more'", () => {
    // <= 10 failures: all test names listed
    const prompt = RectifierPromptBuilder.escalated(mockFailures, mockStory, 1, "fast", "balanced", baseConfig);
    expect(prompt).toContain("login > should return JWT on valid credentials");
    expect(prompt).toContain("JWT middleware > should reject invalid tokens");

    // > 10 failures: first 10 + "and N more"
    const manyFailures: TestFailure[] = Array.from({ length: 15 }, (_, i) => ({
      file: `test/file${i}.test.ts`,
      testName: `test ${i}`,
      error: `Error ${i}`,
      stackTrace: [],
    }));
    const promptMany = RectifierPromptBuilder.escalated(manyFailures, mockStory, 2, "balanced", "powerful", baseConfig);
    for (let i = 0; i < 10; i++) {
      expect(promptMany).toContain(`test ${i}`);
    }
    expect(promptMany).toContain("and 5 more");

    // Exactly 10 failures: no "and N more"
    const tenFailures: TestFailure[] = Array.from({ length: 10 }, (_, i) => ({
      file: `test/file${i}.test.ts`,
      testName: `test ${i}`,
      error: `Error ${i}`,
      stackTrace: [],
    }));
    const promptTen = RectifierPromptBuilder.escalated(tenFailures, mockStory, 1, "balanced", "powerful", baseConfig);
    for (let i = 0; i < 10; i++) {
      expect(promptTen).toContain(`test ${i}`);
    }
    expect(promptTen).not.toMatch(/and \d+ more/);
  });

  test("includes escalation direction (source and target tiers) for both fast→balanced and balanced→powerful", () => {
    const prompt1 = RectifierPromptBuilder.escalated(mockFailures, mockStory, 2, "balanced", "powerful", baseConfig);
    expect(prompt1).toContain("balanced");
    expect(prompt1).toContain("powerful");
    expect(prompt1.toLowerCase()).toMatch(/escalat/);

    const prompt2 = RectifierPromptBuilder.escalated(mockFailures, mockStory, 1, "fast", "balanced", baseConfig);
    expect(prompt2).toContain("fast");
    expect(prompt2).toContain("balanced");
  });

  test("includes story context (title, description, acceptance criteria) and failure summary", () => {
    const prompt = RectifierPromptBuilder.escalated(mockFailures, mockStory, 1, "balanced", "powerful", baseConfig);
    expect(prompt).toContain("Add user authentication");
    expect(prompt).toContain("Implement JWT-based authentication for API endpoints");
    expect(prompt).toContain("Users can log in with email/password");
    expect(prompt).toContain("test/auth.test.ts");
    expect(prompt).toContain("Expected status 200, got 401");
  });

  test("respects maxFailureSummaryChars config and includes agent instructions", () => {
    const smallConfig: RectificationConfig = {
      ...baseConfig,
      maxFailureSummaryChars: 100,
    };
    const manyFailures: TestFailure[] = Array.from({ length: 10 }, (_, i) => ({
      file: `test/file${i}.test.ts`,
      testName: `test ${i}`,
      error: `Error ${i}: Some long error message that takes up space`,
      stackTrace: [],
    }));
    const prompt = RectifierPromptBuilder.escalated(manyFailures, mockStory, 1, "balanced", "powerful", smallConfig);
    expect(prompt).toMatch(/truncated/i);

    const promptInstr = RectifierPromptBuilder.escalated(mockFailures, mockStory, 1, "balanced", "powerful", baseConfig);
    expect(promptInstr.toLowerCase()).toMatch(/fix|implement|correct/);
  });

  test("uses configured testCommand in NEVER run filter; neutral instruction when no testCommand provided", () => {
    const promptWithCmd = RectifierPromptBuilder.escalated(mockFailures, mockStory, 1, "balanced", "powerful", baseConfig, "jest");
    expect(promptWithCmd).toContain("NEVER run `jest` without a file filter");
    expect(promptWithCmd).not.toContain("NEVER run `bun test`");

    const promptGoCmd = RectifierPromptBuilder.escalated(mockFailures, mockStory, 1, "balanced", "powerful", baseConfig, "go test");
    expect(promptGoCmd).toContain("NEVER run `go test` without a file filter");

    const promptNoCmd = RectifierPromptBuilder.escalated(mockFailures, mockStory, 1, "balanced", "powerful", baseConfig);
    expect(promptNoCmd).toContain("never run the full test suite without a file filter");
    expect(promptNoCmd).not.toContain("bun test");
  });
});
