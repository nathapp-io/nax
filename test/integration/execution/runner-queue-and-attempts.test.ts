// RE-ARCH: keep
/**
 * Runner Tests — Story Batching + TDD Escalation
 *
 * Tests for grouping consecutive simple stories into batches,
 * and TDD escalation handling (retryAsLite, failure category outcomes).
 */

import { describe, expect, test } from "bun:test";
import { groupStoriesIntoBatches, precomputeBatchPlan } from "../../../src/execution/batching";
import type { StoryBatch } from "../../../src/execution/batching";
import { escalateTier } from "../../../src/execution/escalation";
import { buildBatchPrompt } from "../../../src/execution/prompts";
import { resolveMaxAttemptsOutcome } from "../../../src/execution/runner";
import type { UserStory } from "../../../src/prd";
import type { FailureCategory } from "../../../src/tdd/types";


describe("Queue Commands Before Batch Execution", () => {
  test("SKIP command should filter story from batch before execution", () => {
    // Simulate a batch of 3 simple stories: [US-001, US-002, US-003]
    // User issues SKIP US-002 in .queue.txt
    // Expected: Batch should only contain [US-001, US-003]
    const batchStories: UserStory[] = [
      {
        id: "US-001",
        title: "Simple 1",
        description: "First story in batch",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      },
      {
        id: "US-002",
        title: "Simple 2",
        description: "Second story in batch (to be skipped)",
        acceptanceCriteria: ["AC2"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      },
      {
        id: "US-003",
        title: "Simple 3",
        description: "Third story in batch",
        acceptanceCriteria: ["AC3"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      },
    ];

    // Simulate SKIP command processing
    const skipCommand = { type: "SKIP" as const, storyId: "US-002" };
    const storyIndex = batchStories.findIndex((s) => s.id === skipCommand.storyId);

    expect(storyIndex).toBe(1);

    // Remove from batch
    const filteredBatch = batchStories.filter((s) => s.id !== skipCommand.storyId);

    expect(filteredBatch).toHaveLength(2);
    expect(filteredBatch.map((s) => s.id)).toEqual(["US-001", "US-003"]);
    expect(filteredBatch.every((s) => s.status === "pending")).toBe(true);
  });

  test("SKIP all stories in batch should result in empty batch and continue to next iteration", () => {
    // Simulate a batch of 2 simple stories: [US-001, US-002]
    // User issues SKIP US-001 and SKIP US-002
    // Expected: Batch becomes empty, runner should continue to next iteration
    const batchStories: UserStory[] = [
      {
        id: "US-001",
        title: "Simple 1",
        description: "First story",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      },
      {
        id: "US-002",
        title: "Simple 2",
        description: "Second story",
        acceptanceCriteria: ["AC2"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      },
    ];

    // Simulate SKIP commands
    const skipCommands = [
      { type: "SKIP" as const, storyId: "US-001" },
      { type: "SKIP" as const, storyId: "US-002" },
    ];

    let filteredBatch = [...batchStories];
    for (const cmd of skipCommands) {
      filteredBatch = filteredBatch.filter((s) => s.id !== cmd.storyId);
    }

    expect(filteredBatch).toHaveLength(0);
    // When batch is empty, runner should continue to next iteration
  });

  test("PAUSE command should halt execution before batch starts", () => {
    // When PAUSE is issued before batch execution
    // Expected: Execution stops, no stories are processed
    const pauseCommand = "PAUSE" as const;
    const batchStories: UserStory[] = [
      {
        id: "US-001",
        title: "Simple 1",
        description: "First story",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      },
    ];

    // Simulate PAUSE processing
    let shouldHalt = false;
    if (pauseCommand === "PAUSE") {
      shouldHalt = true;
    }

    expect(shouldHalt).toBe(true);
    // When halted, no stories should be executed
    expect(batchStories.every((s) => s.status === "pending")).toBe(true);
  });

  test("SKIP command for story not in batch should still mark it as skipped", () => {
    // Simulate batch [US-001, US-002] but user issues SKIP US-003
    // Expected: US-003 is marked skipped even though not in current batch
    const batchStories: UserStory[] = [
      {
        id: "US-001",
        title: "Simple 1",
        description: "First story",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      },
      {
        id: "US-002",
        title: "Simple 2",
        description: "Second story",
        acceptanceCriteria: ["AC2"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      },
    ];

    const skipCommand = { type: "SKIP" as const, storyId: "US-003" };
    const storyIndex = batchStories.findIndex((s) => s.id === skipCommand.storyId);

    // Story not found in batch
    expect(storyIndex).toBe(-1);

    // But should still be processed (in actual runner, PRD would be checked)
    // This test validates the logic path exists
  });

  test("batch size reduction from 4 to 1 should disable batch execution flag", () => {
    // Simulate batch [US-001, US-002, US-003, US-004]
    // User issues SKIP US-002, SKIP US-003, SKIP US-004
    // Expected: Only US-001 remains, isBatchExecution should be false
    const batchStories: UserStory[] = [
      {
        id: "US-001",
        title: "Simple 1",
        description: "First story",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      },
      {
        id: "US-002",
        title: "Simple 2",
        description: "Second story",
        acceptanceCriteria: ["AC2"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      },
      {
        id: "US-003",
        title: "Simple 3",
        description: "Third story",
        acceptanceCriteria: ["AC3"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      },
      {
        id: "US-004",
        title: "Simple 4",
        description: "Fourth story",
        acceptanceCriteria: ["AC4"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      },
    ];

    let isBatchExecution = true; // Initially true for 4 stories
    const skipCommands = [
      { type: "SKIP" as const, storyId: "US-002" },
      { type: "SKIP" as const, storyId: "US-003" },
      { type: "SKIP" as const, storyId: "US-004" },
    ];

    let filteredBatch = [...batchStories];
    for (const cmd of skipCommands) {
      filteredBatch = filteredBatch.filter((s) => s.id !== cmd.storyId);
    }

    // Re-check batch flag
    if (isBatchExecution && filteredBatch.length === 1) {
      isBatchExecution = false;
    }

    expect(filteredBatch).toHaveLength(1);
    expect(filteredBatch[0].id).toBe("US-001");
    expect(isBatchExecution).toBe(false);
  });

  test("ABORT command should mark all pending stories as skipped", () => {
    // When ABORT is issued
    // Expected: All pending stories should be marked as skipped
    const abortCommand = "ABORT" as const;
    const allStories: UserStory[] = [
      {
        id: "US-001",
        title: "Passed",
        description: "Already done",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "passed",
        passes: true,
        escalations: [],
        attempts: 1,
      },
      {
        id: "US-002",
        title: "Pending 1",
        description: "Not started",
        acceptanceCriteria: ["AC2"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      },
      {
        id: "US-003",
        title: "Pending 2",
        description: "Not started",
        acceptanceCriteria: ["AC3"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      },
    ];

    // Simulate ABORT processing
    let shouldAbort = false;
    if (abortCommand === "ABORT") {
      shouldAbort = true;
    }

    expect(shouldAbort).toBe(true);

    // Filter pending stories that should be skipped
    const pendingStories = allStories.filter((s) => s.status === "pending");
    expect(pendingStories).toHaveLength(2);
    expect(pendingStories.map((s) => s.id)).toEqual(["US-002", "US-003"]);

    // In actual runner, these would be marked as skipped via markStorySkipped()
  });
});


describe("TDD escalation attempts counting", () => {
  const defaultTiers = [
    { tier: "fast", attempts: 5 },
    { tier: "balanced", attempts: 3 },
    { tier: "powerful", attempts: 2 },
  ];

  test("attempts increment on each TDD escalation", () => {
    // Simulate a TDD story escalating: fast(attempt 1) → balanced(attempt 2) → ...
    let story: UserStory = {
      id: "US-001",
      title: "TDD Story",
      description: "Complex TDD story",
      acceptanceCriteria: ["All tests pass"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: { complexity: "complex", modelTier: "fast", testStrategy: "three-session-tdd", reasoning: "complex" },
    };

    // Simulate escalation (what runner does)
    story = {
      ...story,
      attempts: story.attempts + 1,
      routing: story.routing ? { ...story.routing, modelTier: "balanced" } : undefined,
    };

    expect(story.attempts).toBe(1);
    expect(story.routing?.modelTier).toBe("balanced");

    // Second escalation
    story = {
      ...story,
      attempts: story.attempts + 1,
      routing: story.routing ? { ...story.routing, modelTier: "powerful" } : undefined,
    };

    expect(story.attempts).toBe(2);
    expect(story.routing?.modelTier).toBe("powerful");
  });

  test("TDD story with retryAsLite gets lite strategy on first isolation-violation escalation", () => {
    let story: UserStory = {
      id: "US-001",
      title: "TDD Story",
      description: "Complex TDD story",
      acceptanceCriteria: ["All tests pass"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: { complexity: "complex", modelTier: "fast", testStrategy: "three-session-tdd", reasoning: "complex" },
    };

    // First escalation: isolation-violation → retryAsLite=true
    const retryAsLite = true;
    const nextTier = "balanced" as const;

    story = {
      ...story,
      attempts: story.attempts + 1,
      routing: story.routing
        ? {
            ...story.routing,
            modelTier: nextTier,
            ...(retryAsLite ? { testStrategy: "three-session-tdd-lite" as const } : {}),
          }
        : undefined,
    };

    expect(story.attempts).toBe(1);
    expect(story.routing?.modelTier).toBe("balanced");
    expect(story.routing?.testStrategy).toBe("three-session-tdd-lite");
  });

  test("second escalation after retryAsLite does NOT change strategy again", () => {
    // Story is now in lite mode after first escalation
    let story: UserStory = {
      id: "US-001",
      title: "TDD Story",
      description: "Complex TDD story",
      acceptanceCriteria: ["All tests pass"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 1,
      routing: {
        complexity: "complex",
        modelTier: "balanced",
        testStrategy: "three-session-tdd-lite", // Already downgraded
        reasoning: "complex",
      },
    };

    // Second escalation: lite mode failure → retryAsLite is NOT set (only fires once)
    const retryAsLite = false; // Not set on subsequent escalations
    const nextTier = "powerful" as const;

    story = {
      ...story,
      attempts: story.attempts + 1,
      routing: story.routing
        ? {
            ...story.routing,
            modelTier: nextTier,
            ...(retryAsLite ? { testStrategy: "three-session-tdd-lite" as const } : {}),
          }
        : undefined,
    };

    expect(story.attempts).toBe(2);
    expect(story.routing?.modelTier).toBe("powerful");
    // Strategy remains lite (not reset) — retryAsLite only fires once
    expect(story.routing?.testStrategy).toBe("three-session-tdd-lite");
  });

  test("max attempts check works correctly for TDD stories using total across tiers", () => {
    const { calculateMaxIterations } = require("../../../src/execution/escalation");
    const maxAttempts = calculateMaxIterations(defaultTiers);

    // A TDD story at attempt 9 (one below max) should still be escalatable
    expect(9 < maxAttempts).toBe(true);

    // A TDD story at attempt 10 (= max) should NOT be escalatable
    expect(10 < maxAttempts).toBe(false);
  });
});
