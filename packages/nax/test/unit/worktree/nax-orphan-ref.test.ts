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
import { deriveStoryWorktreeId } from "@/worktree";
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
});
