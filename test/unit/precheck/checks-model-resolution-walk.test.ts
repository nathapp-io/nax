/**
 * US-001 — `collectConfiguredModelPins` (src/precheck/checks-model-resolution-walk.ts).
 *
 * The model-resolution precheck resolves every configured model site through
 * the catalog. `review.fixReview.model` is a new site: it must be walked when
 * the operator pinned it, and must add nothing when it is unset (an unset
 * `fixReview.model` means "fall back to review.semantic.model" — see
 * `resolveFixReviewModel` — so there is no model id to resolve).
 *
 * The walk merges its input over DEFAULT_CONFIG, so each case supplies only the
 * one site under test.
 */

import { describe, expect, test } from "bun:test";
import { collectConfiguredModelPins } from "@/precheck/checks-model-resolution-walk";
import { byCodePoint } from "@/utils/sort";

const FIX_REVIEW_SITE = "review.fixReview.model";

describe("collectConfiguredModelPins — review.fixReview.model (US-001)", () => {
  test("US-001 AC8: a tier-label fixReview.model adds a review.fixReview.model site", () => {
    const { pins } = collectConfiguredModelPins({ review: { fixReview: { model: "powerful" } } });

    const site = pins.find((pin) => pin.keyPath === FIX_REVIEW_SITE);
    expect(site).toBeDefined();
    expect(site?.model).toBeTruthy();
  });

  test("US-001 AC8 boundary: a literal {agent, model} fixReview.model is walked with its own agent", () => {
    const { pins } = collectConfiguredModelPins({
      review: { fixReview: { model: { agent: "claude", model: "claude-opus-4-6" } } },
    });

    const site = pins.find((pin) => pin.keyPath === FIX_REVIEW_SITE);
    expect(site?.agent).toBe("claude");
    expect(site?.model).toBe("claude-opus-4-6");
  });

  test("US-001 AC9: an unset fixReview.model adds no review.fixReview.model site", () => {
    const { pins } = collectConfiguredModelPins({ review: { fixReview: { enabled: false, timeoutMs: 1000 } } });

    expect(pins.some((pin) => pin.keyPath === FIX_REVIEW_SITE)).toBe(false);
    // Positive control: the walk DID visit review sites, so the absence above is
    // "not emitted", not "the walk never ran".
    expect(pins.some((pin) => pin.keyPath === "review.semantic.model")).toBe(true);
  });

  test("US-001 AC9 boundary: an unset fixReview.model leaves the other review sites exactly as they were", () => {
    const { pins } = collectConfiguredModelPins({ review: { fixReview: {} } });

    const reviewKeyPaths = pins.filter((pin) => pin.keyPath.startsWith("review.")).map((pin) => pin.keyPath);
    expect(reviewKeyPaths.sort(byCodePoint)).toEqual(["review.adversarial.model", "review.semantic.model"]);
  });
});
