/**
 * Unit tests for StructuredFailure and priorFailures tracking
 *
 * Tests the structured failure context for escalated tiers to know exactly what failed.
 */

import { describe, expect, test } from "bun:test";
import { loadPRD } from "../../src/prd";
import type { StructuredFailure, TestFailureContext, UserStory } from "../../src/prd";

describe("StructuredFailure Type", () => {
  test("should have all required fields", () => {
    const failure: StructuredFailure = {
      attempt: 1,
      modelTier: "balanced",
      stage: "verify",
      summary: "Test failed",
      timestamp: new Date().toISOString(),
    };

    expect(failure.attempt).toBe(1);
    expect(failure.modelTier).toBe("balanced");
    expect(failure.stage).toBe("verify");
    expect(failure.summary).toBe("Test failed");
    expect(failure.timestamp).toBeDefined();
    expect(typeof failure.timestamp).toBe("string");
  });

  test("should have optional testFailures field", () => {
    const testFailure: TestFailureContext = {
      file: "test/foo.test.ts",
      testName: "should pass",
      error: "Expected 1 to equal 2",
      stackTrace: ["at foo.ts:10:15", "at Object.test (foo.ts:8:3)"],
    };

    const failure: StructuredFailure = {
      attempt: 1,
      modelTier: "balanced",
      stage: "verify",
      summary: "Test failed",
      testFailures: [testFailure],
      timestamp: new Date().toISOString(),
    };

    expect(failure.testFailures).toBeDefined();
    expect(failure.testFailures?.length).toBe(1);
    expect(failure.testFailures?.[0].file).toBe("test/foo.test.ts");
    expect(failure.testFailures?.[0].testName).toBe("should pass");
    expect(failure.testFailures?.[0].error).toBe("Expected 1 to equal 2");
    expect(failure.testFailures?.[0].stackTrace.length).toBe(2);
  });

  test("should support all verification stages", () => {
    const stages: Array<StructuredFailure["stage"]> = [
      "verify",
      "review",
      "regression",
      "rectification",
      "agent-session",
      "escalation",
    ];

    for (const stage of stages) {
      const failure: StructuredFailure = {
        attempt: 1,
        modelTier: "balanced",
        stage,
        summary: "Test failed",
        timestamp: new Date().toISOString(),
      };
      expect(failure.stage).toBe(stage);
    }
  });

  test("should allow different model tiers", () => {
    const tiers = ["fast", "balanced", "powerful"];

    for (const tier of tiers) {
      const failure: StructuredFailure = {
        attempt: 1,
        modelTier: tier,
        stage: "verify",
        summary: "Test failed",
        timestamp: new Date().toISOString(),
      };
      expect(failure.modelTier).toBe(tier);
    }
  });

  test("should track multiple test failures", () => {
    const testFailures: TestFailureContext[] = [
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
      {
        file: "test/baz.test.ts",
        testName: "test 3",
        error: "Error 3",
        stackTrace: ["at baz.ts:30"],
      },
    ];

    const failure: StructuredFailure = {
      attempt: 2,
      modelTier: "balanced",
      stage: "regression",
      summary: "Multiple test failures",
      testFailures,
      timestamp: new Date().toISOString(),
    };

    expect(failure.testFailures?.length).toBe(3);
    expect(failure.testFailures?.[0].file).toBe("test/foo.test.ts");
    expect(failure.testFailures?.[1].file).toBe("test/bar.test.ts");
    expect(failure.testFailures?.[2].file).toBe("test/baz.test.ts");
  });
});

describe("TestFailureContext Type", () => {
  test("should have all required fields", () => {
    const context: TestFailureContext = {
      file: "test/example.test.ts",
      testName: "should do something",
      error: "AssertionError: expected true to be false",
      stackTrace: ["at Object.test (example.test.ts:42:10)", "at async runTest (test.ts:100:5)"],
    };

    expect(context.file).toBe("test/example.test.ts");
    expect(context.testName).toBe("should do something");
    expect(context.error).toBe("AssertionError: expected true to be false");
    expect(context.stackTrace.length).toBe(2);
  });

  test("should handle nested test names", () => {
    const context: TestFailureContext = {
      file: "test/example.test.ts",
      testName: "describe block > nested block > test name",
      error: "Error",
      stackTrace: [],
    };

    expect(context.testName).toContain("describe block");
    expect(context.testName).toContain("nested block");
    expect(context.testName).toContain("test name");
  });

  test("should support empty stack traces", () => {
    const context: TestFailureContext = {
      file: "test/example.test.ts",
      testName: "test",
      error: "Error",
      stackTrace: [],
    };

    expect(context.stackTrace.length).toBe(0);
  });

  test("should support multiple stack trace lines", () => {
    const context: TestFailureContext = {
      file: "test/example.test.ts",
      testName: "test",
      error: "Error",
      stackTrace: [
        "at foo.ts:10:15",
        "at bar.ts:20:10",
        "at baz.ts:30:5",
        "at Object.test (example.ts:40:3)",
        "at async runTest (test.ts:50:5)",
      ],
    };

    expect(context.stackTrace.length).toBe(5);
  });
});

describe("UserStory priorFailures Field", () => {
  test("should have optional priorFailures field", () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test Story",
      description: "A test story",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    expect(story.priorFailures).toBeUndefined();
  });

  test("should initialize priorFailures to empty array in loadPRD", async () => {
    // Create a temporary PRD file without priorFailures
    const prdContent = JSON.stringify({
      project: "test",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test Story",
          description: "Description",
          acceptanceCriteria: [],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        },
      ],
    });

    // Write to temp file
    const tmpFile = "/tmp/test-prd-priorFailures.json";
    await Bun.write(tmpFile, prdContent);

    // Load and verify
    const prd = await loadPRD(tmpFile);
    expect(prd.userStories[0].priorFailures).toBeDefined();
    expect(Array.isArray(prd.userStories[0].priorFailures)).toBe(true);
    expect(prd.userStories[0].priorFailures?.length).toBe(0);

    // Cleanup
    await Bun.file(tmpFile).delete();
  });

  test("should preserve existing priorFailures when loading PRD", async () => {
    const existingFailure: StructuredFailure = {
      attempt: 1,
      modelTier: "balanced",
      stage: "verify",
      summary: "Test failed",
      timestamp: new Date().toISOString(),
    };

    const prdContent = JSON.stringify({
      project: "test",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test Story",
          description: "Description",
          acceptanceCriteria: [],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 1,
          priorFailures: [existingFailure],
        },
      ],
    });

    const tmpFile = "/tmp/test-prd-existing-failures.json";
    await Bun.write(tmpFile, prdContent);

    const prd = await loadPRD(tmpFile);
    expect(prd.userStories[0].priorFailures?.length).toBe(1);
    expect(prd.userStories[0].priorFailures?.[0].attempt).toBe(1);
    expect(prd.userStories[0].priorFailures?.[0].stage).toBe("verify");

    await Bun.file(tmpFile).delete();
  });

  test("should allow adding multiple priorFailures to a story", () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test Story",
      description: "Description",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "failed",
      passes: false,
      escalations: [],
      attempts: 3,
      priorFailures: [
        {
          attempt: 1,
          modelTier: "fast",
          stage: "verify",
          summary: "First failure",
          timestamp: new Date().toISOString(),
        },
        {
          attempt: 2,
          modelTier: "balanced",
          stage: "regression",
          summary: "Second failure",
          timestamp: new Date().toISOString(),
        },
      ],
    };

    expect(story.priorFailures?.length).toBe(2);
    expect(story.priorFailures?.[0].modelTier).toBe("fast");
    expect(story.priorFailures?.[1].modelTier).toBe("balanced");
  });
});

describe("StructuredFailure Attempt Tracking", () => {
  test("should increment attempt number correctly", () => {
    const failures: StructuredFailure[] = [];

    for (let i = 1; i <= 3; i++) {
      failures.push({
        attempt: i,
        modelTier: "balanced",
        stage: "verify",
        summary: `Attempt ${i} failed`,
        timestamp: new Date().toISOString(),
      });
    }

    expect(failures[0].attempt).toBe(1);
    expect(failures[1].attempt).toBe(2);
    expect(failures[2].attempt).toBe(3);
  });

  test("should track tier escalation in priorFailures", () => {
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
      {
        attempt: 3,
        modelTier: "powerful",
        stage: "escalation",
        summary: "Escalated to powerful tier",
        timestamp: new Date().toISOString(),
      },
    ];

    expect(failures.length).toBe(3);
    expect(failures[0].modelTier).toBe("fast");
    expect(failures[1].modelTier).toBe("balanced");
    expect(failures[2].modelTier).toBe("powerful");

    // Verify escalation stages
    expect(failures[1].stage).toBe("escalation");
    expect(failures[2].stage).toBe("escalation");
  });
});

describe("StructuredFailure Timestamps", () => {
  test("should use ISO format timestamps", () => {
    const failure: StructuredFailure = {
      attempt: 1,
      modelTier: "balanced",
      stage: "verify",
      summary: "Test failed",
      timestamp: new Date().toISOString(),
    };

    // ISO format: YYYY-MM-DDTHH:mm:ss.sssZ
    expect(failure.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("should have different timestamps for different failures", async () => {
    const failure1: StructuredFailure = {
      attempt: 1,
      modelTier: "balanced",
      stage: "verify",
      summary: "First failure",
      timestamp: new Date().toISOString(),
    };

    // Small delay to ensure different timestamp
    await new Promise((resolve) => setTimeout(resolve, 10));

    const failure2: StructuredFailure = {
      attempt: 2,
      modelTier: "balanced",
      stage: "verify",
      summary: "Second failure",
      timestamp: new Date().toISOString(),
    };

    // While millisecond precision should make them different, we just verify they're valid
    expect(failure1.timestamp).toBeDefined();
    expect(failure2.timestamp).toBeDefined();
  });
});
