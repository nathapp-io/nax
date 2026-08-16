/**
 * Tests for src/bakeoff/worktree-id.ts — `deriveBakeoffWorktreeId`.
 *
 * Covers US-004 AC-2 through AC-5: contestant worktree IDs are namespaced
 * under `bakeoff-`, always pass `validateStoryId`, stay within its 64-char
 * cap, and stay distinct across colliding overlong inputs.
 */

import { describe, expect, it } from "bun:test";
import { deriveBakeoffWorktreeId } from "@/bakeoff";
import { validateStoryId } from "@/prd";

describe("deriveBakeoffWorktreeId", () => {
  // AC-2: the derived ID always carries the reserved bakeoff- namespace.
  it("US-004 AC2: begins with 'bakeoff-' for a normal feature and profile", () => {
    const id = deriveBakeoffWorktreeId("my-feature", "claude");
    expect(id.startsWith("bakeoff-")).toBe(true);
  });

  // AC-3: profile names may contain characters validateStoryId rejects
  // (spaces, slashes, etc. — see validateProfileName in src/config/profile.ts).
  it("US-004 AC3: passes validateStoryId without throwing for a profile with illegal characters", () => {
    const id = deriveBakeoffWorktreeId("my-feature", "gpu claude/v2!!");
    expect(id.startsWith("bakeoff-")).toBe(true);
    expect(() => validateStoryId(id)).not.toThrow();
  });

  // AC-3: a profile whose illegal characters flank literal dots must not
  // sanitize into a `..` path-traversal sequence (validateStoryId rejects
  // `..` even though `.` alone is in its allowed alphabet).
  it("US-004 AC3: does not produce a path-traversal '..' sequence for a profile like 'a/../b'", () => {
    const id = deriveBakeoffWorktreeId("my-feature", "a/../b");
    expect(id.startsWith("bakeoff-")).toBe(true);
    expect(id.includes("..")).toBe(false);
    expect(() => validateStoryId(id)).not.toThrow();
  });

  // AC-4: an overlong feature+profile pair must still fit validateStoryId's cap.
  it("US-004 AC4: truncates to at most 64 characters for an overlong feature and profile", () => {
    const feature = "a-very-long-feature-name-that-goes-on-and-on-and-on-and-on";
    const profile = "an-equally-long-contestant-profile-name-that-also-goes-on-forever";
    const id = deriveBakeoffWorktreeId(feature, profile);
    expect(id.startsWith("bakeoff-")).toBe(true);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(() => validateStoryId(id)).not.toThrow();
  });

  // AC-5: two distinct overlong pairs must not collide after truncation.
  it("US-004 AC5: produces different IDs for two distinct overlong feature+profile pairs", () => {
    const longSuffix = "x".repeat(80);
    const idA = deriveBakeoffWorktreeId(`feature-${longSuffix}`, "claude");
    const idB = deriveBakeoffWorktreeId(`feature-${longSuffix}`, "codex");

    expect(idA.startsWith("bakeoff-")).toBe(true);
    expect(idB.startsWith("bakeoff-")).toBe(true);
    expect(idA).not.toBe(idB);
  });
});
