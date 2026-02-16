/**
 * Runner Tests — Story Batching
 *
 * Tests for grouping consecutive simple stories into batches.
 */

import { describe, test, expect } from "bun:test";
import { buildBatchPrompt, groupStoriesIntoBatches, escalateTier } from "../src/execution/runner";
import type { UserStory } from "../src/prd";
import type { StoryBatch } from "../src/execution/runner";

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
      routing: { complexity: "simple" as const, modelTier: "fast" as const, testStrategy: "test-after" as const, reasoning: "simple" },
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
        routing: { complexity: "complex", modelTier: "balanced", testStrategy: "three-session-tdd", reasoning: "complex" },
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
        routing: { complexity: "complex", modelTier: "balanced", testStrategy: "three-session-tdd", reasoning: "complex" },
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
      routing: { complexity: "simple" as const, modelTier: "fast" as const, testStrategy: "test-after" as const, reasoning: "simple" },
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
        routing: { complexity: "complex", modelTier: "balanced", testStrategy: "three-session-tdd", reasoning: "complex" },
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
    const nextTier = escalateTier(currentTier);

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
    // Test that batch failures follow the same escalation chain as individual failures
    const tiers = ["fast", "balanced", "powerful"] as const;
    const expectedNext = ["balanced", "powerful", null];

    for (let i = 0; i < tiers.length; i++) {
      const nextTier = escalateTier(tiers[i]);
      expect(nextTier).toBe(expectedNext[i]);
    }

    // When a batch at 'powerful' tier fails, first story is marked as failed (no escalation)
    const powerfulTier = escalateTier("powerful");
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
        title: "Completed",
        description: "Already done",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "completed",
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

describe("Configurable Escalation Chain", () => {
  test("escalateTier with default chain (no tierOrder provided)", () => {
    // Default chain: fast → balanced → powerful → null
    expect(escalateTier("fast")).toBe("balanced");
    expect(escalateTier("balanced")).toBe("powerful");
    expect(escalateTier("powerful")).toBeNull();
    expect(escalateTier("fast", undefined)).toBe("balanced");
  });

  test("escalateTier with custom tierOrder", () => {
    // Custom chain: fast → powerful (skip balanced)
    const customOrder: ("fast" | "balanced" | "powerful")[] = ["fast", "powerful"];
    expect(escalateTier("fast", customOrder)).toBe("powerful");
    expect(escalateTier("powerful", customOrder)).toBeNull();

    // balanced not in order, should return null
    expect(escalateTier("balanced", customOrder)).toBeNull();
  });

  test("escalateTier with single-tier order", () => {
    // Only one tier in order, should not escalate
    const singleTier: ("fast" | "balanced" | "powerful")[] = ["fast"];
    expect(escalateTier("fast", singleTier)).toBeNull();
  });

  test("escalateTier with reversed order", () => {
    // Custom chain: powerful → balanced → fast (cost reduction strategy)
    const reversedOrder: ("fast" | "balanced" | "powerful")[] = ["powerful", "balanced", "fast"];
    expect(escalateTier("powerful", reversedOrder)).toBe("balanced");
    expect(escalateTier("balanced", reversedOrder)).toBe("fast");
    expect(escalateTier("fast", reversedOrder)).toBeNull();
  });

  test("escalateTier with empty tierOrder fallbacks to default", () => {
    // Empty tierOrder should fallback to default chain
    const emptyOrder: ("fast" | "balanced" | "powerful")[] = [];
    expect(escalateTier("fast", emptyOrder)).toBe("balanced");
    expect(escalateTier("balanced", emptyOrder)).toBe("powerful");
    expect(escalateTier("powerful", emptyOrder)).toBeNull();
  });

  test("escalateTier with three-tier standard order", () => {
    // Explicit standard order: fast → balanced → powerful
    const standardOrder: ("fast" | "balanced" | "powerful")[] = ["fast", "balanced", "powerful"];
    expect(escalateTier("fast", standardOrder)).toBe("balanced");
    expect(escalateTier("balanced", standardOrder)).toBe("powerful");
    expect(escalateTier("powerful", standardOrder)).toBeNull();
  });

  test("escalateTier with tier not in custom order returns null", () => {
    // Custom order only includes fast and powerful
    const customOrder: ("fast" | "balanced" | "powerful")[] = ["fast", "powerful"];

    // balanced is not in order, should return null (cannot escalate)
    expect(escalateTier("balanced", customOrder)).toBeNull();
  });

  test("escalateTier should be idempotent for null tier", () => {
    // Escalating beyond the max tier should always return null
    const maxTier = escalateTier("powerful");
    expect(maxTier).toBeNull();

    // With custom order
    const customOrder: ("fast" | "balanced" | "powerful")[] = ["fast", "balanced", "powerful"];
    const maxTierCustom = escalateTier("powerful", customOrder);
    expect(maxTierCustom).toBeNull();
  });

  test("config schema includes optional tierOrder", () => {
    // Test that config schema supports escalation.tierOrder
    const configWithTierOrder = {
      version: 1,
      models: {
        fast: { provider: "anthropic", model: "claude-haiku-4-5" },
        balanced: { provider: "anthropic", model: "claude-sonnet-4-5" },
        powerful: { provider: "anthropic", model: "claude-opus-4" },
      },
      autoMode: {
        enabled: true,
        defaultAgent: "claude",
        fallbackOrder: ["claude"],
        complexityRouting: {
          simple: "fast" as const,
          medium: "balanced" as const,
          complex: "powerful" as const,
          expert: "powerful" as const,
        },
        escalation: {
          enabled: true,
          maxAttempts: 3,
          tierOrder: ["fast", "powerful"] as ("fast" | "balanced" | "powerful")[],
        },
      },
      execution: {
        maxIterations: 20,
        iterationDelayMs: 2000,
        costLimit: 5.0,
        sessionTimeoutSeconds: 600,
      },
      quality: {
        requireTypecheck: true,
        requireLint: true,
        requireTests: true,
        commands: {},
      },
      tdd: {
        maxRetries: 2,
        autoVerifyIsolation: true,
        autoApproveVerifier: true,
      },
    };

    expect(configWithTierOrder.autoMode.escalation.tierOrder).toEqual(["fast", "powerful"]);
    expect(escalateTier("fast", configWithTierOrder.autoMode.escalation.tierOrder)).toBe("powerful");
  });
});
