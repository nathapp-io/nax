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

  test("AC-1: scope 'triage' parses successfully", () => {
    const cfg = AdversarialReviewConfigSchema.parse({ nonBlockingFix: { enabled: true, scope: "triage" } });
    expect(cfg.nonBlockingFix?.scope).toBe("triage");
  });

  test("AC-2: scope defaults to 'both' when unset", () => {
    const cfg = AdversarialReviewConfigSchema.parse({ nonBlockingFix: {} });
    expect(cfg.nonBlockingFix?.scope).toBe("both");
  });

  test("AC-3: rejects scope outside source|both|triage", () => {
    expect(() =>
      AdversarialReviewConfigSchema.parse({ nonBlockingFix: { enabled: true, scope: "invalid" } }),
    ).toThrow();
  });
});
