/**
 * validateInjectedStory() / deriveNextStoryId() unit tests
 *
 * Backs the INJECT queue command (mid-run story injection, issue #1288).
 */

import { describe, expect, test } from "bun:test";
import { deriveNextStoryId, validateInjectedStory } from "@/prd";

describe("deriveNextStoryId()", () => {
  test("derives US-001 for an empty PRD", () => {
    expect(deriveNextStoryId(new Set())).toBe("US-001");
  });

  test("derives the next unused sequential ID", () => {
    expect(deriveNextStoryId(new Set(["US-001", "US-002"]))).toBe("US-003");
  });

  test("skips over gaps to find the first unused ID", () => {
    expect(deriveNextStoryId(new Set(["US-001", "US-003"]))).toBe("US-002");
  });
});

describe("validateInjectedStory()", () => {
  const validRaw = {
    title: "Add rate limiting",
    description: "Add a token-bucket rate limiter to the public API.",
    acceptanceCriteria: ["Requests over the limit return 429"],
  };

  test("validates a minimal story and derives an ID", () => {
    const story = validateInjectedStory(validRaw, new Set(["US-001"]));

    expect(story.id).toBe("US-002");
    expect(story.title).toBe("Add rate limiting");
    expect(story.description).toBe(validRaw.description);
    expect(story.acceptanceCriteria).toEqual(validRaw.acceptanceCriteria);
    expect(story.status).toBe("pending");
    expect(story.passes).toBe(false);
    expect(story.attempts).toBe(0);
    expect(story.escalations).toEqual([]);
    expect(story.tags).toEqual([]);
    expect(story.dependencies).toEqual([]);
  });

  test("accepts an explicit id when it does not collide", () => {
    const story = validateInjectedStory({ ...validRaw, id: "US-042" }, new Set(["US-001"]));
    expect(story.id).toBe("US-042");
  });

  test("rejects a duplicate explicit id", () => {
    expect(() => validateInjectedStory({ ...validRaw, id: "US-001" }, new Set(["US-001"]))).toThrow(/already exists/);
  });

  test("rejects missing title", () => {
    const { title, ...rest } = validRaw;
    expect(() => validateInjectedStory(rest, new Set())).toThrow(/title/);
  });

  test("rejects missing description", () => {
    const { description, ...rest } = validRaw;
    expect(() => validateInjectedStory(rest, new Set())).toThrow(/description/);
  });

  test("rejects missing acceptanceCriteria", () => {
    const { acceptanceCriteria, ...rest } = validRaw;
    expect(() => validateInjectedStory(rest, new Set())).toThrow(/acceptanceCriteria/);
  });

  test("rejects empty acceptanceCriteria array", () => {
    expect(() => validateInjectedStory({ ...validRaw, acceptanceCriteria: [] }, new Set())).toThrow(
      /acceptanceCriteria/,
    );
  });

  test("rejects a non-object payload", () => {
    expect(() => validateInjectedStory("not an object", new Set())).toThrow(/JSON object/);
    expect(() => validateInjectedStory(null, new Set())).toThrow(/JSON object/);
    expect(() => validateInjectedStory([], new Set())).toThrow(/JSON object/);
  });

  test("accepts and passes through tags", () => {
    const story = validateInjectedStory({ ...validRaw, tags: ["security", "api"] }, new Set());
    expect(story.tags).toEqual(["security", "api"]);
  });

  test("accepts dependencies that reference existing story IDs", () => {
    const story = validateInjectedStory({ ...validRaw, dependencies: ["US-001"] }, new Set(["US-001"]));
    expect(story.dependencies).toEqual(["US-001"]);
  });

  test("rejects dependencies referencing unknown story IDs", () => {
    expect(() => validateInjectedStory({ ...validRaw, dependencies: ["US-999"] }, new Set(["US-001"]))).toThrow(
      /unknown story ID/,
    );
  });

  test("BUG-9: rejects non-string entries in dependencies (no raw TypeError)", () => {
    // Plausible LLM output — a number slipped into the array.
    expect(() =>
      validateInjectedStory({ ...validRaw, dependencies: ["US-001", 42 as unknown] }, new Set(["US-001"])),
    ).toThrow(/dependencies/);
  });

  test("BUG-9: rejects non-string entries in tags (no raw TypeError)", () => {
    expect(() =>
      validateInjectedStory({ ...validRaw, tags: ["security", { nested: true } as unknown] }, new Set()),
    ).toThrow(/tags/);
  });

  test("rejects an invalid explicit id (path traversal)", () => {
    expect(() => validateInjectedStory({ ...validRaw, id: "../etc" }, new Set())).toThrow();
  });
});
