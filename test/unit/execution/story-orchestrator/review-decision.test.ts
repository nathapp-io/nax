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

  // US-002 — AC1: modelPassed:true must round-trip onto the payload rather than
  // being silently dropped at the emit seam.
  test("forwards modelPassed:true from an adversarial op output", () => {
    const payload = toReviewDecisionPayload("adversarial-review", {
      ...base,
      passed: true,
      modelPassed: true,
    });
    expect(payload?.parsed).toBe(true);
    expect(payload?.parsed === true && payload.modelPassed).toBe(true);
  });

  // US-002 — AC2: the truthy-narrowing pitfall: `modelPassed:false` MUST be
  // preserved as false on the payload, not collapsed to undefined by a falsy
  // check. Without explicit boolean narrowing, a `?` optional + spread pattern
  // would silently drop it.
  test("forwards modelPassed:false from an adversarial op output rather than dropping it as falsy", () => {
    const payload = toReviewDecisionPayload("adversarial-review", {
      ...base,
      passed: true,
      modelPassed: false,
    });
    expect(payload?.parsed).toBe(true);
    // Distinct from `toBeUndefined()` — the missing-modelPassed case is AC3.
    expect(payload?.parsed === true && payload.modelPassed).toBe(false);
  });

  // US-002 — AC3: a semantic output has no modelPassed (the adversarial op is
  // the only producer). The absent case must NOT introduce an explicit
  // `modelPassed: undefined` field — semantic outputs flow through the same
  // emit seam and must remain indistinguishable from pre-US-002 records.
  test("omits modelPassed when the op output carries none", () => {
    const payload = toReviewDecisionPayload("adversarial-review", base);
    expect(payload?.parsed === true && "modelPassed" in payload).toBe(false);
  });

  // US-002 — AC4: a wrong-typed modelPassed (string "yes", for example from a
  // misconfigured op or a hand-authored fixture) must NOT be coerced. The seam
  // narrows to boolean only; any other value is omitted.
  test("omits modelPassed when the op output carries the string 'yes' (not a boolean)", () => {
    const payload = toReviewDecisionPayload("adversarial-review", {
      ...base,
      passed: true,
      modelPassed: "yes",
    });
    expect(payload?.parsed === true && "modelPassed" in payload).toBe(false);
  });
});
