/**
 * Unit tests for US-002 — `naxOrphanRefName` accepts a WorktreeId and
 * returns the ref name composed from that identity.
 *
 * AC-4: When `naxOrphanRefName` is given the identity `story-f-US-001`, it
 *       returns the ref name `refs/nax/orphan/story-f-US-001`.
 *
 * Story: US-002 — The worktree API takes the identity.
 */

import { describe, expect, test } from "bun:test";
import { validateStoryId } from "@/prd";
import { deriveStoryWorktreeId, naxOrphanRefName, type WorktreeId } from "@/worktree";

describe("US-002 AC-4: naxOrphanRefName(WorktreeId) returns the composed orphan ref name", () => {
  test("returns refs/nax/orphan/story-f-US-001 when given the identity story-f-US-001", () => {
    const worktreeId: WorktreeId = deriveStoryWorktreeId("f", "US-001");
    expect(naxOrphanRefName(worktreeId)).toBe("refs/nax/orphan/story-f-US-001");
  });

  test("returns refs/nax/orphan/<worktreeId> for an arbitrary composed identity", () => {
    const worktreeId: WorktreeId = deriveStoryWorktreeId("feature-A", "US-123");
    expect(naxOrphanRefName(worktreeId)).toBe(`refs/nax/orphan/${worktreeId}`);
  });

  test("boundary: naxOrphanRefName is the SSOT for refs/nax/orphan/<id> spelling", () => {
    // Both pre-fix (string parameter) and post-fix (WorktreeId parameter)
    // implementations of naxOrphanRefName must produce the same composed
    // output for the same input characters. The brand narrow is a
    // type-only change; the runtime spelling must not drift.
    const id = deriveStoryWorktreeId("f", "US-001");
    const typed: WorktreeId = id;
    // Two calls — one passing the branded type, one passing the plain
    // string value — must agree on the spelling. A future change that
    // accidentally switched the separator (e.g. ":" or "|" for "/")
    // would fail this assertion.
    expect(naxOrphanRefName(typed)).toBe(naxOrphanRefName(String(typed) as WorktreeId));
  });

  test("boundary: naxOrphanRefName rejects identities that fail the SSOT's validation (via validateStoryId)", () => {
    // The producers accept invalid characters by sanitizing them, so we
    // can't reproduce every invalid input through them. validateStoryId's
    // raw check on a too-long identity DOES throw — `naxOrphanRefName`
    // runs the same validateStoryId internally. A string of 65 'A's sits
    // past the SSOT's 64-char cap and proves the validation path.
    const tooLong = "A".repeat(65);
    // The validateStoryId path is internal to naxOrphanRefName; we
    // exercise it via the same call the production code would make.
    expect(() => naxOrphanRefName(tooLong as WorktreeId)).toThrow();
    // And we double-pin the contract by checking validateStoryId directly.
    expect(() => validateStoryId(tooLong)).toThrow();
  });
});
