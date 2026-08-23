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
import { DEFAULT_CONFIG } from "@/config/defaults";
import { NaxConfigSchema } from "@/config/schemas";

describe("DEFAULT_CONFIG review.checks", () => {
  test("default review.checks is ['typecheck', 'lint'] without 'test'", () => {
    expect(DEFAULT_CONFIG.review.checks).toEqual(["typecheck", "lint"]);
  });

  test("default review.checks does not include 'test'", () => {
    expect(DEFAULT_CONFIG.review.checks).not.toContain("test");
  });

  test.each([["typecheck"], ["lint"]] as const)("default review.checks includes '%s'", (check) => {
    expect(DEFAULT_CONFIG.review.checks).toContain(check);
  });
});

describe("schema backwards compatibility: 'test' remains a valid review check", () => {
  test.each([[["typecheck", "lint", "test"]], [["test"]]])("schema accepts review.checks %j", (checks) => {
    const config = { ...DEFAULT_CONFIG, review: { ...DEFAULT_CONFIG.review, checks } };
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
  test.each([[["typecheck", "lint", "build"]], [["build"]]])("schema accepts review.checks %j", (checks) => {
    const config = { ...DEFAULT_CONFIG, review: { ...DEFAULT_CONFIG.review, checks } };
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

  test.each([
    ["fast" as const, "haiku"],
    ["balanced" as const, "sonnet"],
    ["powerful" as const, "opus"],
  ])("models.claude.%s is '%s'", (tier, expected) => {
    expect(DEFAULT_CONFIG.models.claude[tier]).toBe(expected);
  });
});

describe("DEFAULT_CONFIG.precheck.storySizeGate (US-001)", () => {
  test.each([
    ["action" as const, "block" as const],
    ["maxReplanAttempts" as const, 3 as const],
    ["maxAcCount" as const, 10 as const],
    ["maxDescriptionLength" as const, 3000 as const],
    ["maxBulletPoints" as const, 12 as const],
  ])("precheck.storySizeGate.%s defaults to %s", (field, expected) => {
    expect(DEFAULT_CONFIG.precheck.storySizeGate[field]).toBe(expected);
  });
});
