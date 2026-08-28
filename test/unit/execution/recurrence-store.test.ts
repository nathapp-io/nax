/**
 * Cross-attempt review-finding recurrence store — #1666 Part C.
 *
 * Parallel to `oscillation-store.test.ts`: this counter is independent of the
 * within-cycle oscillation counter and must never fire on a reviewer's first
 * appearance for a story (the #1355 false-positive class oscillation-store.ts
 * already documents for its own counter).
 */
import { describe, expect, test } from "bun:test";
import { getReviewRecurrenceCount, type ReviewRecurrenceStore, recordReviewFindings } from "@/execution";
import type { Finding } from "@/findings";

function semanticFinding(rule: string, message = rule): Finding {
  return {
    source: "semantic-review",
    severity: "error",
    category: "test",
    message,
    rule,
    file: "src/foo.ts",
  };
}

describe("recordReviewFindings — max-per-key, not a sum across findings", () => {
  test("two DIFFERENT findings each recurring once does NOT reach the default threshold of 2", () => {
    const store: ReviewRecurrenceStore = new Map();
    recordReviewFindings(store, "US-1", "semantic-review", [semanticFinding("R1"), semanticFinding("R2")]);
    // R1 repeats on attempt 2, R2 repeats on attempt 3 — no single finding has
    // recurred twice, so the story is not deadlocked on one reviewer opinion.
    expect(recordReviewFindings(store, "US-1", "semantic-review", [semanticFinding("R1")])).toBe(1);
    expect(recordReviewFindings(store, "US-1", "semantic-review", [semanticFinding("R2")])).toBe(1);
    expect(getReviewRecurrenceCount(store, "US-1", "semantic-review")).toBe(1);
  });

  test("one finding recurring on two later attempts DOES reach 2", () => {
    const store: ReviewRecurrenceStore = new Map();
    recordReviewFindings(store, "US-2", "semantic-review", [semanticFinding("R1")]);
    recordReviewFindings(store, "US-2", "semantic-review", [semanticFinding("R1")]);
    recordReviewFindings(store, "US-2", "semantic-review", [semanticFinding("R1")]);
    expect(getReviewRecurrenceCount(store, "US-2", "semantic-review")).toBe(2);
  });

  test("a reworded message at the same location still counts as the same finding (#1581)", () => {
    const store: ReviewRecurrenceStore = new Map();
    recordReviewFindings(store, "US-3", "semantic-review", [semanticFinding("R1", "first wording")]);
    expect(recordReviewFindings(store, "US-3", "semantic-review", [semanticFinding("R1", "reworded")])).toBe(1);
  });
});

describe("recordReviewFindings / getReviewRecurrenceCount", () => {
  test("exports callable helpers", () => {
    expect(typeof recordReviewFindings).toBe("function");
    expect(typeof getReviewRecurrenceCount).toBe("function");
  });

  test("returns zero for an unseen (storyId, source) pair", () => {
    expect(getReviewRecurrenceCount(new Map(), "US-9", "semantic-review")).toBe(0);
  });

  test("first-ever call for a (storyId, source) pair never counts as a recurrence — reviewer's first reveal", () => {
    const store: ReviewRecurrenceStore = new Map();
    const newCount = recordReviewFindings(store, "US-1", "semantic-review", [semanticFinding("R1")]);
    expect(newCount).toBe(0);
    expect(getReviewRecurrenceCount(store, "US-1", "semantic-review")).toBe(0);
  });

  test("the SAME finding from the SAME source on a later attempt counts as one recurrence", () => {
    const store: ReviewRecurrenceStore = new Map();
    recordReviewFindings(store, "US-1", "semantic-review", [semanticFinding("R1")]);
    const secondAttempt = recordReviewFindings(store, "US-1", "semantic-review", [semanticFinding("R1")]);
    expect(secondAttempt).toBe(1);
    expect(getReviewRecurrenceCount(store, "US-1", "semantic-review")).toBe(1);
  });

  test("recurrence count accumulates across many later attempts of the same finding", () => {
    const store: ReviewRecurrenceStore = new Map();
    recordReviewFindings(store, "US-1", "semantic-review", [semanticFinding("R1")]);
    recordReviewFindings(store, "US-1", "semantic-review", [semanticFinding("R1")]);
    recordReviewFindings(store, "US-1", "semantic-review", [semanticFinding("R1")]);
    expect(getReviewRecurrenceCount(store, "US-1", "semantic-review")).toBe(2);
  });

  test("a DIFFERENT finding (different rule/line) from the same source does not count as a recurrence", () => {
    const store: ReviewRecurrenceStore = new Map();
    recordReviewFindings(store, "US-1", "semantic-review", [semanticFinding("R1")]);
    const secondAttempt = recordReviewFindings(store, "US-1", "semantic-review", [semanticFinding("R2")]);
    expect(secondAttempt).toBe(0);
    expect(getReviewRecurrenceCount(store, "US-1", "semantic-review")).toBe(0);
  });

  test("a reworded finding at the same location (same rule/file, different message) still counts as a recurrence (#1581)", () => {
    const store: ReviewRecurrenceStore = new Map();
    recordReviewFindings(store, "US-1", "semantic-review", [semanticFinding("R1", "original wording")]);
    const secondAttempt = recordReviewFindings(store, "US-1", "semantic-review", [
      semanticFinding("R1", "completely different wording of the same complaint"),
    ]);
    expect(secondAttempt).toBe(1);
  });

  test("a DIFFERENT reviewer source seeing the finding for the first time never counts, even when another source has history", () => {
    const store: ReviewRecurrenceStore = new Map();
    recordReviewFindings(store, "US-1", "semantic-review", [semanticFinding("R1")]);
    recordReviewFindings(store, "US-1", "semantic-review", [semanticFinding("R1")]);
    // adversarial-review's first-ever appearance for this story, even though
    // semantic-review already has two recorded attempts — must not inherit its count.
    const advFinding: Finding = {
      source: "adversarial-review",
      severity: "error",
      category: "test",
      message: "R1",
      rule: "R1",
      file: "src/foo.ts",
    };
    const advAttempt = recordReviewFindings(store, "US-1", "adversarial-review", [advFinding]);
    expect(advAttempt).toBe(0);
    expect(getReviewRecurrenceCount(store, "US-1", "adversarial-review")).toBe(0);
    expect(getReviewRecurrenceCount(store, "US-1", "semantic-review")).toBe(1);
  });

  test("counts are isolated per story", () => {
    const store: ReviewRecurrenceStore = new Map();
    recordReviewFindings(store, "US-A", "semantic-review", [semanticFinding("R1")]);
    recordReviewFindings(store, "US-A", "semantic-review", [semanticFinding("R1")]);
    recordReviewFindings(store, "US-B", "semantic-review", [semanticFinding("R1")]);
    expect(getReviewRecurrenceCount(store, "US-A", "semantic-review")).toBe(1);
    expect(getReviewRecurrenceCount(store, "US-B", "semantic-review")).toBe(0);
  });
});
