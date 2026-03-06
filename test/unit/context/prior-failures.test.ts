// RE-ARCH: keep
/**
 * Unit tests for priorFailures context formatting
 *
 * Tests the formatting and injection of structured failures into agent prompt context.
 */

import { describe, expect, test } from "bun:test";
import { createPriorFailuresContext, formatPriorFailures } from "../../../src/context/elements";
import { buildContext, sortContextElements } from "../../../src/context/builder";
import type { StructuredFailure, UserStory } from "../../../src/prd";
import type { StoryContext } from "../../../src/context/types";

describe("formatPriorFailures", () => {
  test("should format a single prior failure correctly", () => {
    const failure: StructuredFailure = {
      attempt: 1,
      modelTier: "balanced",
      stage: "verify",
      summary: "Test verification failed",
      timestamp: new Date().toISOString(),
    };

    const formatted = formatPriorFailures([failure]);

    expect(formatted).toContain("## Prior Failures (Structured Context)");
    expect(formatted).toContain("### Attempt 1 — balanced");
    expect(formatted).toContain("**Stage:** verify");
    expect(formatted).toContain("**Summary:** Test verification failed");
  });

  test("should include test failure details", () => {
    const failure: StructuredFailure = {
      attempt: 1,
      modelTier: "balanced",
      stage: "verify",
      summary: "Test verification failed",
      testFailures: [
        {
          file: "test/foo.test.ts",
          testName: "should validate input",
          error: "Expected true to be false",
          stackTrace: ["at foo.ts:42:10", "at async runTest (test.ts:100:5)"],
        },
      ],
      timestamp: new Date().toISOString(),
    };

    const formatted = formatPriorFailures([failure]);

    expect(formatted).toContain("**Test Failures:**");
    expect(formatted).toContain("**File:** `test/foo.test.ts`");
    expect(formatted).toContain("**Test:** should validate input");
    expect(formatted).toContain("**Error:** Expected true to be false");
    expect(formatted).toContain("**Stack:** at foo.ts:42:10");
  });

  test("should include first stack trace line only", () => {
    const failure: StructuredFailure = {
      attempt: 1,
      modelTier: "balanced",
      stage: "verify",
      summary: "Test failed",
      testFailures: [
        {
          file: "test/example.test.ts",
          testName: "test name",
          error: "Error message",
          stackTrace: [
            "at foo.ts:10:15",
            "at bar.ts:20:10",
            "at baz.ts:30:5",
          ],
        },
      ],
      timestamp: new Date().toISOString(),
    };

    const formatted = formatPriorFailures([failure]);

    // Should contain first line
    expect(formatted).toContain("**Stack:** at foo.ts:10:15");
    // Should NOT contain other lines as separate stack entries
    expect(formatted.split("**Stack:**").length).toBe(2); // Header + 1 stack trace
  });

  test("should handle multiple test failures in single attempt", () => {
    const failure: StructuredFailure = {
      attempt: 1,
      modelTier: "balanced",
      stage: "verify",
      summary: "Multiple tests failed",
      testFailures: [
        {
          file: "test/foo.test.ts",
          testName: "test 1",
          error: "Error 1",
          stackTrace: ["at foo.ts:10"],
        },
        {
          file: "test/bar.test.ts",
          testName: "test 2",
          error: "Error 2",
          stackTrace: ["at bar.ts:20"],
        },
      ],
      timestamp: new Date().toISOString(),
    };

    const formatted = formatPriorFailures([failure]);

    expect(formatted).toContain("`test/foo.test.ts`");
    expect(formatted).toContain("`test/bar.test.ts`");
    expect(formatted).toContain("test 1");
    expect(formatted).toContain("test 2");
  });

  test("should handle multiple prior failures (escalation history)", () => {
    const failures: StructuredFailure[] = [
      {
        attempt: 1,
        modelTier: "fast",
        stage: "verify",
        summary: "Failed on fast tier",
        timestamp: new Date().toISOString(),
      },
      {
        attempt: 2,
        modelTier: "balanced",
        stage: "escalation",
        summary: "Escalated to balanced tier",
        timestamp: new Date().toISOString(),
      },
    ];

    const formatted = formatPriorFailures(failures);

    expect(formatted).toContain("### Attempt 1 — fast");
    expect(formatted).toContain("### Attempt 2 — balanced");
    expect(formatted).toContain("**Stage:** verify");
    expect(formatted).toContain("**Stage:** escalation");
  });

  test("should return empty string for empty failures array", () => {
    const formatted = formatPriorFailures([]);
    expect(formatted).toBe("");
  });

  test("should return empty string for null failures", () => {
    const formatted = formatPriorFailures(null as any);
    expect(formatted).toBe("");
  });

  test("should handle test failures with empty stack trace", () => {
    const failure: StructuredFailure = {
      attempt: 1,
      modelTier: "balanced",
      stage: "verify",
      summary: "Test failed",
      testFailures: [
        {
          file: "test/example.test.ts",
          testName: "test",
          error: "Error",
          stackTrace: [],
        },
      ],
      timestamp: new Date().toISOString(),
    };

    const formatted = formatPriorFailures([failure]);

    expect(formatted).toContain("**File:** `test/example.test.ts`");
    expect(formatted).toContain("**Test:** test");
    // Should not crash or include undefined stack
    expect(formatted).not.toContain("undefined");
  });
});

describe("createPriorFailuresContext", () => {
  test("should create context element with correct type", () => {
    const failure: StructuredFailure = {
      attempt: 1,
      modelTier: "balanced",
      stage: "verify",
      summary: "Test failed",
      timestamp: new Date().toISOString(),
    };

    const element = createPriorFailuresContext([failure], 95);

    expect(element.type).toBe("prior-failures");
    expect(element.priority).toBe(95);
  });

  test("should estimate tokens correctly", () => {
    const failure: StructuredFailure = {
      attempt: 1,
      modelTier: "balanced",
      stage: "verify",
      summary: "Test failed",
      timestamp: new Date().toISOString(),
    };

    const element = createPriorFailuresContext([failure], 95);

    expect(element.tokens).toBeGreaterThan(0);
    expect(typeof element.tokens).toBe("number");
  });

  test("should not create element for empty failures array", () => {
    const element = createPriorFailuresContext([], 95);

    // Element should still be created but content should be empty
    expect(element.type).toBe("prior-failures");
    expect(element.content).toBe("");
  });

  test("should include all failure content in element", () => {
    const failures: StructuredFailure[] = [
      {
        attempt: 1,
        modelTier: "balanced",
        stage: "verify",
        summary: "First failure",
        testFailures: [
          {
            file: "test/foo.test.ts",
            testName: "test 1",
            error: "Error 1",
            stackTrace: ["at foo.ts:10"],
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ];

    const element = createPriorFailuresContext(failures, 95);

    expect(element.content).toContain("### Attempt 1 — balanced");
    expect(element.content).toContain("test/foo.test.ts");
  });
});

describe("buildContext with priorFailures", () => {
  test("should inject priorFailures with priority 95", async () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test Story",
      description: "A test story",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "in-progress",
      passes: false,
      escalations: [],
      attempts: 1,
      priorFailures: [
        {
          attempt: 1,
          modelTier: "balanced",
          stage: "verify",
          summary: "Test failed",
          timestamp: new Date().toISOString(),
        },
      ],
    };

    const prd = {
      project: "test",
      feature: "test-feature",
      branchName: "test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [story],
    };

    const storyContext: StoryContext = {
      prd,
      currentStoryId: "US-001",
    };

    const budget = {
      maxTokens: 10000,
      reservedForInstructions: 2000,
      availableForContext: 8000,
    };

    const built = await buildContext(storyContext, budget);

    const priorFailuresElement = built.elements.find((e) => e.type === "prior-failures");
    expect(priorFailuresElement).toBeDefined();
    expect(priorFailuresElement?.priority).toBe(95);
  });

  test("should order priorFailures (95) before priorErrors (90)", async () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test Story",
      description: "A test story",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "in-progress",
      passes: false,
      escalations: [],
      attempts: 1,
      priorFailures: [
        {
          attempt: 1,
          modelTier: "balanced",
          stage: "verify",
          summary: "Structured failure",
          timestamp: new Date().toISOString(),
        },
      ],
      priorErrors: ["Previous error message"],
    };

    const prd = {
      project: "test",
      feature: "test-feature",
      branchName: "test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [story],
    };

    const storyContext: StoryContext = {
      prd,
      currentStoryId: "US-001",
    };

    const budget = {
      maxTokens: 10000,
      reservedForInstructions: 2000,
      availableForContext: 8000,
    };

    const built = await buildContext(storyContext, budget);

    // Find the priorFailures and priorErrors elements
    const priorFailuresIdx = built.elements.findIndex((e) => e.type === "prior-failures");
    const errorIdx = built.elements.findIndex((e) => e.type === "error");

    // priorFailures should come before error in the sorted list
    expect(priorFailuresIdx).toBeLessThan(errorIdx);
  });

  test("should not inject priorFailures if empty", async () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test Story",
      description: "A test story",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "in-progress",
      passes: false,
      escalations: [],
      attempts: 1,
      priorFailures: [],
    };

    const prd = {
      project: "test",
      feature: "test-feature",
      branchName: "test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [story],
    };

    const storyContext: StoryContext = {
      prd,
      currentStoryId: "US-001",
    };

    const budget = {
      maxTokens: 10000,
      reservedForInstructions: 2000,
      availableForContext: 8000,
    };

    const built = await buildContext(storyContext, budget);

    const priorFailuresElement = built.elements.find((e) => e.type === "prior-failures");
    expect(priorFailuresElement).toBeUndefined();
  });

  test("should not inject priorFailures if undefined", async () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test Story",
      description: "A test story",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "in-progress",
      passes: false,
      escalations: [],
      attempts: 1,
    };

    const prd = {
      project: "test",
      feature: "test-feature",
      branchName: "test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [story],
    };

    const storyContext: StoryContext = {
      prd,
      currentStoryId: "US-001",
    };

    const budget = {
      maxTokens: 10000,
      reservedForInstructions: 2000,
      availableForContext: 8000,
    };

    const built = await buildContext(storyContext, budget);

    const priorFailuresElement = built.elements.find((e) => e.type === "prior-failures");
    expect(priorFailuresElement).toBeUndefined();
  });
});

describe("Priority ordering", () => {
  test("should sort priorFailures higher than priorErrors", () => {
    const elements = [
      { type: "error", content: "Error", priority: 90, tokens: 10 },
      { type: "prior-failures", content: "Failures", priority: 95, tokens: 10 },
      { type: "story", content: "Story", priority: 80, tokens: 10 },
    ];

    const sorted = sortContextElements(elements);

    // priorFailures (95) should come first
    expect(sorted[0].type).toBe("prior-failures");
    // error (90) should come second
    expect(sorted[1].type).toBe("error");
    // story (80) should come last
    expect(sorted[2].type).toBe("story");
  });

  test("should prioritize progress (100) > priorFailures (95) > priorErrors (90)", () => {
    const elements = [
      { type: "error", content: "Error", priority: 90, tokens: 10 },
      { type: "prior-failures", content: "Failures", priority: 95, tokens: 10 },
      { type: "progress", content: "Progress", priority: 100, tokens: 10 },
    ];

    const sorted = sortContextElements(elements);

    expect(sorted[0].priority).toBe(100); // progress
    expect(sorted[1].priority).toBe(95); // prior-failures
    expect(sorted[2].priority).toBe(90); // error
  });
});
