import { describe, expect, test } from "bun:test";
import type { StoryRunResult } from "@/execution";

/**
 * Slice D shape verification: StoryRunResult (src/execution/types.ts)
 * preserves all required and optional fields.
 *
 * These tests construct concrete conforming values using the public StoryRunResult
 * type alias and assert on each field, providing the shape verification that
 * runtime module-reflection tests cannot express.
 */
describe("StoryRunResult shape fields (Slice D rename verification)", () => {
  test("required fields — success, sessions, needsHumanReview, totalCost, lite", () => {
    const result: StoryRunResult = {
      success: true,
      sessions: [],
      needsHumanReview: false,
      totalCost: 0,
      lite: false,
    };

    expect(result.success).toBe(true);
    expect(result.sessions).toEqual([]);
    expect(result.needsHumanReview).toBe(false);
    expect(result.totalCost).toBe(0);
    expect(result.lite).toBe(false);
  });

  test("optional reviewReason is present when needsHumanReview is true", () => {
    const result: StoryRunResult = {
      success: false,
      sessions: [],
      needsHumanReview: true,
      reviewReason: "verifier rejected",
      totalCost: 0.5,
      lite: false,
    };

    expect(result.needsHumanReview).toBe(true);
    expect(result.reviewReason).toBe("verifier rejected");
  });

  test("optional failureCategory covers all defined variants", () => {
    const categories: NonNullable<StoryRunResult["failureCategory"]>[] = [
      "isolation-violation",
      "session-failure",
      "tests-failing",
      "full-suite-gate-exhausted",
      "verifier-rejected",
      "greenfield-no-tests",
      "dependency-prep",
      "runtime-crash",
    ];

    for (const category of categories) {
      const result: StoryRunResult = {
        success: false,
        sessions: [],
        needsHumanReview: false,
        totalCost: 0,
        lite: false,
        failureCategory: category,
      };
      expect(result.failureCategory).toBe(category);
    }
  });

  test("optional fullSuiteGatePassed field is preserved", () => {
    const passed: StoryRunResult = {
      success: true,
      sessions: [],
      needsHumanReview: false,
      totalCost: 0,
      lite: false,
      fullSuiteGatePassed: true,
    };
    const failed: StoryRunResult = { ...passed, fullSuiteGatePassed: false };

    expect(passed.fullSuiteGatePassed).toBe(true);
    expect(failed.fullSuiteGatePassed).toBe(false);
    expect({ ...passed, fullSuiteGatePassed: undefined }.fullSuiteGatePassed).toBeUndefined();
  });

  test("totalTokenUsage and totalDurationMs are optional aggregation fields", () => {
    const withoutAggregates: StoryRunResult = {
      success: true,
      sessions: [],
      needsHumanReview: false,
      totalCost: 0,
      lite: false,
    };
    expect(withoutAggregates.totalTokenUsage).toBeUndefined();
    expect(withoutAggregates.totalDurationMs).toBeUndefined();

    const withAggregates: StoryRunResult = {
      ...withoutAggregates,
      totalDurationMs: 12345,
    };
    expect(withAggregates.totalDurationMs).toBe(12345);
  });
});
