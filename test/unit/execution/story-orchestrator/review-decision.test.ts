import { describe, expect, test } from "bun:test";
import { toReviewDecisionPayload } from "@/execution";
import { toAdversarialReviewFindings } from "@/review/adversarial-helpers";
import { tagCoverageGap } from "@/review/recurrence-demotion";

/**
 * Regression — F3 of `docs/findings/2026-08-01-review-pipeline-gap-analysis.md`.
 *
 * `advisoryFindings` and `acDropped` were computed by both review ops and then
 * dropped on the floor by the unified emitter, so every one of 1,857 July-2026
 * review-audit records carried `advisoryFindings: null` and no drop record at
 * all. That blinded two things: the AC-grounding filter silently deleting
 * findings, and the `coverageGap` tag the nax-coverage-gap skill reads.
 */
describe("toReviewDecisionPayload", () => {
  const base = { passed: false, findings: [{ severity: "error", file: "a.ts", issue: "boom" }] };

  test("returns null for non-review ops", () => {
    expect(toReviewDecisionPayload("implementer", base)).toBeNull();
  });

  test("forwards advisoryFindings from the op output", () => {
    // Real producer output, not a hand-authored literal: #1816 shipped because fixtures
    // agreed on a shape no producer emits.
    const advisory = tagCoverageGap(
      toAdversarialReviewFindings([
        { severity: "warning", category: "convention", file: "a.ts", line: 1, issue: "nit", suggestion: "" },
      ]),
    );
    const payload = toReviewDecisionPayload("adversarial-review", { ...base, advisoryFindings: advisory });
    expect(payload?.parsed).toBe(true);
    expect(payload?.parsed === true && payload.advisoryFindings).toEqual(advisory);
  });

  test("omits advisoryFindings when the op produced none", () => {
    const payload = toReviewDecisionPayload("semantic-review", base);
    expect(payload?.parsed === true && payload.advisoryFindings).toBeUndefined();
  });

  test("summarises acDropped entries", () => {
    const payload = toReviewDecisionPayload("semantic-review", {
      ...base,
      acDropped: [
        { code: "missing_ac_index", finding: { severity: "error", file: "b.ts", line: 4, issue: "x", acIndex: 9 } },
      ],
    });
    expect(payload?.parsed === true && payload.acDropped).toEqual([
      { code: "missing_ac_index", severity: "error", file: "b.ts", line: 4, issue: "x", acIndex: 9 },
    ]);
  });

  test("carries the unparsed-output preview on a fail-open give-up", () => {
    const payload = toReviewDecisionPayload("semantic-review", {
      failOpen: true,
      unparsedPreview: "I was unable to complete this review because…",
    });
    expect(payload?.parsed).toBe(false);
    expect(payload?.parsed === false && payload.failOpen).toBe(true);
    expect(payload?.parsed === false && payload.unparsedPreview).toBe("I was unable to complete this review because…");
  });

  test("carries the preview on a looksLikeFail give-up too", () => {
    const payload = toReviewDecisionPayload("adversarial-review", {
      looksLikeFail: true,
      unparsedPreview: '{"passed": false, "findings": [ …',
    });
    expect(payload?.parsed === false && payload.looksLikeFail).toBe(true);
    expect(payload?.parsed === false && payload.unparsedPreview).toBe('{"passed": false, "findings": [ …');
  });
});
