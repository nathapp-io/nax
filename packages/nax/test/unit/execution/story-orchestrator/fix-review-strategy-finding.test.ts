/**
 * US-005 — `toFixReviewFinding` (`src/execution/story-orchestrator/fix-review-strategy.ts`).
 *
 * The mapping from an AC-anchored contradiction — the only fix-review verdict
 * that may block (nax#1359 ruling) — onto the cycle's `Finding` wire format, so
 * the blocking cycle can dispatch a fix for it.
 *
 * AC3 — a contradiction with `acIndex: 3` yields rule "fix-review:AC-3".
 * AC4 — a contradiction with `file: "test/a.test.ts"` yields that file, and one
 *       naming no file yields no file.
 * AC5 — the finding's source is "semantic-review".
 * AC6 — the finding's fixTarget is "test".
 * AC7 — `findingsToFailedChecks` of one such finding yields the "semantic" check,
 *       i.e. the finding reaches the check lane the autofix strategies consume.
 */
import { describe, expect, test } from "bun:test";
import { type AnchoredContradiction, toFixReviewFinding } from "@/execution/story-orchestrator/fix-review-strategy";
import type { Finding } from "@/findings";
import { findingsToFailedChecks } from "@/operations";

const REASON = "drops the AC-2 assertion";

/** The verdict shape `runFixReview` produces for an AC-anchored contradiction. */
function contradiction(acIndex = 3, file?: string): AnchoredContradiction {
  return file === undefined
    ? { kind: "fail", cause: "contradiction", reason: REASON, acIndex }
    : { kind: "fail", cause: "contradiction", reason: REASON, acIndex, file };
}

describe("toFixReviewFinding — the AC anchor (US-005 AC3)", () => {
  test("US-005 AC3: a contradiction with acIndex 3 yields rule fix-review:AC-3", () => {
    const finding = toFixReviewFinding(contradiction(3));

    expect(finding.rule).toBe("fix-review:AC-3");
  });

  test("US-005 AC3 boundary: the rule tracks the verdict's own acIndex", () => {
    // A hard-coded anchor would pass the test above and mis-attribute every other
    // criterion, so the index must come from the verdict.
    const finding = toFixReviewFinding(contradiction(7));

    expect(finding.rule).toBe("fix-review:AC-7");
    expect(finding.rule).not.toBe("fix-review:AC-3");
  });
});

describe("toFixReviewFinding — the contradicted file (US-005 AC4)", () => {
  test("US-005 AC4: a contradiction with file test/a.test.ts yields a finding with that file", () => {
    const finding = toFixReviewFinding(contradiction(3, "test/a.test.ts"));

    expect(finding.file).toBe("test/a.test.ts");
  });

  test("US-005 AC4 boundary: a contradiction naming no file yields a finding with no file", () => {
    const finding = toFixReviewFinding(contradiction());

    expect(finding.file).toBeUndefined();
  });
});

describe("toFixReviewFinding — the finding's lane (US-005 AC5, AC6)", () => {
  test("US-005 AC5: the finding's source is semantic-review", () => {
    const finding = toFixReviewFinding(contradiction());

    expect(finding.source).toBe("semantic-review");
  });

  test("US-005 AC6: the finding's fixTarget is test", () => {
    const finding = toFixReviewFinding(contradiction());

    expect(finding.fixTarget).toBe("test");
  });

  test("US-005: the finding carries the verdict's reason, an error severity and the fix-review category", () => {
    const finding = toFixReviewFinding(contradiction());

    // The reason is the only text an operator gets to act on, and the category is
    // what tells a fix-review finding apart from a seeded semantic-review one.
    expect(finding.message).toBe(REASON);
    expect(finding.severity).toBe("error");
    expect(finding.category).toBe("fix-review");
  });
});

describe("findingsToFailedChecks — a fix-review finding (US-005 AC7)", () => {
  test("US-005 AC7: one fix-review finding yields one semantic check carrying it", () => {
    const finding = toFixReviewFinding(contradiction(3, "test/a.test.ts"));

    const checks = findingsToFailedChecks([finding]);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.check).toBe("semantic");
    expect(checks[0]?.success).toBe(false);
    expect(checks[0]?.findings).toEqual([finding]);
  });

  test("US-005 AC7 boundary: two fix-review findings group into one semantic check", () => {
    const first: Finding = toFixReviewFinding(contradiction(3));
    const second: Finding = toFixReviewFinding(contradiction(4));

    const checks = findingsToFailedChecks([first, second]);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.check).toBe("semantic");
    expect(checks[0]?.findings).toHaveLength(2);
  });
});
