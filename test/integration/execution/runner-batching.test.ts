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

