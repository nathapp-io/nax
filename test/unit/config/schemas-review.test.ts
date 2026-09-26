// test/unit/config/schemas-review.test.ts
import { describe, expect, test } from "bun:test";
import { AdversarialReviewConfigSchema, NaxConfigSchema, ReviewConfigSchema } from "@/config";

describe("AdversarialReviewConfigSchema.recurrenceDemotion", () => {
  test("defaults to enabled with maxBlockingRounds 2", () => {
    const parsed = AdversarialReviewConfigSchema.parse({});
    expect(parsed.recurrenceDemotion).toEqual({ enabled: true, maxBlockingRounds: 2, maxAdvisoryRounds: 2 });
  });
  test("accepts overrides", () => {
    const parsed = AdversarialReviewConfigSchema.parse({
      recurrenceDemotion: { enabled: false, maxBlockingRounds: 3 },
    });
    expect(parsed.recurrenceDemotion).toEqual({ enabled: false, maxBlockingRounds: 3, maxAdvisoryRounds: 2 });
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

/**
 * US-001 — `review.fixReview` (the scoped review of a fix's own delta).
 * AC1-AC3 read the field through `NaxConfigSchema.parse({})` — the DEFAULT_CONFIG
 * path — because that is the value an unconfigured repo actually runs on;
 * `ReviewConfigSchema` alone would only prove the inner schema is well-formed.
 * AC4 pins the constraint on `timeoutMs`.
 */
describe("ReviewConfigSchema.fixReview (US-001)", () => {
  test("US-001 AC1: NaxConfigSchema.parse({}) defaults review.fixReview.enabled to true", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.review.fixReview).toBeDefined();
    expect(parsed.review.fixReview.enabled).toBe(true);
  });

  test("US-001 AC2: NaxConfigSchema.parse({}) defaults review.fixReview.timeoutMs to 600000", () => {
    expect(NaxConfigSchema.parse({}).review.fixReview.timeoutMs).toBe(600_000);
  });

  test("US-001 AC3: NaxConfigSchema.parse({}) carries a fixReview block with no model", () => {
    const fixReview = NaxConfigSchema.parse({}).review.fixReview;
    expect(fixReview.model).toBeUndefined();
    // The block still carries its two defaults: "no model" is a real absence in
    // a populated block, not an empty placeholder that would pass vacuously.
    expect(fixReview).toEqual({ enabled: true, timeoutMs: 600_000 });
  });

  test("US-001 AC3 boundary: a configured review.fixReview.model round-trips through a full config", () => {
    const parsed = NaxConfigSchema.parse({
      review: {
        enabled: true,
        checks: [],
        commands: {},
        fixReview: { model: { agent: "claude", model: "claude-opus-4-6" } },
      },
    });
    expect(parsed.review.fixReview.model).toEqual({ agent: "claude", model: "claude-opus-4-6" });
  });

  test("US-001 AC4: NaxConfigSchema rejects review.fixReview.timeoutMs 0 with an issue on that path", () => {
    const result = NaxConfigSchema.safeParse({ review: { fixReview: { timeoutMs: 0 } } });
    const issuePaths = result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
    expect(result.success).toBe(false);
    expect(issuePaths).toContain("review.fixReview.timeoutMs");
  });

  test("US-001 AC4 boundary: on a complete review config, timeoutMs 0 is the ONLY rejected path", () => {
    const result = NaxConfigSchema.safeParse({
      review: { enabled: true, checks: [], commands: {}, fixReview: { timeoutMs: 0 } },
    });
    const issuePaths = result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
    expect(result.success).toBe(false);
    expect(issuePaths).toEqual(["review.fixReview.timeoutMs"]);
  });
});
