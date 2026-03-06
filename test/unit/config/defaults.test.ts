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
