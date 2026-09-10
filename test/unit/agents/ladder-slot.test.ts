import { describe, expect, test } from "bun:test";
import { ladderDepthOf, ladderSlotKey } from "@/agents/ladder-slot";
import type { FallbackTarget } from "@/agents/swap-decision";

const RUNGS: FallbackTarget[] = [
  { agent: "native", tier: "powerful" },
  { agent: "native", model: "openrouter/z-ai/glm-5.3-flash[high]" },
  { agent: "claude" },
];

/** Exact-shape comparator; the manager injects a model-identity-aware one. */
const same = (a: FallbackTarget, b: FallbackTarget) => a.agent === b.agent && a.tier === b.tier && a.model === b.model;

describe("ladderSlotKey()", () => {
  test("distinguishes roles", () => {
    expect(ladderSlotKey("US-1", "balanced", "native", "implementer")).not.toBe(
      ladderSlotKey("US-1", "balanced", "native", "reviewer-semantic"),
    );
  });

  test("distinguishes tiers, so an escalation starts a fresh ladder", () => {
    expect(ladderSlotKey("US-1", "balanced", "native", "implementer")).not.toBe(
      ladderSlotKey("US-1", "powerful", "native", "implementer"),
    );
  });

  test("is stable for the same inputs", () => {
    expect(ladderSlotKey("US-1", "balanced", "native", "implementer")).toBe(
      ladderSlotKey("US-1", "balanced", "native", "implementer"),
    );
  });

  test("absent tier and role are still distinct from present ones", () => {
    expect(ladderSlotKey("US-1", undefined, "native", undefined)).not.toBe(
      ladderSlotKey("US-1", "balanced", "native", "implementer"),
    );
  });
});

describe("ladderDepthOf()", () => {
  test("the configured primary is depth 0", () => {
    expect(ladderDepthOf(RUNGS, { agent: "native" }, same)).toBe(0);
  });

  test("the first rung is depth 1", () => {
    expect(ladderDepthOf(RUNGS, { agent: "native", tier: "powerful" }, same)).toBe(1);
  });

  test("the second rung is depth 2", () => {
    expect(ladderDepthOf(RUNGS, { agent: "native", model: "openrouter/z-ai/glm-5.3-flash[high]" }, same)).toBe(2);
  });

  test("a cross-agent rung counts like any other", () => {
    expect(ladderDepthOf(RUNGS, { agent: "claude" }, same)).toBe(3);
  });

  test("a target that is on no rung is depth 0", () => {
    expect(ladderDepthOf(RUNGS, { agent: "codex" }, same)).toBe(0);
  });
});
