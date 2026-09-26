/**
 * US-001 — `resolveFixReviewModel` (src/review/fix-review/config.ts).
 *
 * The fix review's model is resolved in three steps, most specific first:
 *   1. `review.fixReview.model`             — the operator's explicit pin
 *   2. `review.semantic?.model`             — the run's reviewer model
 *   3. `"balanced"`                         — the schema tier default
 *
 * `makeConfigSlice` (not a hand-written literal) builds the fixtures so the
 * slice always carries every field the `ReviewConfig` interface requires —
 * a new required field becomes a compile error here rather than a silently
 * stale fixture.
 */

import { describe, expect, test } from "bun:test";
import { makeConfigSlice, makeSemanticReviewConfig } from "@test/helpers";
import { resolveFixReviewModel } from "@/review/fix-review";
import type { ReviewConfig } from "@/review/types";

function makeReviewConfig(overrides: Partial<ReviewConfig> = {}): ReviewConfig {
  return { ...makeConfigSlice("review"), fixReview: {}, ...overrides };
}

describe("resolveFixReviewModel (US-001) — fixReview.model wins", () => {
  test("US-001 AC5: returns review.fixReview.model even when review.semantic.model differs", () => {
    const review = makeReviewConfig({
      fixReview: { model: "powerful" },
      semantic: makeSemanticReviewConfig({ model: "fast" }),
    });
    expect(resolveFixReviewModel(review)).toBe("powerful");
  });

  test("US-001 AC5 boundary: a literal {agent, model} pin is returned unchanged", () => {
    const review = makeReviewConfig({
      fixReview: { model: { agent: "claude", model: "claude-opus-4-6" } },
      semantic: makeSemanticReviewConfig({ model: "balanced" }),
    });
    expect(resolveFixReviewModel(review)).toEqual({ agent: "claude", model: "claude-opus-4-6" });
  });
});

describe("resolveFixReviewModel (US-001) — falls back to the semantic model", () => {
  test("US-001 AC6: returns review.semantic.model when fixReview.model is unset", () => {
    const review = makeReviewConfig({
      fixReview: { enabled: true, timeoutMs: 600_000 },
      semantic: makeSemanticReviewConfig({ model: "powerful" }),
    });
    expect(resolveFixReviewModel(review)).toBe("powerful");
  });

  test("US-001 AC6 boundary: an explicitly undefined fixReview.model still falls back", () => {
    const review = makeReviewConfig({
      fixReview: { model: undefined },
      semantic: makeSemanticReviewConfig({ model: "powerful" }),
    });
    expect(resolveFixReviewModel(review)).toBe("powerful");
  });
});

describe("resolveFixReviewModel (US-001) — final fallback", () => {
  test('US-001 AC7: returns "balanced" when neither fixReview.model nor semantic is set', () => {
    const review = makeReviewConfig({ semantic: undefined });
    expect(resolveFixReviewModel(review)).toBe("balanced");
  });

  test('US-001 AC7 boundary: returns "balanced" when fixReview carries other keys but no model', () => {
    const review = makeReviewConfig({
      fixReview: { enabled: false, timeoutMs: 30_000 },
      semantic: undefined,
    });
    expect(resolveFixReviewModel(review)).toBe("balanced");
  });
});
