// test/unit/config/non-blocking-fix-config.test.ts
import { describe, expect, test } from "bun:test";
import { AdversarialReviewConfigSchema } from "../../../src/config/schemas-review";

describe("nonBlockingFix config", () => {
  test("defaults: disabled, scope both, 1 regression attempt, verifierGuard on", () => {
    const cfg = AdversarialReviewConfigSchema.parse({ nonBlockingFix: {} });
    expect(cfg.nonBlockingFix).toEqual({
      enabled: false,
      scope: "both",
      regressionAttempts: 1,
      verifierGuard: true,
    });
  });

  test("absent nonBlockingFix parses to undefined", () => {
    const cfg = AdversarialReviewConfigSchema.parse({});
    expect(cfg.nonBlockingFix).toBeUndefined();
  });

  test("rejects scope outside source|both", () => {
    expect(() => AdversarialReviewConfigSchema.parse({ nonBlockingFix: { scope: "test" } })).toThrow();
  });

  test("rejects negative regressionAttempts", () => {
    expect(() => AdversarialReviewConfigSchema.parse({ nonBlockingFix: { regressionAttempts: -1 } })).toThrow();
  });
});
