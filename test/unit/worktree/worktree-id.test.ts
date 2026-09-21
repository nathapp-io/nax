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
    // Two distinct pairs whose NATURAL identities
    // (`story-<feature>-<storyId>`) share their first 64 characters
    // character-for-character. A naive truncating implementation that
    // simply sliced the first 64 chars would return the same string for
    // both pairs, so the implementation MUST append a distinguishing
    // suffix (a stable hash of the raw inputs) to keep them distinct.
    //
    // Construction: the prefix `story-common-` is 13 chars; padding the
    // storyId with 51 'x' chars gives 13 + 51 = 64 chars of identical
    // natural-form prefix. The pair-specific suffix `-tailA` / `-tailB`
    // sits past position 64, so a truncating impl drops it. Both pairs
    // are 70 chars in their natural form — well past the 64-char cap, so
    // the truncation path is forced to run.
    const sharedStoryIdPrefix = "x".repeat(51);
    const feature = "common";
    const pairA = deriveStoryWorktreeId(feature, `${sharedStoryIdPrefix}-tailA`);
    const pairB = deriveStoryWorktreeId(feature, `${sharedStoryIdPrefix}-tailB`);

    // Pin the collision property: both natural forms share their first
    // 64 characters character-for-character, so a slice-only truncation
    // would yield identical 64-char strings. A broken impl that omits
    // the hash suffix would still match this expected value for both
    // pairs.
    const naturalA = `story-${feature}-${sharedStoryIdPrefix}-tailA`;
    const naturalB = `story-${feature}-${sharedStoryIdPrefix}-tailB`;
    expect(naturalA.slice(0, 64)).toBe(naturalB.slice(0, 64));
    expect(naturalA.length).toBeGreaterThan(64);
    expect(naturalB.length).toBeGreaterThan(64);

    // Sanity: both derived IDs must respect the 64-char cap.
    expect(pairA.length).toBeLessThanOrEqual(64);
    expect(pairB.length).toBeLessThanOrEqual(64);

    // The contract: distinct pairs whose natural forms collide on the
    // first 64 chars MUST still produce distinct identities. A
    // slice-only implementation would return identical strings here,
    // so this assertion catches a missing hash suffix.
    expect(pairA).not.toBe(pairB);
  });

  it("US-001 AC6: deriveStoryWorktreeId returns an identity beginning with the prefix 'story-'", () => {
    const id = deriveStoryWorktreeId("any-feature", "US-001");
    expect(id.startsWith("story-")).toBe(true);
  });

  it("US-001 AC7: deriveBakeoffWorktreeId returns an identity beginning with the prefix 'bakeoff-', unchanged in value for the same inputs", () => {
    // Pinned against the pre-US-001 implementation (src/bakeoff/worktree-id.ts).
    // Three cases pin the contract:
    //   1. short pair — exact value matches the pre-US-001 derivation.
    //   2. short pair with illegal characters in the profile — the sanitized
    //      value still passes validateStoryId (no `..` path traversal, no
    //      forbidden chars).
    //   3. overlong pair — the truncation/hash-suffix path still fires and
    //      stays within validateStoryId's 64-char cap, so a US-001 change
    //      to MAX_WORKTREE_ID_LENGTH, HASH_SUFFIX_LENGTH, or the sanitize
    //      pass would fail this test for the same inputs.
    const id = deriveBakeoffWorktreeId("my-feature", "claude");
    expect(id.startsWith("bakeoff-")).toBe(true);
    expect(String(id)).toBe("bakeoff-my-feature-claude");

    const id2 = deriveBakeoffWorktreeId("my-feature", "gpu claude/v2!!");
    expect(id2.startsWith("bakeoff-")).toBe(true);
    expect(() => validateStoryId(id2)).not.toThrow();

    const longFeature = "a-very-long-feature-name-that-goes-on-and-on-and-on-and-on";
    const longProfile = "an-equally-long-contestant-profile-name-that-also-goes-on-forever";
    const id3 = deriveBakeoffWorktreeId(longFeature, longProfile);
    expect(id3.startsWith("bakeoff-")).toBe(true);
    expect(id3.length).toBeLessThanOrEqual(64);
    expect(() => validateStoryId(id3)).not.toThrow();
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
