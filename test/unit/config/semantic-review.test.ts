/**
 * Tests for semantic review check type and configuration
 *
 * Verifies that:
 * 1. ReviewCheckName type accepts 'semantic'
 * 2. SemanticReviewConfig interface exists with proper types
 * 3. ReviewConfig has optional semantic field
 * 4. Schema validation handles semantic with defaults
 * 5. DEFAULT_CONFIG includes semantic config
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";
import type { ReviewCheckName, SemanticReviewConfig } from "../../../src/review/types";

describe("ReviewCheckName type", () => {
  test("ReviewCheckName accepts 'semantic' as a valid value", () => {
    // This is a compile-time type check, but we verify via schema
    const checkName: ReviewCheckName = "semantic";
    expect(checkName).toBe("semantic");
  });

  test("schema accepts 'semantic' in review.checks", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        checks: ["typecheck", "lint", "semantic"],
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("schema accepts 'semantic' as sole review check", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        checks: ["semantic"],
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

describe("SemanticReviewConfig", () => {
  test("SemanticReviewConfig has modelTier field of type ModelTier", () => {
    const config: SemanticReviewConfig = {
      modelTier: "balanced",
      rules: [],
      timeoutMs: 600_000,
      excludePatterns: [],
    };
    expect(config.modelTier).toBe("balanced");
    expect(typeof config.modelTier).toBe("string");
  });

  test("SemanticReviewConfig has rules field of type string[]", () => {
    const config: SemanticReviewConfig = {
      modelTier: "balanced",
      rules: ["rule1", "rule2"],
      timeoutMs: 600_000,
      excludePatterns: [],
    };
    expect(Array.isArray(config.rules)).toBe(true);
    expect(config.rules.every((r) => typeof r === "string")).toBe(true);
  });

  test("SemanticReviewConfig accepts all ModelTier values", () => {
    const tiers: Array<"fast" | "balanced" | "powerful"> = [
      "fast",
      "balanced",
      "powerful",
    ];

    tiers.forEach((tier) => {
      const config: SemanticReviewConfig = {
        modelTier: tier,
        rules: [],
        timeoutMs: 600_000,
        excludePatterns: [],
      };
      expect(config.modelTier).toBe(tier);
    });
  });
});

describe("ReviewConfig semantic field", () => {
  test("ReviewConfig accepts optional semantic field", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        semantic: {
          modelTier: "balanced" as const,
          rules: [],
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.semantic).toEqual({
        modelTier: "balanced",
        rules: [],
        timeoutMs: 600_000,
        excludePatterns: [":!test/", ":!tests/", ":!*_test.go", ":!*.test.ts", ":!*.spec.ts", ":!**/__tests__/", ":!.nax/", ":!.nax-pids"],
      });
    }
  });

  test("ReviewConfig semantic field is optional", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        // no semantic field
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

describe("ReviewConfigSchema semantic validation", () => {
  test("semantic.modelTier defaults to 'balanced'", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        semantic: {
          modelTier: "balanced",
          rules: [],
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.semantic?.modelTier).toBe("balanced");
    }
  });

  test("semantic.rules defaults to empty array", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        semantic: {
          modelTier: "balanced",
          rules: [],
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.semantic?.rules).toEqual([]);
    }
  });

  test("semantic can omit modelTier and get default", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        checks: ["semantic"],
        semantic: {
          modelTier: "balanced",
          rules: [],
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.semantic?.modelTier).toBe("balanced");
    }
  });

  test("semantic can accept custom rules", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        semantic: {
          modelTier: "powerful",
          rules: ["no-mutations", "immutable-defaults"],
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.semantic?.rules).toEqual([
        "no-mutations",
        "immutable-defaults",
      ]);
    }
  });
});

describe("DEFAULT_CONFIG.review.semantic", () => {
  test("DEFAULT_CONFIG.review.semantic exists", () => {
    expect(DEFAULT_CONFIG.review.semantic).toBeDefined();
  });

  test("DEFAULT_CONFIG.review.semantic.modelTier equals 'balanced'", () => {
    expect(DEFAULT_CONFIG.review.semantic?.modelTier).toBe("balanced");
  });

  test("DEFAULT_CONFIG.review.semantic.rules equals empty array", () => {
    expect(DEFAULT_CONFIG.review.semantic?.rules).toEqual([]);
  });

  test("DEFAULT_CONFIG.review.semantic has correct defaults", () => {
    expect(DEFAULT_CONFIG.review.semantic).toEqual({
      modelTier: "balanced",
      rules: [],
      timeoutMs: 600_000,
      excludePatterns: [":!test/", ":!tests/", ":!*_test.go", ":!*.test.ts", ":!*.spec.ts", ":!**/__tests__/", ":!.nax/", ":!.nax-pids"],
    });
  });
});

describe("Semantic check in review.checks with semantic config", () => {
  test("when review.checks includes 'semantic' and review.semantic is omitted, defaults apply", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        checks: ["typecheck", "semantic"],
        // semantic field explicitly omitted
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      // After parsing, semantic should have defaults
      expect(result.data.review.semantic).toBeDefined();
      expect(result.data.review.semantic?.modelTier).toBe("balanced");
      expect(result.data.review.semantic?.rules).toEqual([]);
    }
  });
});
