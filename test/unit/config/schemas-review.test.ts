// test/unit/config/schemas-review.test.ts
import { describe, expect, test } from "bun:test";
import { AdversarialReviewConfigSchema, ReviewConfigSchema } from "@/config";

describe("AdversarialReviewConfigSchema.recurrenceDemotion", () => {
  test("defaults to enabled with maxBlockingRounds 2", () => {
    const parsed = AdversarialReviewConfigSchema.parse({});
    expect(parsed.recurrenceDemotion).toEqual({ enabled: true, maxBlockingRounds: 2 });
  });
  test("accepts overrides", () => {
    const parsed = AdversarialReviewConfigSchema.parse({
      recurrenceDemotion: { enabled: false, maxBlockingRounds: 3 },
    });
    expect(parsed.recurrenceDemotion).toEqual({ enabled: false, maxBlockingRounds: 3 });
  });
});

describe("ReviewConfigSchema.conflictDetection", () => {
  test("defaults enabled with maxOscillations 2", () => {
    const parsed = ReviewConfigSchema.parse({ enabled: true, checks: [], commands: {} });
    expect(parsed.conflictDetection).toEqual({ enabled: true, maxOscillations: 2, maxCrossAttemptRecurrences: 2 });
  });

  test("accepts a maxOscillations override", () => {
    const parsed = ReviewConfigSchema.parse({
      enabled: true,
      checks: [],
      commands: {},
      conflictDetection: { maxOscillations: 4 },
    });
    expect(parsed.conflictDetection.maxOscillations).toBe(4);
  });
});
