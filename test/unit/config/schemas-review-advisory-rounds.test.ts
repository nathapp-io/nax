// test/unit/config/schemas-review-advisory-rounds.test.ts
// US-002: Configure advisory recurrence cap
import { describe, expect, test } from "bun:test";
import { AdversarialReviewConfigSchema, SemanticReviewConfigSchema } from "@/config";

describe("AdversarialReviewConfigSchema.recurrenceDemotion.maxAdvisoryRounds", () => {
  // AC1: When adversarial recurrenceDemotion.maxAdvisoryRounds is unset, schema parsing resolves it to 2.
  test("US-002-AC1: defaults to 2 when unset", () => {
    const parsed = AdversarialReviewConfigSchema.parse({});
    expect(parsed.recurrenceDemotion.maxAdvisoryRounds).toBe(2);
  });

  // AC5: When adversarial recurrenceDemotion.maxAdvisoryRounds is 5, schema parsing resolves it to 5.
  test("US-002-AC5: accepts explicit value of 5", () => {
    const parsed = AdversarialReviewConfigSchema.parse({
      recurrenceDemotion: { maxAdvisoryRounds: 5 },
    });
    expect(parsed.recurrenceDemotion.maxAdvisoryRounds).toBe(5);
  });

  // AC4: When either review config sets recurrenceDemotion.maxAdvisoryRounds to 0, schema validation rejects it.
  test("US-002-AC4: rejects 0 on adversarial", () => {
    const result = AdversarialReviewConfigSchema.safeParse({
      recurrenceDemotion: { maxAdvisoryRounds: 0 },
    });
    expect(result.success).toBe(false);
  });
});

describe("SemanticReviewConfigSchema.recurrenceDemotion.maxAdvisoryRounds", () => {
  // AC2: When semantic recurrenceDemotion.maxAdvisoryRounds is unset, schema parsing resolves it to 2.
  test("US-002-AC2: defaults to 2 when unset", () => {
    const parsed = SemanticReviewConfigSchema.parse({});
    expect(parsed.recurrenceDemotion.maxAdvisoryRounds).toBe(2);
  });

  // AC4: When either review config sets recurrenceDemotion.maxAdvisoryRounds to 0, schema validation rejects it.
  test("US-002-AC4: rejects 0 on semantic", () => {
    const result = SemanticReviewConfigSchema.safeParse({
      recurrenceDemotion: { maxAdvisoryRounds: 0 },
    });
    expect(result.success).toBe(false);
  });
});

describe("SemanticReviewConfigSchema.recurrenceDemotion.enabled default", () => {
  // AC3: When semantic recurrenceDemotion.enabled is unset, schema parsing resolves it to false.
  test("US-002-AC3: enabled defaults to false when recurrenceDemotion is provided", () => {
    const parsed = SemanticReviewConfigSchema.parse({
      recurrenceDemotion: {},
    });
    expect(parsed.recurrenceDemotion.enabled).toBe(false);
  });
});
