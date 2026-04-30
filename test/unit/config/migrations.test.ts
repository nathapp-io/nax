/**
 * Tests for config migration shims (ADR-009 §4.5).
 */

import { describe, expect, test } from "bun:test";
import { migrateLegacyReviewModelKey, migrateLegacyTestPattern } from "../../../src/config/migrations";

describe("migrateLegacyTestPattern", () => {
  test("no-op when testPattern absent", () => {
    const raw = { execution: { smartTestRunner: { enabled: true } } };
    const result = migrateLegacyTestPattern(raw, null);
    expect(result).toEqual(raw);
    expect(result).toBe(raw); // same reference (no copy needed when no migration)
  });

  test("aliases testPattern to testFilePatterns array when testFilePatterns absent", () => {
    const raw: Record<string, unknown> = {
      context: { testCoverage: { testPattern: "**/*.test.ts" } },
    };
    const result = migrateLegacyTestPattern(raw, null);

    const exec = result.execution as any;
    expect(exec?.smartTestRunner?.testFilePatterns).toEqual(["**/*.test.ts"]);

    // Legacy key is removed
    const ctx = result.context as any;
    expect(ctx?.testCoverage?.testPattern).toBeUndefined();
  });

  test("drops testPattern when testFilePatterns already set (canonical wins)", () => {
    const raw: Record<string, unknown> = {
      context: { testCoverage: { testPattern: "**/*.test.ts" } },
      execution: { smartTestRunner: { testFilePatterns: ["src/**/*.spec.ts"] } },
    };
    const result = migrateLegacyTestPattern(raw, null);

    const exec = result.execution as any;
    // Canonical value preserved unchanged
    expect(exec?.smartTestRunner?.testFilePatterns).toEqual(["src/**/*.spec.ts"]);

    // Legacy key removed from context
    const ctx = result.context as any;
    expect(ctx?.testCoverage?.testPattern).toBeUndefined();
  });

  test("is immutable: original object is not mutated", () => {
    const raw: Record<string, unknown> = {
      context: { testCoverage: { testPattern: "**/*.test.ts" } },
    };
    const original = structuredClone(raw);
    migrateLegacyTestPattern(raw, null);
    expect(raw).toEqual(original); // raw unchanged
  });

  test("handles missing context.testCoverage gracefully", () => {
    const raw: Record<string, unknown> = {
      context: { testCoverage: { testPattern: "*.spec.ts", extraField: "kept" } },
    };
    const result = migrateLegacyTestPattern(raw, null);
    // extraField preserved; testPattern removed
    const ctx = result.context as any;
    expect(ctx?.testCoverage?.extraField).toBe("kept");
    expect(ctx?.testCoverage?.testPattern).toBeUndefined();
  });

  test("handles completely absent context object", () => {
    const raw: Record<string, unknown> = {};
    const result = migrateLegacyTestPattern(raw, null);
    expect(result).toBe(raw); // no-op, same reference
  });

  test("wraps single string into array (not nested array)", () => {
    const raw: Record<string, unknown> = {
      context: { testCoverage: { testPattern: "src/**/*.spec.ts" } },
    };
    const result = migrateLegacyTestPattern(raw, null);
    const patterns = (result.execution as any)?.smartTestRunner?.testFilePatterns;
    expect(patterns).toEqual(["src/**/*.spec.ts"]);
    expect(typeof patterns[0]).toBe("string");
  });

  test("preserves existing smartTestRunner fields when aliasing", () => {
    const raw: Record<string, unknown> = {
      context: { testCoverage: { testPattern: "**/*.test.ts" } },
      execution: { smartTestRunner: { enabled: true, fallback: "import-grep" } },
    };
    const result = migrateLegacyTestPattern(raw, null);
    const runner = (result.execution as any)?.smartTestRunner;
    expect(runner?.enabled).toBe(true);
    expect(runner?.fallback).toBe("import-grep");
    expect(runner?.testFilePatterns).toEqual(["**/*.test.ts"]);
  });
});

// Issue #725 — review.semantic.modelTier and review.adversarial.modelTier
// were renamed to review.{semantic,adversarial}.model with widened type
// (ConfiguredModel). Existing user configs must keep loading; migration
// runs before Zod parse so .strip() doesn't silently drop the legacy key.
describe("migrateLegacyReviewModelKey", () => {
  test("no-op when review block absent", () => {
    const raw: Record<string, unknown> = { execution: {} };
    const result = migrateLegacyReviewModelKey(raw, null);
    expect(result).toBe(raw);
  });

  test("no-op when neither modelTier is set", () => {
    const raw: Record<string, unknown> = {
      review: { semantic: { rules: [] }, adversarial: { rules: [] } },
    };
    const result = migrateLegacyReviewModelKey(raw, null);
    expect(result).toBe(raw);
  });

  test("aliases semantic.modelTier to semantic.model", () => {
    const raw: Record<string, unknown> = {
      review: { semantic: { modelTier: "powerful", rules: [] } },
    };
    const result = migrateLegacyReviewModelKey(raw, null);
    const sem = (result.review as any)?.semantic;
    expect(sem?.model).toBe("powerful");
    expect(sem?.modelTier).toBeUndefined();
    expect(sem?.rules).toEqual([]);
  });

  test("aliases adversarial.modelTier to adversarial.model", () => {
    const raw: Record<string, unknown> = {
      review: { adversarial: { modelTier: "fast", parallel: true } },
    };
    const result = migrateLegacyReviewModelKey(raw, null);
    const adv = (result.review as any)?.adversarial;
    expect(adv?.model).toBe("fast");
    expect(adv?.modelTier).toBeUndefined();
    expect(adv?.parallel).toBe(true);
  });

  test("when both modelTier and model present, model wins and modelTier is dropped", () => {
    const raw: Record<string, unknown> = {
      review: {
        semantic: { modelTier: "fast", model: "powerful", rules: [] },
      },
    };
    const result = migrateLegacyReviewModelKey(raw, null);
    const sem = (result.review as any)?.semantic;
    expect(sem?.model).toBe("powerful");
    expect(sem?.modelTier).toBeUndefined();
  });

  test("does not mutate input", () => {
    const raw: Record<string, unknown> = {
      review: { semantic: { modelTier: "powerful", rules: [] } },
    };
    const original = structuredClone(raw);
    migrateLegacyReviewModelKey(raw, null);
    expect(raw).toEqual(original);
  });

  test("only one of {semantic, adversarial} migrating leaves the other untouched", () => {
    const raw: Record<string, unknown> = {
      review: {
        semantic: { modelTier: "fast", rules: [] },
        adversarial: { rules: [], model: "balanced" },
      },
    };
    const result = migrateLegacyReviewModelKey(raw, null);
    const sem = (result.review as any)?.semantic;
    const adv = (result.review as any)?.adversarial;
    expect(sem?.model).toBe("fast");
    expect(sem?.modelTier).toBeUndefined();
    expect(adv?.model).toBe("balanced");
    expect(adv?.modelTier).toBeUndefined();
  });
});
