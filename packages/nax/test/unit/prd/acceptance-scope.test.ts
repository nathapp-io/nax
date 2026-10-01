import { describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import { isInAcceptanceScope, isLegacyFixStory } from "@/prd";
import type { UserStory } from "@/prd/types";

function story(id: string, status: UserStory["status"] = "pending"): UserStory {
  return makeStory({ id, status });
}

describe("isLegacyFixStory", () => {
  test("matches the `US-FIX-*` ids the pre-ADR-022 acceptance loop appended", () => {
    expect(isLegacyFixStory(story("US-FIX-001"))).toBe(true);
    expect(isLegacyFixStory(story("US-FIX-042"))).toBe(true);
  });

  test("does not match an ordinary story, including one that merely mentions a fix", () => {
    expect(isLegacyFixStory(story("US-001"))).toBe(false);
    expect(isLegacyFixStory(story("US-002-FIX"))).toBe(false);
    expect(isLegacyFixStory(story("BUG-FIX-001"))).toBe(false);
  });
});

describe("isInAcceptanceScope", () => {
  test("admits an ordinary pending story", () => {
    expect(isInAcceptanceScope(story("US-001"))).toBe(true);
  });

  test("excludes a legacy fix story", () => {
    // Nothing has written these since #331 (2026-04-10); the guard exists for
    // a prd.json persisted by an older nax and resumed after upgrading.
    expect(isInAcceptanceScope(story("US-FIX-001"))).toBe(false);
  });

  test("excludes a decomposed parent, whose ACs its children already cover", () => {
    // This half is LIVE — decomposition is a current feature, unlike US-FIX-*.
    expect(isInAcceptanceScope(story("US-001", "decomposed"))).toBe(false);
  });

  test("a passed or failed story is still in scope — only decomposition removes it", () => {
    expect(isInAcceptanceScope(story("US-001", "passed"))).toBe(true);
    expect(isInAcceptanceScope(story("US-001", "failed"))).toBe(true);
  });
});
