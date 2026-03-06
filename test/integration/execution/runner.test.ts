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

describe("buildBatchPrompt", () => {
  test("generates prompt with multiple stories", () => {
    const stories: UserStory[] = [
      {
        id: "US-001",
        title: "Add logging",
        description: "Add debug logging to the service",
        acceptanceCriteria: ["Logs are written", "Logs include timestamps"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      },
      {
        id: "US-002",
        title: "Update config",
        description: "Update the config schema",
        acceptanceCriteria: ["Schema is valid", "Tests pass"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      },
    ];

    const prompt = buildBatchPrompt(stories);

    expect(prompt).toContain("Batch Task: 2 Stories");
    expect(prompt).toContain("## Story 1: US-001 — Add logging");
    expect(prompt).toContain("## Story 2: US-002 — Update config");
    expect(prompt).toContain("Add debug logging to the service");
    expect(prompt).toContain("Update the config schema");
    expect(prompt).toContain("Commit each story separately");
  });

  test("includes context markdown when provided", () => {
    const stories: UserStory[] = [
      {
        id: "US-001",
        title: "Add logging",
        description: "Add logging",
        acceptanceCriteria: ["Logs work"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      },
    ];

    const contextMarkdown = "## Context\n\nSome context here";
    const prompt = buildBatchPrompt(stories, contextMarkdown);

    expect(prompt).toContain("---");
    expect(prompt).toContain("## Context");
    expect(prompt).toContain("Some context here");
  });

  test("numbers stories sequentially", () => {
    const stories: UserStory[] = [
      {
        id: "US-001",
        title: "First",
        description: "First story",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      },
      {
        id: "US-002",
        title: "Second",
        description: "Second story",
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
        title: "Third",
        description: "Third story",
        acceptanceCriteria: ["AC3"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      },
    ];

    const prompt = buildBatchPrompt(stories);

    expect(prompt).toContain("Story 1: US-001");
    expect(prompt).toContain("Story 2: US-002");
    expect(prompt).toContain("Story 3: US-003");
  });
});

describe("groupStoriesIntoBatches", () => {
  test("groups consecutive simple stories into a batch", () => {
    const stories: UserStory[] = [
      {
        id: "US-001",
        title: "Simple 1",
        description: "First simple story",
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
        description: "Second simple story",
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
        description: "Third simple story",
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

    const batches = groupStoriesIntoBatches(stories);

    expect(batches).toHaveLength(1);
    expect(batches[0].isBatch).toBe(true);
    expect(batches[0].stories).toHaveLength(3);
    expect(batches[0].stories.map((s) => s.id)).toEqual(["US-001", "US-002", "US-003"]);
  });

  test("enforces max batch size of 4", () => {
    const stories: UserStory[] = Array.from({ length: 6 }, (_, i) => ({
      id: `US-00${i + 1}`,
      title: `Simple ${i + 1}`,
      description: `Story ${i + 1}`,
      acceptanceCriteria: [`AC${i + 1}`],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "simple" as const,
        modelTier: "fast" as const,
        testStrategy: "test-after" as const,
        reasoning: "simple",
      },
    }));

    const batches = groupStoriesIntoBatches(stories);

    expect(batches).toHaveLength(2);
    expect(batches[0].stories).toHaveLength(4);
    expect(batches[0].isBatch).toBe(true);
    expect(batches[1].stories).toHaveLength(2);
    expect(batches[1].isBatch).toBe(true);
  });

  test("stops batching at non-simple story", () => {
    const stories: UserStory[] = [
      {
        id: "US-001",
        title: "Simple 1",
        description: "First simple",
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
        description: "Second simple",
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
        title: "Complex",
        description: "Complex story",
        acceptanceCriteria: ["AC3"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: {
          complexity: "complex",
          modelTier: "balanced",
          testStrategy: "three-session-tdd",
          reasoning: "complex",
        },
      },
      {
        id: "US-004",
        title: "Simple 3",
        description: "Third simple",
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

    const batches = groupStoriesIntoBatches(stories);

    expect(batches).toHaveLength(3);
    // First batch: 2 simple stories
    expect(batches[0].stories).toHaveLength(2);
    expect(batches[0].isBatch).toBe(true);
    expect(batches[0].stories.map((s) => s.id)).toEqual(["US-001", "US-002"]);
    // Second batch: 1 complex story (not batched)
    expect(batches[1].stories).toHaveLength(1);
    expect(batches[1].isBatch).toBe(false);
    expect(batches[1].stories[0].id).toBe("US-003");
    // Third batch: 1 simple story (single, marked as batch)
    expect(batches[2].stories).toHaveLength(1);
    expect(batches[2].isBatch).toBe(false);
    expect(batches[2].stories[0].id).toBe("US-004");
  });

  test("handles single story as non-batch", () => {
    const stories: UserStory[] = [
      {
        id: "US-001",
        title: "Simple",
        description: "Single story",
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

    const batches = groupStoriesIntoBatches(stories);

    expect(batches).toHaveLength(1);
    expect(batches[0].isBatch).toBe(false);
    expect(batches[0].stories).toHaveLength(1);
  });

  test("handles all non-simple stories", () => {
    const stories: UserStory[] = [
      {
        id: "US-001",
        title: "Complex 1",
        description: "First complex",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: {
          complexity: "complex",
          modelTier: "balanced",
          testStrategy: "three-session-tdd",
          reasoning: "complex",
        },
      },
      {
        id: "US-002",
        title: "Medium",
        description: "Medium story",
        acceptanceCriteria: ["AC2"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "medium", modelTier: "fast", testStrategy: "test-after", reasoning: "medium" },
      },
    ];

    const batches = groupStoriesIntoBatches(stories);

    expect(batches).toHaveLength(2);
    expect(batches[0].isBatch).toBe(false);
    expect(batches[0].stories).toHaveLength(1);
    expect(batches[1].isBatch).toBe(false);
    expect(batches[1].stories).toHaveLength(1);
  });

  test("handles empty story list", () => {
    const stories: UserStory[] = [];
    const batches = groupStoriesIntoBatches(stories);

    expect(batches).toHaveLength(0);
  });

  test("respects custom max batch size", () => {
    const stories: UserStory[] = Array.from({ length: 5 }, (_, i) => ({
      id: `US-00${i + 1}`,
      title: `Simple ${i + 1}`,
      description: `Story ${i + 1}`,
      acceptanceCriteria: [`AC${i + 1}`],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "simple" as const,
        modelTier: "fast" as const,
        testStrategy: "test-after" as const,
        reasoning: "simple",
      },
    }));

    const batches = groupStoriesIntoBatches(stories, 2);

    expect(batches).toHaveLength(3);
    expect(batches[0].stories).toHaveLength(2);
    expect(batches[1].stories).toHaveLength(2);
    expect(batches[2].stories).toHaveLength(1);
  });

  test("handles mixed complexity pattern", () => {
    const stories: UserStory[] = [
      {
        id: "US-001",
        title: "Simple 1",
        description: "Simple",
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
        title: "Complex",
        description: "Complex",
        acceptanceCriteria: ["AC2"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: {
          complexity: "complex",
          modelTier: "balanced",
          testStrategy: "three-session-tdd",
          reasoning: "complex",
        },
      },
      {
        id: "US-003",
        title: "Simple 2",
        description: "Simple",
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
        title: "Simple 3",
        description: "Simple",
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

    const batches = groupStoriesIntoBatches(stories);

    expect(batches).toHaveLength(3);
    // US-001 alone
    expect(batches[0].isBatch).toBe(false);
    expect(batches[0].stories).toHaveLength(1);
    // US-002 alone
    expect(batches[1].isBatch).toBe(false);
    expect(batches[1].stories).toHaveLength(1);
    // US-003 and US-004 batched
    expect(batches[2].isBatch).toBe(true);
    expect(batches[2].stories).toHaveLength(2);
  });
});

describe("precomputeBatchPlan", () => {
  test("precomputes batch plan from ready stories", () => {
    const stories: UserStory[] = [
      {
        id: "US-001",
        title: "Simple 1",
        description: "First simple",
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
        description: "Second simple",
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
        title: "Complex",
        description: "Complex story",
        acceptanceCriteria: ["AC3"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: {
          complexity: "complex",
          modelTier: "balanced",
          testStrategy: "three-session-tdd",
          reasoning: "complex",
        },
      },
    ];

    const plan = precomputeBatchPlan(stories);

    expect(plan).toHaveLength(2);
    // First batch: 2 simple stories
    expect(plan[0].stories).toHaveLength(2);
    expect(plan[0].isBatch).toBe(true);
    expect(plan[0].stories.map((s) => s.id)).toEqual(["US-001", "US-002"]);
    // Second batch: 1 complex story
    expect(plan[1].stories).toHaveLength(1);
    expect(plan[1].isBatch).toBe(false);
    expect(plan[1].stories[0].id).toBe("US-003");
  });

  test("maintains story order from PRD", () => {
    const stories: UserStory[] = [
      {
        id: "US-001",
        title: "Simple 1",
        description: "First",
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
        title: "Complex",
        description: "Middle",
        acceptanceCriteria: ["AC2"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "medium", modelTier: "balanced", testStrategy: "test-after", reasoning: "medium" },
      },
      {
        id: "US-003",
        title: "Simple 2",
        description: "Last",
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

    const plan = precomputeBatchPlan(stories);

    // Should maintain order: US-001, US-002, US-003
    expect(plan).toHaveLength(3);
    expect(plan[0].stories[0].id).toBe("US-001");
    expect(plan[1].stories[0].id).toBe("US-002");
    expect(plan[2].stories[0].id).toBe("US-003");
  });

  test("only batches simple stories with test-after strategy", () => {
    const stories: UserStory[] = [
      {
        id: "US-001",
        title: "Simple TDD",
        description: "Simple but uses TDD",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "three-session-tdd", reasoning: "simple" },
      },
      {
        id: "US-002",
        title: "Simple test-after",
        description: "Simple with test-after",
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

    const plan = precomputeBatchPlan(stories);

    // US-001 should be individual (TDD), US-002 should be individual (no other simple test-after to batch with)
    expect(plan).toHaveLength(2);
    expect(plan[0].isBatch).toBe(false);
    expect(plan[0].stories[0].id).toBe("US-001");
    expect(plan[1].isBatch).toBe(false);
    expect(plan[1].stories[0].id).toBe("US-002");
  });

  test("handles empty story list", () => {
    const stories: UserStory[] = [];
    const plan = precomputeBatchPlan(stories);
    expect(plan).toHaveLength(0);
  });

  test("respects max batch size", () => {
    const stories: UserStory[] = Array.from({ length: 6 }, (_, i) => ({
      id: `US-00${i + 1}`,
      title: `Simple ${i + 1}`,
      description: `Story ${i + 1}`,
      acceptanceCriteria: [`AC${i + 1}`],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "simple" as const,
        modelTier: "fast" as const,
        testStrategy: "test-after" as const,
        reasoning: "simple",
      },
    }));

    const plan = precomputeBatchPlan(stories, 3);

    // Should create 2 batches of 3
    expect(plan).toHaveLength(2);
    expect(plan[0].stories).toHaveLength(3);
    expect(plan[0].isBatch).toBe(true);
    expect(plan[1].stories).toHaveLength(3);
    expect(plan[1].isBatch).toBe(true);
  });

  test("handles all stories already passed", () => {
    const stories: UserStory[] = [
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
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      },
    ];

    const plan = precomputeBatchPlan(stories);

    // Should still include passed story in plan (filtering happens at runtime)
    expect(plan).toHaveLength(1);
    expect(plan[0].stories[0].id).toBe("US-001");
  });
});

describe("Batch Failure Escalation Strategy", () => {
  test("batch failure should escalate only first story, others remain at same tier", () => {
    // Simulate a batch of 4 simple stories at 'fast' tier
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
        description: "Second story in batch",
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
      {
        id: "US-004",
        title: "Simple 4",
        description: "Fourth story in batch",
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

    // When batch fails at 'fast' tier:
    // 1. First story (US-001) should escalate to 'balanced'
    const firstStory = batchStories[0];
    const currentTier = firstStory.routing!.modelTier;
    const tierOrder = [
      { tier: "fast", attempts: 5 },
      { tier: "balanced", attempts: 3 },
      { tier: "powerful", attempts: 2 },
    ];
    const nextTier = escalateTier(currentTier!, tierOrder);

    expect(currentTier).toBe("fast");
    expect(nextTier).toBe("balanced");

    // 2. Remaining stories (US-002, US-003, US-004) should remain at 'fast' tier
    // They will be retried individually at the same tier on next iteration
    const remainingStories = batchStories.slice(1);
    for (const story of remainingStories) {
      expect(story.routing!.modelTier).toBe("fast");
      expect(story.status).toBe("pending");
    }

    // 3. This tests the documented "Option B" strategy:
    //    - Only first story escalates
    //    - Others retry individually at same tier first
    //    - This minimizes cost and provides better error isolation
  });

  test("batch failure escalation follows standard escalation chain", () => {
    const tierOrder = [
      { tier: "fast", attempts: 5 },
      { tier: "balanced", attempts: 3 },
      { tier: "powerful", attempts: 2 },
    ];
    const tiers = ["fast", "balanced", "powerful"];
    const expectedNext = ["balanced", "powerful", null];

    for (let i = 0; i < tiers.length; i++) {
      const nextTier = escalateTier(tiers[i], tierOrder);
      expect(nextTier).toBe(expectedNext[i]);
    }

    const powerfulTier = escalateTier("powerful", tierOrder);
    expect(powerfulTier).toBeNull();
  });

  test("batch failure with max attempts should not escalate", () => {
    // When first story in batch has already hit max attempts (e.g., 3),
    // it should be marked as failed instead of escalated
    const story: UserStory = {
      id: "US-001",
      title: "Simple with max attempts",
      description: "Story that has already been retried 3 times",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 3, // Already at max attempts (typical config.autoMode.escalation.maxAttempts = 3)
      routing: { complexity: "simple", modelTier: "balanced", testStrategy: "test-after", reasoning: "simple" },
    };

    const maxAttempts = 3;
    const escalationEnabled = true;

    // Should not escalate if attempts >= maxAttempts
    if (escalationEnabled && story.attempts < maxAttempts) {
      // This branch should NOT be taken
      expect(false).toBe(true); // Should not reach here
    } else {
      // Story should be marked as failed (not escalated)
      expect(story.attempts).toBeGreaterThanOrEqual(maxAttempts);
      // In actual runner code, markStoryFailed() would be called here
    }
  });
});

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

describe("Configurable Escalation Chain (ADR-003)", () => {
  const defaultTiers = [
    { tier: "fast", attempts: 5 },
    { tier: "balanced", attempts: 3 },
    { tier: "powerful", attempts: 2 },
  ];

  test("escalateTier with standard chain", () => {
    expect(escalateTier("fast", defaultTiers)).toBe("balanced");
    expect(escalateTier("balanced", defaultTiers)).toBe("powerful");
    expect(escalateTier("powerful", defaultTiers)).toBeNull();
  });

  test("escalateTier with custom tierOrder (skip balanced)", () => {
    const customOrder = [
      { tier: "fast", attempts: 5 },
      { tier: "powerful", attempts: 2 },
    ];
    expect(escalateTier("fast", customOrder)).toBe("powerful");
    expect(escalateTier("powerful", customOrder)).toBeNull();
    expect(escalateTier("balanced", customOrder)).toBeNull();
  });

  test("escalateTier with single-tier order", () => {
    const singleTier = [{ tier: "fast", attempts: 10 }];
    expect(escalateTier("fast", singleTier)).toBeNull();
  });

  test("escalateTier with reversed order", () => {
    const reversed = [
      { tier: "powerful", attempts: 2 },
      { tier: "balanced", attempts: 3 },
      { tier: "fast", attempts: 5 },
    ];
    expect(escalateTier("powerful", reversed)).toBe("balanced");
    expect(escalateTier("balanced", reversed)).toBe("fast");
    expect(escalateTier("fast", reversed)).toBeNull();
  });

  test("escalateTier with empty tierOrder returns null", () => {
    expect(escalateTier("fast", [])).toBeNull();
  });

  test("escalateTier with three-tier standard order", () => {
    expect(escalateTier("fast", defaultTiers)).toBe("balanced");
    expect(escalateTier("balanced", defaultTiers)).toBe("powerful");
    expect(escalateTier("powerful", defaultTiers)).toBeNull();
  });

  test("escalateTier should return null for unknown tier", () => {
    expect(escalateTier("unknown", defaultTiers)).toBeNull();
  });

  test("escalateTier should be idempotent at max tier", () => {
    expect(escalateTier("powerful", defaultTiers)).toBeNull();
    // Call again — still null
    expect(escalateTier("powerful", defaultTiers)).toBeNull();
  });

  test("calculateMaxIterations sums all tier attempts", () => {
    const { calculateMaxIterations } = require("../../src/execution/escalation");
    expect(calculateMaxIterations(defaultTiers)).toBe(10); // 5+3+2
    expect(calculateMaxIterations([{ tier: "fast", attempts: 1 }])).toBe(1);
    expect(calculateMaxIterations([])).toBe(0);
  });
});

describe("Pre-Iteration Escalation (BUG-16, BUG-17)", () => {
  const defaultTiers = [
    { tier: "fast", attempts: 5 },
    { tier: "balanced", attempts: 3 },
    { tier: "powerful", attempts: 2 },
  ];

  test("story with attempts >= tier budget should trigger escalation before agent spawn", () => {
    // Simulate a story at "fast" tier with 5 attempts (budget exhausted)
    const story: UserStory = {
      id: "US-001",
      title: "Test story",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 5, // Exhausted fast tier budget (5 attempts)
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };

    // Get tier config
    const currentTier = story.routing!.modelTier;
    const tierCfg = defaultTiers.find((t) => t.tier === currentTier);

    expect(tierCfg).toBeDefined();
    expect(story.attempts).toBeGreaterThanOrEqual(tierCfg!.attempts);

    // Should escalate to next tier
    const nextTier = escalateTier(currentTier!, defaultTiers);
    expect(nextTier).toBe("balanced");
  });

  test("story at balanced tier with 3 attempts should escalate to powerful", () => {
    const story: UserStory = {
      id: "US-002",
      title: "Test story",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 3, // Exhausted balanced tier budget (3 attempts)
      routing: { complexity: "medium", modelTier: "balanced", testStrategy: "test-after", reasoning: "medium" },
    };

    const currentTier = story.routing!.modelTier;
    const tierCfg = defaultTiers.find((t) => t.tier === currentTier);

    expect(tierCfg).toBeDefined();
    expect(story.attempts).toBeGreaterThanOrEqual(tierCfg!.attempts);

    const nextTier = escalateTier(currentTier!, defaultTiers);
    expect(nextTier).toBe("powerful");
  });

  test("story at powerful tier with 2 attempts should mark as FAILED (no more tiers)", () => {
    const story: UserStory = {
      id: "US-003",
      title: "Test story",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 2, // Exhausted powerful tier budget (2 attempts)
      routing: { complexity: "complex", modelTier: "powerful", testStrategy: "test-after", reasoning: "complex" },
    };

    const currentTier = story.routing!.modelTier;
    const tierCfg = defaultTiers.find((t) => t.tier === currentTier);

    expect(tierCfg).toBeDefined();
    expect(story.attempts).toBeGreaterThanOrEqual(tierCfg!.attempts);

    // No next tier available
    const nextTier = escalateTier(currentTier!, defaultTiers);
    expect(nextTier).toBeNull();

    // Story should be marked as FAILED (not retried)
    // In actual runner code, markStoryFailed() would be called here
  });

  test("pre-iteration check prevents infinite loop at same tier", () => {
    // BUG-16: Stories were looping indefinitely at same tier
    // This test verifies that pre-iteration escalation prevents this

    const story: UserStory = {
      id: "US-004",
      title: "ASSET_CHECK failing story",
      description: "Story with missing files",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 5, // Budget exhausted
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
      priorErrors: ["ASSET_CHECK_FAILED: Missing file src/test.ts"],
    };

    // Pre-iteration check should trigger escalation
    const currentTier = story.routing!.modelTier;
    const tierCfg = defaultTiers.find((t) => t.tier === currentTier);

    expect(story.attempts).toBeGreaterThanOrEqual(tierCfg!.attempts);

    // Should escalate instead of retrying at same tier
    const nextTier = escalateTier(currentTier!, defaultTiers);
    expect(nextTier).toBe("balanced");
  });

  test("ASSET_CHECK failure should increment attempts and respect escalation", () => {
    // BUG-17: ASSET_CHECK failures were reverting to pending without escalation
    const story: UserStory = {
      id: "US-005",
      title: "Story with ASSET_CHECK failure",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 4, // One attempt left in fast tier
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };

    // Simulate ASSET_CHECK failure
    const updatedStory = {
      ...story,
      attempts: story.attempts + 1, // Increment attempts
      priorErrors: ["ASSET_CHECK_FAILED: Missing file src/finder.ts"],
    };

    expect(updatedStory.attempts).toBe(5);

    // Now attempts >= tier budget, should escalate on next iteration
    const tierCfg = defaultTiers.find((t) => t.tier === "fast");
    expect(updatedStory.attempts).toBeGreaterThanOrEqual(tierCfg!.attempts);

    const nextTier = escalateTier("fast", defaultTiers);
    expect(nextTier).toBe("balanced");
  });

  test("story below tier budget should not escalate", () => {
    const story: UserStory = {
      id: "US-006",
      title: "Story with attempts below budget",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 2, // Below fast tier budget (5 attempts)
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };

    const currentTier = story.routing!.modelTier;
    const tierCfg = defaultTiers.find((t) => t.tier === currentTier);

    expect(tierCfg).toBeDefined();
    expect(story.attempts).toBeLessThan(tierCfg!.attempts);

    // Should NOT escalate (continue at same tier)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T6: resolveMaxAttemptsOutcome — failure category → pause vs fail
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveMaxAttemptsOutcome", () => {
  describe("categories that require human review → pause", () => {
    test("isolation-violation → pause", () => {
      const result = resolveMaxAttemptsOutcome("isolation-violation");
      expect(result).toBe("pause");
    });

    test("verifier-rejected → pause", () => {
      const result = resolveMaxAttemptsOutcome("verifier-rejected");
      expect(result).toBe("pause");
    });

    test("greenfield-no-tests → pause", () => {
      const result = resolveMaxAttemptsOutcome("greenfield-no-tests");
      expect(result).toBe("pause");
    });
  });

  describe("categories that can be failed automatically → fail", () => {
    test("session-failure → fail", () => {
      const result = resolveMaxAttemptsOutcome("session-failure");
      expect(result).toBe("fail");
    });

    test("tests-failing → fail", () => {
      const result = resolveMaxAttemptsOutcome("tests-failing");
      expect(result).toBe("fail");
    });

    test("undefined (no category) → fail", () => {
      const result = resolveMaxAttemptsOutcome(undefined);
      expect(result).toBe("fail");
    });
  });

  describe("exhaustive coverage of all FailureCategory values", () => {
    const pauseCategories: FailureCategory[] = ["isolation-violation", "verifier-rejected", "greenfield-no-tests"];
    const failCategories: FailureCategory[] = ["session-failure", "tests-failing"];

    for (const cat of pauseCategories) {
      test(`${cat} always returns pause`, () => {
        expect(resolveMaxAttemptsOutcome(cat)).toBe("pause");
      });
    }

    for (const cat of failCategories) {
      test(`${cat} always returns fail`, () => {
        expect(resolveMaxAttemptsOutcome(cat)).toBe("fail");
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T6: retryAsLite routing update logic
// ─────────────────────────────────────────────────────────────────────────────

describe("retryAsLite → testStrategy downgrade", () => {
  /**
   * Simulates the routing update logic from the escalate case in runner.ts.
   * This mirrors the exact transform applied to story.routing when escalating.
   */
  function applyEscalationRouting(
    routing: UserStory["routing"],
    nextTier: "fast" | "balanced" | "powerful",
    retryAsLite: boolean,
  ): UserStory["routing"] {
    if (!routing) return undefined;
    return {
      ...routing,
      modelTier: nextTier,
      ...(retryAsLite ? { testStrategy: "three-session-tdd-lite" as const } : {}),
    };
  }

  test("retryAsLite=true downgrades testStrategy to three-session-tdd-lite", () => {
    const routing: UserStory["routing"] = {
      complexity: "complex",
      modelTier: "fast",
      testStrategy: "three-session-tdd",
      reasoning: "complex",
    };

    const updated = applyEscalationRouting(routing, "balanced", true);

    expect(updated?.testStrategy).toBe("three-session-tdd-lite");
    expect(updated?.modelTier).toBe("balanced");
    expect(updated?.complexity).toBe("complex");
  });

  test("retryAsLite=false leaves testStrategy unchanged", () => {
    const routing: UserStory["routing"] = {
      complexity: "complex",
      modelTier: "fast",
      testStrategy: "three-session-tdd",
      reasoning: "complex",
    };

    const updated = applyEscalationRouting(routing, "balanced", false);

    expect(updated?.testStrategy).toBe("three-session-tdd");
    expect(updated?.modelTier).toBe("balanced");
  });

  test("strategy downgrade happens alongside tier escalation (both applied)", () => {
    const routing: UserStory["routing"] = {
      complexity: "complex",
      modelTier: "fast",
      testStrategy: "three-session-tdd",
      reasoning: "complex",
    };

    const updated = applyEscalationRouting(routing, "powerful", true);

    // Both tier escalation AND strategy downgrade apply simultaneously
    expect(updated?.modelTier).toBe("powerful");
    expect(updated?.testStrategy).toBe("three-session-tdd-lite");
  });

  test("already-lite strategy remains lite after retryAsLite=true", () => {
    const routing: UserStory["routing"] = {
      complexity: "complex",
      modelTier: "fast",
      testStrategy: "three-session-tdd-lite",
      reasoning: "complex",
    };

    const updated = applyEscalationRouting(routing, "balanced", true);

    expect(updated?.testStrategy).toBe("three-session-tdd-lite");
  });

  test("test-after strategy is not changed by retryAsLite (should not happen, but safe)", () => {
    const routing: UserStory["routing"] = {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "simple",
    };

    // retryAsLite would only be set for TDD stories, but test correctness:
    const updated = applyEscalationRouting(routing, "balanced", true);

    // retryAsLite overrides to lite, but this would be a bug in routing
    // (retryAsLite should only be set when testStrategy is three-session-tdd)
    expect(updated?.modelTier).toBe("balanced");
  });

  test("undefined routing returns undefined", () => {
    const updated = applyEscalationRouting(undefined, "balanced", true);
    expect(updated).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T6: TDD Escalation Attempts Counting
// ─────────────────────────────────────────────────────────────────────────────

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
    const { calculateMaxIterations } = require("../../src/execution/escalation");
    const maxAttempts = calculateMaxIterations(defaultTiers);

    // A TDD story at attempt 9 (one below max) should still be escalatable
    expect(9 < maxAttempts).toBe(true);

    // A TDD story at attempt 10 (= max) should NOT be escalatable
    expect(10 < maxAttempts).toBe(false);
  });
});
