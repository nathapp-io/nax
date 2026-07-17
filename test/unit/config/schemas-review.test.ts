// test/unit/config/schemas-review.test.ts
import { describe, expect, test } from "bun:test";
import { AdversarialReviewConfigSchema } from "@/config";

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
