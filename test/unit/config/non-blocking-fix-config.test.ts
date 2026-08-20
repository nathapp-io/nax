// test/unit/config/non-blocking-fix-config.test.ts
import { describe, expect, test } from "bun:test";
import { AdversarialReviewConfigSchema } from "@/config/schemas-review";

describe("nonBlockingFix config", () => {
  test("defaults: disabled, scope both, 1 regression attempt, verifierGuard on", () => {
    const cfg = AdversarialReviewConfigSchema.parse({ nonBlockingFix: {} });
    expect(cfg.nonBlockingFix).toEqual({
      enabled: false,
      scope: "both",
      regressionAttempts: 1,
      verifierGuard: true,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
    });
  });

  test("absent nonBlockingFix parses to undefined", () => {
    const cfg = AdversarialReviewConfigSchema.parse({});
    expect(cfg.nonBlockingFix).toBeUndefined();
  });

  test("rejects scope outside source|both|triage", () => {
    expect(() => AdversarialReviewConfigSchema.parse({ nonBlockingFix: { scope: "test" } })).toThrow();
  });

  test("rejects negative regressionAttempts", () => {
    expect(() => AdversarialReviewConfigSchema.parse({ nonBlockingFix: { regressionAttempts: -1 } })).toThrow();
  });

  test("scope: 'triage' parses successfully", () => {
    const cfg = AdversarialReviewConfigSchema.parse({ nonBlockingFix: { enabled: true, scope: "triage" } });
    expect(cfg.nonBlockingFix?.scope).toBe("triage");
  });

  test("scope: defaults to 'both' when unset", () => {
    const cfg = AdversarialReviewConfigSchema.parse({ nonBlockingFix: {} });
    expect(cfg.nonBlockingFix?.scope).toBe("both");
  });

  test("scope: rejects values outside source|both|triage", () => {
    expect(() =>
      AdversarialReviewConfigSchema.parse({ nonBlockingFix: { enabled: true, scope: "invalid" } }),
    ).toThrow();
  });

  test("AC-1: sourceDiffCap defaults maxFiles and maxLines when unset", () => {
    const cfg = AdversarialReviewConfigSchema.parse({ nonBlockingFix: {} });
    expect(cfg.nonBlockingFix?.sourceDiffCap?.maxFiles).toBe(10);
    expect(cfg.nonBlockingFix?.sourceDiffCap?.maxLines).toBe(500);
  });

  test("sourceDiffCap user values are preserved verbatim", () => {
    const cfg = AdversarialReviewConfigSchema.parse({
      nonBlockingFix: { sourceDiffCap: { maxFiles: 3, maxLines: 50 } },
    });
    expect(cfg.nonBlockingFix?.sourceDiffCap).toEqual({ maxFiles: 3, maxLines: 50 });
  });

  test("sourceDiffCap rejects negative values", () => {
    expect(() =>
      AdversarialReviewConfigSchema.parse({ nonBlockingFix: { sourceDiffCap: { maxFiles: -1, maxLines: 50 } } }),
    ).toThrow();
    expect(() =>
      AdversarialReviewConfigSchema.parse({ nonBlockingFix: { sourceDiffCap: { maxFiles: 5, maxLines: -10 } } }),
    ).toThrow();
  });
});
