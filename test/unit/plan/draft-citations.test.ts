/**
 * Tests for validateDraftCitations — US-002
 *
 * Covers ACs 10–12:
 * - AC10: returns { ok: true } when citation rate >= threshold
 * - AC11: returns { ok: false } when citation rate < threshold
 * - AC12: returns { ok: false, rate: 0, uncitedCount: 0 } for empty input
 */

import { describe, expect, test } from "bun:test";
import type { FactsManifest } from "@/debate/facts-manifest";
import { validateDraftCitations } from "@/plan";

const emptyManifest: FactsManifest = { repoFacts: [], specClaims: [], gaps: [] };

// ---------------------------------------------------------------------------
// AC10: ok === true when rate >= threshold
// ---------------------------------------------------------------------------

describe("validateDraftCitations — ok === true (AC10)", () => {
  test("returns ok=true when all paragraphs have factId citations and rate >= threshold", () => {
    // Three paragraphs, each citing a factId → rate = 1.0 >= 0.5
    const output = ["First claim citing [F-001].", "Second claim citing [F-002].", "Third claim citing [F-003]."].join(
      "\n\n",
    );

    const result = validateDraftCitations(output, emptyManifest, 0.5);

    expect(result.ok).toBe(true);
    expect(result.threshold).toBe(0.5);
    expect(result.rate).toBeGreaterThanOrEqual(0.5);
  });

  test("result shape includes rate, threshold, uncitedCount", () => {
    const output = "Cited paragraph [F-001].\n\nAnother cited [F-002].";

    const result = validateDraftCitations(output, emptyManifest, 0.5);

    expect(typeof result.rate).toBe("number");
    expect(result.threshold).toBe(0.5);
    expect(typeof result.uncitedCount).toBe("number");
  });

  test("uncitedCount is 0 when all claims are cited", () => {
    const output = "Claim one [F-001].\n\nClaim two [F-002].";

    const result = validateDraftCitations(output, emptyManifest, 0.5);

    expect(result.uncitedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC11: ok === false when rate < threshold
// ---------------------------------------------------------------------------

describe("validateDraftCitations — ok === false (AC11)", () => {
  test("returns ok=false when citation rate is below threshold", () => {
    // Three paragraphs: only first cited → rate 0.333 < 0.5
    const output = ["Cited paragraph [F-001].", "Uncited paragraph one.", "Uncited paragraph two."].join("\n\n");

    const result = validateDraftCitations(output, emptyManifest, 0.5);

    expect(result.ok).toBe(false);
    expect(result.threshold).toBe(0.5);
    expect(result.rate).toBeLessThan(0.5);
  });

  test("uncitedCount reflects the number of uncited paragraphs", () => {
    const output = ["Cited [F-001].", "Uncited one.", "Uncited two."].join("\n\n");

    const result = validateDraftCitations(output, emptyManifest, 0.5);

    expect(result.uncitedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC12: empty input → { ok: false, rate: 0, threshold, uncitedCount: 0 }
// ---------------------------------------------------------------------------

describe("validateDraftCitations — empty input (AC12)", () => {
  test("returns { ok: false, rate: 0, threshold: 0.5, uncitedCount: 0 } for empty string", () => {
    const result = validateDraftCitations("", emptyManifest, 0.5);

    expect(result).toEqual({ ok: false, rate: 0, threshold: 0.5, uncitedCount: 0 });
  });

  test("returns ok=false with rate=0 for whitespace-only input", () => {
    const result = validateDraftCitations("   \n  ", emptyManifest, 0.5);

    expect(result.ok).toBe(false);
    expect(result.rate).toBe(0);
    expect(result.threshold).toBe(0.5);
  });
});
