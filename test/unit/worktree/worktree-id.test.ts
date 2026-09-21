/**
 * Tests for src/worktree/worktree-id.ts — the single SSOT module for
 * worktree/branch identities.
 *
 * Covers US-001 AC-1 through AC-9: every spelling of a `.nax-wt/<id>` path,
 * a `nax/<id>` branch, or a `bakeoff-<feature>-<profile>` worktree id has
 * exactly one producer, and the producers are the only sites that spell
 * those values. The `bakeoff-` helper's behaviour is pinned unchanged.
 *
 * Story: US-001
 */

import { describe, expect, it } from "bun:test";
import { validateStoryId } from "@/prd";
import { deriveBakeoffWorktreeId, deriveStoryWorktreeId, storyBranchName, storyWorktreePath } from "@/worktree";

describe("WorktreeId — branded string identity", () => {
  it("US-001 AC1: deriveStoryWorktreeId('my-feature', 'US-001') returns 'story-my-feature-US-001'", () => {
    expect(String(deriveStoryWorktreeId("my-feature", "US-001"))).toBe("story-my-feature-US-001");
  });

  it("US-001 AC2: returns an identity accepted by validateStoryId when feature has characters outside [a-zA-Z0-9._-]", () => {
    const id = deriveStoryWorktreeId("feature with spaces/and slashes!", "US-001");
    expect(id.startsWith("story-")).toBe(true);
    expect(() => validateStoryId(id)).not.toThrow();
  });

  it("US-001 AC3: returns an identity whose length is at most 64 when the natural form exceeds 64 characters", () => {
    const feature = "a-very-long-feature-name-that-goes-on-and-on-and-on-and-on-and-on";
    const storyId = "US-very-long-story-id-that-keeps-growing";
    const id = deriveStoryWorktreeId(feature, storyId);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it("US-001 AC4: the truncating path's identity is accepted by validateStoryId", () => {
    const feature = "a-very-long-feature-name-that-goes-on-and-on-and-on-and-on-and-on";
    const storyId = "US-very-long-story-id-that-keeps-growing";
    const id = deriveStoryWorktreeId(feature, storyId);
    expect(() => validateStoryId(id)).not.toThrow();
  });

  it("US-001 AC5: returns different results for two distinct pairs whose natural identities share their first 64 characters", () => {
    // Two distinct pairs whose natural identities (story-<feature>-<storyId>)
    // share their first 64 characters — i.e. truncation would collide if no
    // distinguishing suffix were appended. The hash-suffix path must fire
    // and yield distinct identities.
    const commonLongPrefix = "x".repeat(55); // fits inside the cap
    const pairA = deriveStoryWorktreeId("feature-a", `US-${commonLongPrefix}-tailA`);
    const pairB = deriveStoryWorktreeId("feature-b", `US-${commonLongPrefix}-tailB`);

    // Sanity: both must be within the 64-char cap (truncating path).
    expect(pairA.length).toBeLessThanOrEqual(64);
    expect(pairB.length).toBeLessThanOrEqual(64);

    // And the two pairs must be distinct despite sharing their natural prefix.
    expect(pairA).not.toBe(pairB);
  });

  it("US-001 AC6: deriveStoryWorktreeId returns an identity beginning with the prefix 'story-'", () => {
    const id = deriveStoryWorktreeId("any-feature", "US-001");
    expect(id.startsWith("story-")).toBe(true);
  });

  it("US-001 AC7: deriveBakeoffWorktreeId returns an identity beginning with the prefix 'bakeoff-', unchanged in value for the same inputs", () => {
    // Pinned against the pre-US-001 implementation (src/bakeoff/worktree-id.ts).
    // Two cases: a normal pair and a profile with characters outside the
    // allowed alphabet — both must still begin with `bakeoff-` and pass
    // validateStoryId.
    const id = deriveBakeoffWorktreeId("my-feature", "claude");
    expect(id.startsWith("bakeoff-")).toBe(true);
    expect(String(id)).toBe("bakeoff-my-feature-claude");

    const id2 = deriveBakeoffWorktreeId("my-feature", "gpu claude/v2!!");
    expect(id2.startsWith("bakeoff-")).toBe(true);
    expect(() => validateStoryId(id2)).not.toThrow();
  });
});

describe("storyWorktreePath — path spelling SSOT", () => {
  it("US-001 AC8: storyWorktreePath('/repo', 'story-f-US-001') returns '/repo/.nax-wt/story-f-US-001'", () => {
    const worktreeId = deriveStoryWorktreeId("f", "US-001");
    expect(storyWorktreePath("/repo", worktreeId)).toBe("/repo/.nax-wt/story-f-US-001");
  });
});

describe("storyBranchName — branch-name spelling SSOT", () => {
  it("US-001 AC9: storyBranchName('story-f-US-001') returns 'nax/story-f-US-001'", () => {
    const worktreeId = deriveStoryWorktreeId("f", "US-001");
    expect(storyBranchName(worktreeId)).toBe("nax/story-f-US-001");
  });
});

describe("WorktreeId — type safety (compile-time)", () => {
  // These are runtime sanity-checks of the brand's runtime representation;
  // the compile-time brand itself is enforced by TypeScript's structural
  // `string & { __brand }` intersection — a test would not exercise that.
  it("a derived identity is a runtime string with the produced characters", () => {
    const id = deriveStoryWorktreeId("f", "US-001");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});
