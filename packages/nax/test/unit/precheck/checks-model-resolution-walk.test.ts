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
import { NATIVE_AGENT } from "@nathapp/nax-agent";
import { byCodePoint } from "@nathapp/nax-agent/internal";
import { collectConfiguredModelPins, splitEntry } from "@/precheck/checks-model-resolution-walk";

const FIX_REVIEW_SITE = "review.fixReview.model";
const EFFORT_MODEL_CONFIG = {
  agent: { default: NATIVE_AGENT },
  models: { native: { powerful: "opencode-go/deepseek-v4.1-flash[high]" } },
};

describe("splitEntry — effort suffix normalization (US-001)", () => {
  test("AC-1: strips effort suffix from a provider-qualified model", () => {
    expect(splitEntry("opencode-go/deepseek-v4.1-flash[high]")).toEqual({
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
    });
  });

  test("AC-2: preserves a provider-qualified model without effort suffix", () => {
    expect(splitEntry("openai/gpt-5.4-mini")).toEqual({ provider: "openai", model: "gpt-5.4-mini" });
  });

  test("AC-3: strips effort suffix from a bare model and infers provider", () => {
    expect(splitEntry("claude-sonnet-4-5[low]")).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
  });

  test("AC-4: collected native tier entry uses the normalized id", () => {
    const { tierEntries } = collectConfiguredModelPins(EFFORT_MODEL_CONFIG);
    expect(tierEntries).toContainEqual(
      expect.objectContaining({
        keyPath: "models.native.powerful",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
      }),
    );
  });
});

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
