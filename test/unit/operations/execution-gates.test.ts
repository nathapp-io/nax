import { describe, expect, test } from "bun:test";
import { shouldKeepSessionOpen, shouldRunReview, shouldRunRectification } from "@/operations";
import { makeNaxConfig } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Config helpers
// ─────────────────────────────────────────────────────────────────────────────

function withReview(enabled: boolean) {
  return makeNaxConfig({ review: { enabled } });
}

function withRectification(enabled: boolean) {
  return makeNaxConfig({
    execution: {
      rectification: enabled
        ? { enabled: true, maxRetries: 2, fullSuiteTimeoutSeconds: 60, maxFailureSummaryChars: 1000 }
        : { enabled: false },
    },
  });
}

function withNeither() {
  return makeNaxConfig({
    review: { enabled: false },
    execution: { rectification: { enabled: false } },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// shouldKeepSessionOpen
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldKeepSessionOpen", () => {
  test("returns true for implementer when review is enabled (AC1)", () => {
    expect(shouldKeepSessionOpen(withReview(true), "implementer")).toBe(true);
  });

  test("returns true for implementer when rectification is enabled (AC2)", () => {
    expect(shouldKeepSessionOpen(withRectification(true), "implementer")).toBe(true);
  });

  test("returns false for implementer when both are absent or false (AC3)", () => {
    expect(shouldKeepSessionOpen(withNeither(), "implementer")).toBe(false);
  });

  test("returns false for test-writer when review is enabled (AC4)", () => {
    expect(shouldKeepSessionOpen(withReview(true), "test-writer")).toBe(false);
  });

  test("returns false for test-writer when rectification is enabled (AC4)", () => {
    expect(shouldKeepSessionOpen(withRectification(true), "test-writer")).toBe(false);
  });

  test("returns false for verifier when review is enabled (AC5)", () => {
    expect(shouldKeepSessionOpen(withReview(true), "verifier")).toBe(false);
  });

  test("returns false for verifier when rectification is enabled (AC5)", () => {
    expect(shouldKeepSessionOpen(withRectification(true), "verifier")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shouldRunReview
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldRunReview", () => {
  test("returns true when review.enabled is true (AC6)", () => {
    expect(shouldRunReview(withReview(true))).toBe(true);
  });

  test("returns false when review.enabled is false (AC7)", () => {
    expect(shouldRunReview(withReview(false))).toBe(false);
  });

  test("returns false when review is absent (AC7)", () => {
    const config = { execution: makeNaxConfig().execution };
    expect(shouldRunReview(config)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shouldRunRectification
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldRunRectification", () => {
  test("returns true when rectification.enabled is true (AC8)", () => {
    expect(shouldRunRectification(withRectification(true))).toBe(true);
  });

  test("returns false when rectification.enabled is false (AC9)", () => {
    expect(shouldRunRectification(withRectification(false))).toBe(false);
  });

  test("returns false when rectification is absent (AC9)", () => {
    const config = { execution: { ...makeNaxConfig().execution, rectification: undefined } };
    expect(shouldRunRectification(config)).toBe(false);
  });
});
