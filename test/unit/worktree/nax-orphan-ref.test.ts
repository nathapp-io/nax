/**
 * Unit tests for the `naxOrphanRefName` helper.
 *
 * This helper is the single SSOT for spelling `refs/nax/orphan/<storyId>`,
 * so both pipeline-result-handler.ts (the writer) and worktree/manager.ts
 * (the reader) call it instead of interpolating the name themselves. The
 * tests below exercise the helper directly.
 *
 * Story: US-002
 */

import { describe, expect, test } from "bun:test";
import { naxOrphanRefName } from "@/worktree/nax-orphan-ref";

describe("naxOrphanRefName", () => {
  test("AC-7: returns refs/nax/orphan/US-001 for input 'US-001'", () => {
    expect(naxOrphanRefName("US-001")).toBe("refs/nax/orphan/US-001");
  });

  test("returns refs/nax/orphan/<storyId> for an arbitrary valid story id", () => {
    expect(naxOrphanRefName("US-123")).toBe("refs/nax/orphan/US-123");
  });

  test("AC-8: throws when validateStoryId rejects the input", () => {
    // path-traversal attack vector — `..` is rejected by validateStoryId
    expect(() => naxOrphanRefName("../etc/passwd")).toThrow();
    // empty string is rejected
    expect(() => naxOrphanRefName("")).toThrow();
    // git flag injection is rejected
    expect(() => naxOrphanRefName("--upload-pack=evil")).toThrow();
    // characters outside the allowed class are rejected
    expect(() => naxOrphanRefName("US/001")).toThrow();
  });
});
