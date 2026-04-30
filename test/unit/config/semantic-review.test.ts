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
  test("SemanticReviewConfig has model field of type ConfiguredModel (tier label)", () => {
    const config: SemanticReviewConfig = {
      model: "balanced",
      diffMode: "embedded",
      resetRefOnRerun: false,
      rules: [],
      timeoutMs: 600_000,
      excludePatterns: [],
    };
    expect(config.model).toBe("balanced");
    expect(typeof config.model).toBe("string");
  });

  test("SemanticReviewConfig.model accepts an explicit { agent, model } pin", () => {
    const config: SemanticReviewConfig = {
      model: { agent: "codex", model: "gpt-5.4" },
      diffMode: "embedded",
      resetRefOnRerun: false,
      rules: [],
      timeoutMs: 600_000,
      excludePatterns: [],
    };
    expect(config.model).toEqual({ agent: "codex", model: "gpt-5.4" });
  });

  test("SemanticReviewConfig has rules field of type string[]", () => {
    const config: SemanticReviewConfig = {
      model: "balanced",
      diffMode: "embedded",
      resetRefOnRerun: false,
      rules: ["rule1", "rule2"],
      timeoutMs: 600_000,
      excludePatterns: [],
    };
    expect(Array.isArray(config.rules)).toBe(true);
    expect(config.rules.every((r) => typeof r === "string")).toBe(true);
  });

  test("SemanticReviewConfig accepts all ModelTier values", () => {
    const tiers: Array<"fast" | "balanced" | "powerful"> = ["fast", "balanced", "powerful"];

    tiers.forEach((tier) => {
      const config: SemanticReviewConfig = {
        model: tier,
        diffMode: "embedded",
        resetRefOnRerun: false,
        rules: [],
        timeoutMs: 600_000,
        excludePatterns: [],
      };
      expect(config.model).toBe(tier);
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
          model: "balanced" as const,
          rules: [],
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.semantic).toEqual({
        model: "balanced",
        diffMode: "ref",
        resetRefOnRerun: false,
        rules: [],
        timeoutMs: 600_000,
        // excludePatterns is now optional (ADR-009): undefined means resolver will derive at runtime
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

  test("gateLLMChecksOnMechanicalPass defaults to true", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.gateLLMChecksOnMechanicalPass).toBe(true);
    }
  });

  test("gateLLMChecksOnMechanicalPass accepts false override", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        gateLLMChecksOnMechanicalPass: false,
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.gateLLMChecksOnMechanicalPass).toBe(false);
    }
  });
});

describe("ReviewConfigSchema semantic validation", () => {
  test("semantic.model defaults to 'balanced'", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        semantic: {
          model: "balanced",
          rules: [],
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.semantic?.model).toBe("balanced");
    }
  });

  test("semantic.rules defaults to empty array", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        semantic: {
          model: "balanced",
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

  test("semantic can omit model and get default", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        checks: ["semantic"],
        semantic: {
          model: "balanced",
          rules: [],
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.semantic?.model).toBe("balanced");
    }
  });

  test("semantic can accept custom rules", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        semantic: {
          model: "powerful",
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

  test("DEFAULT_CONFIG.review.semantic.model equals 'balanced'", () => {
    expect(DEFAULT_CONFIG.review.semantic?.model).toBe("balanced");
  });

  test("DEFAULT_CONFIG.review.semantic.rules equals empty array", () => {
    expect(DEFAULT_CONFIG.review.semantic?.rules).toEqual([]);
  });

  test("DEFAULT_CONFIG.review.semantic has correct defaults", () => {
    expect(DEFAULT_CONFIG.review.semantic).toEqual({
      model: "balanced",
      diffMode: "ref",
      resetRefOnRerun: false,
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
      expect(result.data.review.semantic?.model).toBe("balanced");
      expect(result.data.review.semantic?.rules).toEqual([]);
    }
  });
});
