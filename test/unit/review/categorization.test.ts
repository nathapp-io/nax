import { describe, expect, test } from "bun:test";
import {
  isLlmReviewCheck,
  isMechanicalReviewCheck,
  LLM_REVIEW_CHECKS,
  MECHANICAL_REVIEW_CHECKS,
  ORDERED_LLM_REVIEW_CHECKS,
  ORDERED_MECHANICAL_REVIEW_CHECKS,
} from "@/review/categorization";
import type { ReviewCheckName } from "@/review/types";

describe("review check categorization", () => {
  test("ORDERED_MECHANICAL_REVIEW_CHECKS lists the mechanical checks in gate order", () => {
    expect(ORDERED_MECHANICAL_REVIEW_CHECKS).toEqual(["typecheck", "build", "lint", "test"]);
  });

  test("ORDERED_LLM_REVIEW_CHECKS lists the LLM checks in review order", () => {
    expect(ORDERED_LLM_REVIEW_CHECKS).toEqual(["semantic", "adversarial"]);
  });

  test("MECHANICAL_REVIEW_CHECKS and LLM_REVIEW_CHECKS mirror the ordered lists as sets", () => {
    expect(MECHANICAL_REVIEW_CHECKS).toEqual(new Set(ORDERED_MECHANICAL_REVIEW_CHECKS));
    expect(LLM_REVIEW_CHECKS).toEqual(new Set(ORDERED_LLM_REVIEW_CHECKS));
  });

  test("every ReviewCheckName is classified as exactly one of mechanical or LLM", () => {
    const all: ReviewCheckName[] = [...ORDERED_MECHANICAL_REVIEW_CHECKS, ...ORDERED_LLM_REVIEW_CHECKS];
    for (const check of all) {
      expect(isMechanicalReviewCheck(check) !== isLlmReviewCheck(check)).toBe(true);
    }
  });

  describe("isLlmReviewCheck", () => {
    test("returns true for semantic and adversarial", () => {
      expect(isLlmReviewCheck("semantic")).toBe(true);
      expect(isLlmReviewCheck("adversarial")).toBe(true);
    });

    test("returns false for a mechanical check", () => {
      expect(isLlmReviewCheck("typecheck")).toBe(false);
    });
  });

  describe("isMechanicalReviewCheck", () => {
    test("returns true for typecheck, build, lint, and test", () => {
      expect(isMechanicalReviewCheck("typecheck")).toBe(true);
      expect(isMechanicalReviewCheck("build")).toBe(true);
      expect(isMechanicalReviewCheck("lint")).toBe(true);
      expect(isMechanicalReviewCheck("test")).toBe(true);
    });

    test("returns false for an LLM check", () => {
      expect(isMechanicalReviewCheck("adversarial")).toBe(false);
    });
  });
});
