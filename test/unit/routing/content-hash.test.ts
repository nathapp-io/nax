/**
 * computeStoryContentHash — RRP-003
 *
 * AC-2: helper function computes a hash of title+description+ACs+tags
 */

import { describe, expect, test } from "bun:test";
import { computeStoryContentHash } from "../../../src/routing";
import type { UserStory } from "../../../src/prd/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(overrides?: Partial<UserStory>): UserStory {
  return {
    id: "US-001",
    title: "Add login page",
    description: "Users can log in with email and password",
    acceptanceCriteria: ["Shows email field", "Shows password field", "Submits form"],
    tags: ["auth", "ui"],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-2: computeStoryContentHash exists and returns a string
// ---------------------------------------------------------------------------

describe("computeStoryContentHash", () => {
  test("returns a non-empty string", () => {
    const story = makeStory();
    const hash = computeStoryContentHash(story);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  test("same story content produces the same hash (deterministic)", () => {
    const story1 = makeStory();
    const story2 = makeStory();
    expect(computeStoryContentHash(story1)).toBe(computeStoryContentHash(story2));
  });

  test("different title produces different hash", () => {
    const base = makeStory();
    const changed = makeStory({ title: "Add registration page" });
    expect(computeStoryContentHash(base)).not.toBe(computeStoryContentHash(changed));
  });

  test("different description produces different hash", () => {
    const base = makeStory();
    const changed = makeStory({ description: "Users can log in via OAuth" });
    expect(computeStoryContentHash(base)).not.toBe(computeStoryContentHash(changed));
  });

  test("different acceptanceCriteria produces different hash", () => {
    const base = makeStory();
    const changed = makeStory({
      acceptanceCriteria: ["Shows email field", "Shows password field"],
    });
    expect(computeStoryContentHash(base)).not.toBe(computeStoryContentHash(changed));
  });

  test("different tags produces different hash", () => {
    const base = makeStory();
    const changed = makeStory({ tags: ["auth", "api"] });
    expect(computeStoryContentHash(base)).not.toBe(computeStoryContentHash(changed));
  });

  test("story ID, status, and attempts do NOT affect the hash (only content fields)", () => {
    const base = makeStory({ id: "US-001", status: "pending", attempts: 0 });
    const differentMeta = makeStory({ id: "US-099", status: "in-progress", attempts: 3 });
    expect(computeStoryContentHash(base)).toBe(computeStoryContentHash(differentMeta));
  });

  test("empty acceptanceCriteria and tags produce a valid hash", () => {
    const story = makeStory({ acceptanceCriteria: [], tags: [] });
    const hash = computeStoryContentHash(story);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  test("adding an AC changes the hash", () => {
    const before = makeStory({ acceptanceCriteria: ["AC1", "AC2"] });
    const after = makeStory({ acceptanceCriteria: ["AC1", "AC2", "AC3 — new"] });
    expect(computeStoryContentHash(before)).not.toBe(computeStoryContentHash(after));
  });

  test("adding a tag changes the hash", () => {
    const before = makeStory({ tags: ["backend"] });
    const after = makeStory({ tags: ["backend", "security"] });
    expect(computeStoryContentHash(before)).not.toBe(computeStoryContentHash(after));
  });
});
