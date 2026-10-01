/**
 * Unit tests for US-002 — `deriveBakeoffWorktreeId` returns the same string
 * value for the same inputs after the WorktreeId brand narrowing.
 *
 * AC-12: `deriveBakeoffWorktreeId("f", "agent")` returns the same string
 *        value as before this feature for the same inputs.
 *
 * Story: US-002 — The worktree API takes the identity.
 */

import { describe, expect, test } from "bun:test";
import { deriveBakeoffWorktreeId, deriveStoryWorktreeId, type WorktreeId } from "@/worktree";

describe("US-002 AC-12: deriveBakeoffWorktreeId returns the same string value as pre-US-002", () => {
  test("AC-12: deriveBakeoffWorktreeId('f', 'agent') returns 'bakeoff-f-agent' as a string", () => {
    const id = deriveBakeoffWorktreeId("f", "agent");
    // The change to US-002 narrows the return type to WorktreeId; the
    // runtime string value MUST match the pre-US-001 implementation.
    expect(String(id)).toBe("bakeoff-f-agent");
  });

  test("returns an identity beginning with the prefix 'bakeoff-' (US-001 invariant)", () => {
    const id = deriveBakeoffWorktreeId("any-feature", "any-profile");
    expect(id.startsWith("bakeoff-")).toBe(true);
  });

  test("returns a branded WorktreeId-shaped string", () => {
    const id = deriveBakeoffWorktreeId("f", "agent");
    // Pre-US-002: `string`. Post-US-002: `WorktreeId` (a branded `string`).
    // At runtime both look like a `string`; this asserts the runtime shape
    // is unchanged.
    expect(typeof id).toBe("string");
    expect(String(id)).toBe("bakeoff-f-agent");

    // The branded type is structurally a string, so this assignment
    // compiles both before and after the narrowing.
    const typed: WorktreeId = id;
    expect(String(typed)).toBe("bakeoff-f-agent");
  });

  test("AC-7 (boundary): deriveBakeoffWorktreeId sanitizes special characters and still validates", () => {
    // The AC-12 invariant ("same value as before for same inputs") holds
    // even on paths where inputs have characters that validateStoryId
    // would reject raw. The derive* functions sanitize the input first;
    // the result MUST still be a valid WorktreeId.
    const id = deriveBakeoffWorktreeId("feature with spaces!", "agent/run.sh");
    expect(id.startsWith("bakeoff-")).toBe(true);
    expect(String(id)).not.toContain(" ");
    expect(String(id)).not.toContain("/");
  });

  test("AC-12 (boundary): deriveBakeoffWorktreeId never coincides with deriveStoryWorktreeId for the same feature pair", () => {
    // The bakeoff namespace is disjoint from the story namespace. Even
    // though both derive identities from a (feature, profile/storyId)
    // pair, the prefixes are distinct ("bakeoff-" vs "story-"). The
    // bakeoff identity for ("f", "agent") is therefore not the same as
    // the story identity for ("f", "agent").
    const bakeoffId = String(deriveBakeoffWorktreeId("f", "agent"));
    const storyId = String(deriveStoryWorktreeId("f", "agent"));
    expect(bakeoffId).toBe("bakeoff-f-agent");
    expect(storyId).toBe("story-f-agent");
    expect(bakeoffId).not.toBe(storyId);
  });
});
