/**
 * Tests for config migration shims (ADR-009 §4.5).
 */

import { describe, expect, test } from "bun:test";
import { migrateLegacyReviewModelKey, migrateLegacyTestPattern } from "@/config/migrations";

// ─── Raw-config probes ───────────────────────────────────────────────────────

/**
 * User-defined narrowing predicate: v is a non-null object carrying `key`.
 * Post-migration configs are `Record<string, unknown>`, so nested reads need
 * `in`-narrowing instead of property access on opaque values.
 */
function hasKey<K extends string>(v: unknown, key: K): v is object & Record<K, unknown> {
  return typeof v === "object" && v !== null && key in v;
}

/**
 * Walk a key path through a raw (pre-Zod) config object, yielding `undefined`
 * whenever any hop is missing — mirroring the optional-chain reads these
 * tests made before the drain.
 */
function probe(root: unknown, keys: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of keys) {
    if (!hasKey(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

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

    expect(probe(result, ["execution", "smartTestRunner", "testFilePatterns"])).toEqual(["**/*.test.ts"]);

    // Legacy key is removed
    expect(probe(result, ["context", "testCoverage", "testPattern"])).toBeUndefined();
  });

  test("drops testPattern when testFilePatterns already set (canonical wins)", () => {
    const raw: Record<string, unknown> = {
      context: { testCoverage: { testPattern: "**/*.test.ts" } },
      execution: { smartTestRunner: { testFilePatterns: ["src/**/*.spec.ts"] } },
    };
    const result = migrateLegacyTestPattern(raw, null);

    // Canonical value preserved unchanged
    expect(probe(result, ["execution", "smartTestRunner", "testFilePatterns"])).toEqual(["src/**/*.spec.ts"]);

    // Legacy key removed from context
    expect(probe(result, ["context", "testCoverage", "testPattern"])).toBeUndefined();
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
    expect(probe(result, ["context", "testCoverage", "extraField"])).toBe("kept");
    expect(probe(result, ["context", "testCoverage", "testPattern"])).toBeUndefined();
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
    const patterns = probe(result, ["execution", "smartTestRunner", "testFilePatterns"]);
    expect(patterns).toEqual(["src/**/*.spec.ts"]);
    const firstPattern: unknown = Array.isArray(patterns) ? patterns[0] : undefined;
    expect(typeof firstPattern).toBe("string");
  });

  test("preserves existing smartTestRunner fields when aliasing", () => {
    const raw: Record<string, unknown> = {
      context: { testCoverage: { testPattern: "**/*.test.ts" } },
      execution: { smartTestRunner: { enabled: true, fallback: "import-grep" } },
    };
    const result = migrateLegacyTestPattern(raw, null);
    expect(probe(result, ["execution", "smartTestRunner", "enabled"])).toBe(true);
    expect(probe(result, ["execution", "smartTestRunner", "fallback"])).toBe("import-grep");
    expect(probe(result, ["execution", "smartTestRunner", "testFilePatterns"])).toEqual(["**/*.test.ts"]);
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
    expect(probe(result, ["review", "semantic", "model"])).toBe("powerful");
    expect(probe(result, ["review", "semantic", "modelTier"])).toBeUndefined();
    expect(probe(result, ["review", "semantic", "rules"])).toEqual([]);
  });

  test("aliases adversarial.modelTier to adversarial.model", () => {
    const raw: Record<string, unknown> = {
      review: { adversarial: { modelTier: "fast", parallel: true } },
    };
    const result = migrateLegacyReviewModelKey(raw, null);
    expect(probe(result, ["review", "adversarial", "model"])).toBe("fast");
    expect(probe(result, ["review", "adversarial", "modelTier"])).toBeUndefined();
    expect(probe(result, ["review", "adversarial", "parallel"])).toBe(true);
  });

  test("when both modelTier and model present, model wins and modelTier is dropped", () => {
    const raw: Record<string, unknown> = {
      review: {
        semantic: { modelTier: "fast", model: "powerful", rules: [] },
      },
    };
    const result = migrateLegacyReviewModelKey(raw, null);
    expect(probe(result, ["review", "semantic", "model"])).toBe("powerful");
    expect(probe(result, ["review", "semantic", "modelTier"])).toBeUndefined();
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
    expect(probe(result, ["review", "semantic", "model"])).toBe("fast");
    expect(probe(result, ["review", "semantic", "modelTier"])).toBeUndefined();
    expect(probe(result, ["review", "adversarial", "model"])).toBe("balanced");
    expect(probe(result, ["review", "adversarial", "modelTier"])).toBeUndefined();
  });
});
