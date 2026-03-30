// RE-ARCH: keep
/**
 * DEFAULT_CONFIG.review.checks default value tests
 *
 * Verifies that the default review.checks array does NOT include 'test',
 * since test execution is handled by the verify stage and is redundant
 * in the review stage.
 *
 * 'test' must still be a valid enum value in the schema (backwards compat).
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";

describe("DEFAULT_CONFIG review.checks", () => {
  test("default review.checks is ['typecheck', 'lint'] without 'test'", () => {
    expect(DEFAULT_CONFIG.review.checks).toEqual(["typecheck", "lint"]);
  });

  test("default review.checks does not include 'test'", () => {
    expect(DEFAULT_CONFIG.review.checks).not.toContain("test");
  });

  test("default review.checks includes 'typecheck'", () => {
    expect(DEFAULT_CONFIG.review.checks).toContain("typecheck");
  });

  test("default review.checks includes 'lint'", () => {
    expect(DEFAULT_CONFIG.review.checks).toContain("lint");
  });
});

describe("schema backwards compatibility: 'test' remains a valid review check", () => {
  test("schema accepts review.checks containing 'test'", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        checks: ["typecheck", "lint", "test"],
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("schema accepts review.checks with only 'test'", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        checks: ["test"],
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("schema rejects review.checks with unknown check name", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        checks: ["typecheck", "lint", "unknown-check"],
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe("schema: 'build' is a valid review check (BUILD-001)", () => {
  test("schema accepts review.checks containing 'build'", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        checks: ["typecheck", "lint", "build"],
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("schema accepts review.checks with only 'build'", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        checks: ["build"],
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("schema accepts review.commands.build", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        checks: ["build"],
        commands: { build: "bun run build" },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.commands.build).toBe("bun run build");
    }
  });
});

describe("DEFAULT_CONFIG.models per-agent shape (US-001-4)", () => {
  test("models has per-agent structure with 'claude' key", () => {
    expect(DEFAULT_CONFIG.models).toHaveProperty("claude");
  });

  test("models.claude has fast/balanced/powerful tiers as strings", () => {
    expect(DEFAULT_CONFIG.models.claude).toEqual({
      fast: "haiku",
      balanced: "sonnet",
      powerful: "opus",
    });
  });

  test("models.claude.fast is 'haiku'", () => {
    expect(DEFAULT_CONFIG.models.claude.fast).toBe("haiku");
  });

  test("models.claude.balanced is 'sonnet'", () => {
    expect(DEFAULT_CONFIG.models.claude.balanced).toBe("sonnet");
  });

  test("models.claude.powerful is 'opus'", () => {
    expect(DEFAULT_CONFIG.models.claude.powerful).toBe("opus");
  });
});

describe("DEFAULT_CONFIG.autoMode.fallbackOrder (US-001-4)", () => {
  test("fallbackOrder is ['claude']", () => {
    expect(DEFAULT_CONFIG.autoMode.fallbackOrder).toEqual(["claude"]);
  });

  test("fallbackOrder is an array", () => {
    expect(Array.isArray(DEFAULT_CONFIG.autoMode.fallbackOrder)).toBe(true);
  });

  test("fallbackOrder contains exactly one element", () => {
    expect(DEFAULT_CONFIG.autoMode.fallbackOrder).toHaveLength(1);
  });

  test("fallbackOrder[0] is 'claude'", () => {
    expect(DEFAULT_CONFIG.autoMode.fallbackOrder[0]).toBe("claude");
  });
});
