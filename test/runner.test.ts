/**
 * Runner Tests — Story Batching
 *
 * Tests for grouping consecutive simple stories into batches.
 */

import { describe, test, expect } from "bun:test";
import { buildBatchPrompt, groupStoriesIntoBatches } from "../src/execution/runner";
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
