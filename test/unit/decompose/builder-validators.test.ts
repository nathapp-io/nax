/**
 * Tests for DecomposeBuilder.decompose() validator integration and retry behavior.
 *
 * AC:
 * - DecomposeBuilder.decompose() retries on validation failure up to config.maxRetries
 * - Re-prompts LLM with error feedback on retry
 * - Returns result with errors when retries exhausted
 */

import { describe, test, expect, mock } from "bun:test";
import { DecomposeBuilder } from "../../../src/decompose/builder";
import type { DecomposeAdapter, DecomposeConfig } from "../../../src/decompose/types";
import type { UserStory, PRD } from "../../../src/prd";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "SD-001",
    title: "Build authentication system",
    description: "Implement JWT authentication",
    acceptanceCriteria: ["User can log in", "Token is refreshed"],
    tags: ["auth"],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

function makePrd(story: UserStory, siblings: UserStory[] = []): PRD {
  return {
    project: "nax",
    feature: "story-decompose",
    branchName: "feat/story-decompose",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    userStories: [story, ...siblings],
  };
}

function makeConfig(overrides: Partial<DecomposeConfig> = {}): DecomposeConfig {
  return {
    maxSubStories: 3,
    maxComplexity: "medium",
    maxRetries: 2,
    ...overrides,
  };
}

function makeValidSubStoryJson(parentId = "SD-001"): string {
  return JSON.stringify([
    {
      id: `${parentId}-1`,
      parentStoryId: parentId,
      title: "Subtask one",
      description: "First part",
      acceptanceCriteria: ["User can log in", "Token is refreshed"],
      tags: [],
      dependencies: [],
      complexity: "simple",
      nonOverlapJustification: "No overlap with siblings",
    },
  ]);
}

// ---------------------------------------------------------------------------
// Immediate success — no validation errors
// ---------------------------------------------------------------------------

describe("DecomposeBuilder.decompose() — immediate success", () => {
  test("calls adapter once when first response passes validation", async () => {
    const story = makeStory();
    const prd = makePrd(story);
    const config = makeConfig({ maxRetries: 3 });

    const adapter: DecomposeAdapter = {
      decompose: mock(async () => makeValidSubStoryJson()),
    };

    await DecomposeBuilder.for(story).prd(prd).config(config).decompose(adapter);

    expect(adapter.decompose).toHaveBeenCalledTimes(1);
  });

  test("returns valid result on first success", async () => {
    const story = makeStory();
    const prd = makePrd(story);
    const config = makeConfig();

    const adapter: DecomposeAdapter = {
      decompose: mock(async () => makeValidSubStoryJson()),
    };

    const result = await DecomposeBuilder.for(story).prd(prd).config(config).decompose(adapter);
    expect(result.validation.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Retry on validation failure
// ---------------------------------------------------------------------------

describe("DecomposeBuilder.decompose() — retry on validation failure", () => {
  test("retries when response has ID collision with existing PRD stories", async () => {
    const story = makeStory();
    // Sibling story with same ID as what will be in the substory response
    const sibling: UserStory = {
      id: "EXISTING-001",
      title: "Existing story",
      description: "Already in PRD",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };
    const prd = makePrd(story, [sibling]);
    const config = makeConfig({ maxRetries: 2 });

    // First call returns a substory with an ID that collides with EXISTING-001
    const collidingResponse = JSON.stringify([
      {
        id: "EXISTING-001", // collision!
        parentStoryId: "SD-001",
        title: "Colliding substory",
        description: "This substory's ID collides",
        acceptanceCriteria: ["User can log in", "Token is refreshed"],
        tags: [],
        dependencies: [],
        complexity: "simple",
        nonOverlapJustification: "No overlap",
      },
    ]);
    // Second call returns valid response
    const validResponse = makeValidSubStoryJson();

    let callCount = 0;
    const adapter: DecomposeAdapter = {
      decompose: mock(async () => {
        callCount++;
        return callCount === 1 ? collidingResponse : validResponse;
      }),
    };

    await DecomposeBuilder.for(story).prd(prd).config(config).decompose(adapter);
    expect(adapter.decompose).toHaveBeenCalledTimes(2);
  });

  test("retry prompt includes error feedback from failed validation", async () => {
    const story = makeStory();
    const sibling: UserStory = {
      id: "EX-001",
      title: "Existing story",
      description: "Already in PRD",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };
    const prd = makePrd(story, [sibling]);
    const config = makeConfig({ maxRetries: 2 });

    const collidingResponse = JSON.stringify([
      {
        id: "EX-001",
        parentStoryId: "SD-001",
        title: "Colliding substory",
        description: "Collides with existing story",
        acceptanceCriteria: ["User can log in", "Token is refreshed"],
        tags: [],
        dependencies: [],
        complexity: "simple",
        nonOverlapJustification: "No overlap",
      },
    ]);

    const capturedPrompts: string[] = [];
    const adapter: DecomposeAdapter = {
      decompose: mock(async (prompt: string) => {
        capturedPrompts.push(prompt);
        if (capturedPrompts.length === 1) {
          return collidingResponse;
        }
        return makeValidSubStoryJson();
      }),
    };

    await DecomposeBuilder.for(story).prd(prd).config(config).decompose(adapter);

    // Second prompt should contain error feedback
    expect(capturedPrompts.length).toBeGreaterThanOrEqual(2);
    const retryPrompt = capturedPrompts[1];
    // Retry prompt must reference the validation error in some form
    expect(retryPrompt.toLowerCase()).toMatch(/error|invalid|collision|fix/);
  });

  test("retries up to maxRetries times before giving up", async () => {
    const story = makeStory();
    const prd = makePrd(story);
    const config = makeConfig({ maxRetries: 2 });

    // Always return invalid JSON to force exhaustion
    const adapter: DecomposeAdapter = {
      decompose: mock(async () => "not valid json at all"),
    };

    await DecomposeBuilder.for(story).prd(prd).config(config).decompose(adapter);

    // 1 initial attempt + maxRetries retries
    expect(adapter.decompose).toHaveBeenCalledTimes(3);
  });

  test("returns result with errors when retries are exhausted", async () => {
    const story = makeStory();
    const prd = makePrd(story);
    const config = makeConfig({ maxRetries: 1 });

    const adapter: DecomposeAdapter = {
      decompose: mock(async () => "invalid json"),
    };

    const result = await DecomposeBuilder.for(story).prd(prd).config(config).decompose(adapter);

    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.length).toBeGreaterThan(0);
  });

  test("succeeds on the second attempt when first fails", async () => {
    const story = makeStory();
    const prd = makePrd(story);
    const config = makeConfig({ maxRetries: 2 });

    let callCount = 0;
    const adapter: DecomposeAdapter = {
      decompose: mock(async () => {
        callCount++;
        return callCount === 1 ? "invalid json" : makeValidSubStoryJson();
      }),
    };

    const result = await DecomposeBuilder.for(story).prd(prd).config(config).decompose(adapter);

    expect(adapter.decompose).toHaveBeenCalledTimes(2);
    expect(result.subStories.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// No retries configured
// ---------------------------------------------------------------------------

describe("DecomposeBuilder.decompose() — no retries configured", () => {
  test("does not retry when maxRetries is 0", async () => {
    const story = makeStory();
    const prd = makePrd(story);
    const config = makeConfig({ maxRetries: 0 });

    const adapter: DecomposeAdapter = {
      decompose: mock(async () => "invalid json"),
    };

    await DecomposeBuilder.for(story).prd(prd).config(config).decompose(adapter);

    expect(adapter.decompose).toHaveBeenCalledTimes(1);
  });

  test("returns errors immediately when maxRetries is 0 and validation fails", async () => {
    const story = makeStory();
    const prd = makePrd(story);
    const config = makeConfig({ maxRetries: 0 });

    const adapter: DecomposeAdapter = {
      decompose: mock(async () => "invalid json"),
    };

    const result = await DecomposeBuilder.for(story).prd(prd).config(config).decompose(adapter);

    expect(result.validation.valid).toBe(false);
  });

  test("does not retry when maxRetries is undefined (defaults to no retry)", async () => {
    const story = makeStory();
    const prd = makePrd(story);
    const config: DecomposeConfig = {
      maxSubStories: 3,
      maxComplexity: "medium",
      // maxRetries not set
    };

    const adapter: DecomposeAdapter = {
      decompose: mock(async () => makeValidSubStoryJson()),
    };

    await DecomposeBuilder.for(story).prd(prd).config(config).decompose(adapter);

    expect(adapter.decompose).toHaveBeenCalledTimes(1);
  });
});
