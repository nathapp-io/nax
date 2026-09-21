/**
 * Unit tests for the `naxOrphanRefName` helper.
 *
 * This helper is the single SSOT for spelling `refs/nax/orphan/<worktreeId>`,
 * so both pipeline-result-handler.ts (the writer) and worktree/manager.ts
 * (the reader) call it instead of interpolating the name themselves. The
 * tests below exercise the helper directly with the composed identity, the
 * form every caller must use as of US-002.
 *
 * Story: US-002
 */

import { describe, expect, test } from "bun:test";
import { deriveStoryWorktreeId, type WorktreeId } from "@/worktree";
import { naxOrphanRefName } from "@/worktree/nax-orphan-ref";

describe("naxOrphanRefName", () => {
  test("AC-7: returns refs/nax/orphan/story-f-US-001 for the identity derived for feature 'f' and storyId 'US-001'", () => {
    const worktreeId = deriveStoryWorktreeId("f", "US-001");
    expect(naxOrphanRefName(worktreeId)).toBe("refs/nax/orphan/story-f-US-001");
  });

  test("returns refs/nax/orphan/<worktreeId> for an arbitrary composed identity", () => {
    const worktreeId = deriveStoryWorktreeId("feature", "US-123");
    expect(naxOrphanRefName(worktreeId)).toBe(`refs/nax/orphan/${worktreeId}`);
  });

  test("AC-8: throws when validateStoryId rejects the input", () => {
    // The inputs below are deliberately invalid (path traversal,
    // empty string, git-flag injection, characters outside the allowed
    // alphabet). US-002 narrows the parameter to `WorktreeId`, which
    // is branded — every other call site reaches this helper through
    // `deriveStoryWorktreeId` and never produces an invalid input. To
    // exercise the validation path directly we cast through the brand:
    // the helper's runtime check on `validateStoryId` still rejects
    // each of these, so the test stays meaningful as a guard against
    // bypassing the producer at the type level.
    // path-traversal attack vector — `..` is rejected by validateStoryId
    expect(() => naxOrphanRefName("../etc/passwd" as unknown as WorktreeId)).toThrow(); // test-ratchet-allow: as-unknown-as
    // empty string is rejected
    expect(() => naxOrphanRefName("" as unknown as WorktreeId)).toThrow(); // test-ratchet-allow: as-unknown-as
    // git flag injection is rejected
    expect(() => naxOrphanRefName("--upload-pack=evil" as unknown as WorktreeId)).toThrow(); // test-ratchet-allow: as-unknown-as
    // characters outside the allowed class are rejected
    expect(() => naxOrphanRefName("US/001" as unknown as WorktreeId)).toThrow(); // test-ratchet-allow: as-unknown-as
  });
});
