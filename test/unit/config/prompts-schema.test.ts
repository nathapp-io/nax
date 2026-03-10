/**
 * Unit Tests: PromptsConfigSchema override roles
 *
 * Verifies that PromptsConfigSchema accepts all 5 valid prompt override roles:
 * - test-writer
 * - implementer
 * - verifier
 * - single-session
 * - tdd-simple (PT-001 fix)
 *
 * These tests FAIL until PT-001 adds "tdd-simple" to the z.enum in PromptsConfigSchema.
 */

import { describe, expect, test } from "bun:test";
import { PromptsConfigSchema, NaxConfigSchema } from "../../../src/config/schemas";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

// ─────────────────────────────────────────────────────────────────────────────
// PromptsConfigSchema — individual role validation
// ─────────────────────────────────────────────────────────────────────────────

describe("PromptsConfigSchema — valid roles", () => {
  test("schema accepts 'test-writer' override", () => {
    // FAILS until PT-001 is implemented
    const result = PromptsConfigSchema.safeParse({
      overrides: { "test-writer": "nax/templates/test-writer.md" },
    });
    expect(result.success).toBe(true);
  });

  test("schema accepts 'implementer' override", () => {
    // FAILS until PT-001 is implemented
    const result = PromptsConfigSchema.safeParse({
      overrides: { "implementer": "nax/templates/implementer.md" },
    });
    expect(result.success).toBe(true);
  });

  test("schema accepts 'verifier' override", () => {
    // FAILS until PT-001 is implemented
    const result = PromptsConfigSchema.safeParse({
      overrides: { "verifier": "nax/templates/verifier.md" },
    });
    expect(result.success).toBe(true);
  });

  test("schema accepts 'single-session' override", () => {
    // FAILS until PT-001 is implemented
    const result = PromptsConfigSchema.safeParse({
      overrides: { "single-session": "nax/templates/single-session.md" },
    });
    expect(result.success).toBe(true);
  });

  test("schema accepts 'tdd-simple' override (PT-001 fix)", () => {
    // FAILS until PT-001 adds "tdd-simple" to z.enum
    const result = PromptsConfigSchema.safeParse({
      overrides: { "tdd-simple": "nax/templates/tdd-simple.md" },
    });
    expect(result.success).toBe(true);
  });

  test("schema accepts multiple valid role overrides", () => {
    // FAILS until PT-001 is implemented
    const result = PromptsConfigSchema.safeParse({
      overrides: {
        "test-writer": "nax/templates/test-writer.md",
        "implementer": "nax/templates/implementer.md",
        "verifier": "nax/templates/verifier.md",
        "single-session": "nax/templates/single-session.md",
        "tdd-simple": "nax/templates/tdd-simple.md",
      },
    });
    expect(result.success).toBe(true);
  });

  test("schema rejects unknown role", () => {
    // FAILS until PT-001 is implemented
    const result = PromptsConfigSchema.safeParse({
      overrides: { "unknown-role": "nax/templates/unknown.md" },
    });
    expect(result.success).toBe(false);
  });

  test("schema accepts empty overrides object", () => {
    // FAILS until PT-001 is implemented
    const result = PromptsConfigSchema.safeParse({
      overrides: {},
    });
    expect(result.success).toBe(true);
  });

  test("schema accepts undefined overrides", () => {
    // FAILS until PT-001 is implemented
    const result = PromptsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("schema rejects empty override path", () => {
    // FAILS until PT-001 is implemented
    const result = PromptsConfigSchema.safeParse({
      overrides: { "test-writer": "" },
    });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NaxConfigSchema — integration with full config
// ─────────────────────────────────────────────────────────────────────────────

describe("NaxConfigSchema — prompts section with tdd-simple", () => {
  test("NaxConfigSchema accepts config with tdd-simple prompt override", () => {
    // FAILS until PT-001 is implemented
    const config = {
      ...DEFAULT_CONFIG,
      prompts: {
        overrides: {
          "tdd-simple": "nax/templates/tdd-simple.md",
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("NaxConfigSchema accepts config with all 5 prompt roles", () => {
    // FAILS until PT-001 is implemented
    const config = {
      ...DEFAULT_CONFIG,
      prompts: {
        overrides: {
          "test-writer": "nax/templates/test-writer.md",
          "implementer": "nax/templates/implementer.md",
          "verifier": "nax/templates/verifier.md",
          "single-session": "nax/templates/single-session.md",
          "tdd-simple": "nax/templates/tdd-simple.md",
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("NaxConfigSchema rejects unknown prompt role", () => {
    // FAILS until PT-001 is implemented
    const config = {
      ...DEFAULT_CONFIG,
      prompts: {
        overrides: {
          "unknown-role": "nax/templates/unknown.md",
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});
