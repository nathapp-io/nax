/**
 * Tests for config migration shims (ADR-009 §4.5).
 */

import { describe, expect, test } from "bun:test";
import { migrateLegacyTestPattern } from "../../../src/config/migrations";

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
