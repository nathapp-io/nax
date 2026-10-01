/**
 * Unit Tests: PromptsConfigSchema override roles
 *
 * Verifies that PromptsConfigSchema accepts every valid prompt override role:
 * - test-writer
 * - implementer
 * - verifier
 * - tdd-simple (PT-001 fix)
 *
 * and that `single-session` — retired as a prompt role by US-004 — is rejected
 * with the message naming the surviving roles.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { NaxConfigSchema, PromptsConfigSchema } from "@/config/schemas";

// ─────────────────────────────────────────────────────────────────────────────
// PromptsConfigSchema — individual role validation
// ─────────────────────────────────────────────────────────────────────────────

describe("PromptsConfigSchema — valid roles", () => {
  test("schema accepts 'test-writer' override", () => {
    // FAILS until PT-001 is implemented
    const result = PromptsConfigSchema.safeParse({
      overrides: { "test-writer": ".nax/templates/test-writer.md" },
    });
    expect(result.success).toBe(true);
  });

  test("schema accepts 'implementer' override", () => {
    // FAILS until PT-001 is implemented
    const result = PromptsConfigSchema.safeParse({
      overrides: { implementer: ".nax/templates/implementer.md" },
    });
    expect(result.success).toBe(true);
  });

  test("schema accepts 'verifier' override", () => {
    // FAILS until PT-001 is implemented
    const result = PromptsConfigSchema.safeParse({
      overrides: { verifier: ".nax/templates/verifier.md" },
    });
    expect(result.success).toBe(true);
  });

  test("US-004: PromptsConfigSchema rejects a 'single-session' override with the five-role message", () => {
    const result = PromptsConfigSchema.safeParse({
      overrides: { "single-session": ".nax/templates/single-session.md" },
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected the retired 'single-session' role to be rejected");
    const messages = result.error.issues.map((issue) => issue.message);
    expect(messages).toContain("Role must be one of: no-test, test-writer, implementer, verifier, tdd-simple");
    expect(messages.join("\n")).not.toContain("single-session");
  });

  test("schema accepts 'tdd-simple' override (PT-001 fix)", () => {
    // FAILS until PT-001 adds "tdd-simple" to z.enum
    const result = PromptsConfigSchema.safeParse({
      overrides: { "tdd-simple": ".nax/templates/tdd-simple.md" },
    });
    expect(result.success).toBe(true);
  });

  test("schema accepts multiple valid role overrides", () => {
    const result = PromptsConfigSchema.safeParse({
      overrides: {
        "test-writer": ".nax/templates/test-writer.md",
        implementer: ".nax/templates/implementer.md",
        verifier: ".nax/templates/verifier.md",
        "tdd-simple": ".nax/templates/tdd-simple.md",
      },
    });
    expect(result.success).toBe(true);
  });

  test("schema rejects unknown role", () => {
    // FAILS until PT-001 is implemented
    const result = PromptsConfigSchema.safeParse({
      overrides: { "unknown-role": ".nax/templates/unknown.md" },
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
          "tdd-simple": ".nax/templates/tdd-simple.md",
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("NaxConfigSchema accepts config with every surviving prompt role", () => {
    const config = {
      ...DEFAULT_CONFIG,
      prompts: {
        overrides: {
          "test-writer": ".nax/templates/test-writer.md",
          implementer: ".nax/templates/implementer.md",
          verifier: ".nax/templates/verifier.md",
          "tdd-simple": ".nax/templates/tdd-simple.md",
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("US-004 AC4: NaxConfigSchema.safeParse rejects a single-session override with the five-role message", () => {
    const config = {
      ...DEFAULT_CONFIG,
      prompts: {
        overrides: {
          "single-session": ".nax/templates/single-session.md",
        },
      },
    };

    const result = NaxConfigSchema.safeParse(config);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected the retired 'single-session' role to be rejected");
    const messages = result.error.issues.map((issue) => issue.message);
    expect(messages).toContain("Role must be one of: no-test, test-writer, implementer, verifier, tdd-simple");
    expect(messages.join("\n")).not.toContain("single-session");
  });

  test("NaxConfigSchema rejects unknown prompt role", () => {
    // FAILS until PT-001 is implemented
    const config = {
      ...DEFAULT_CONFIG,
      prompts: {
        overrides: {
          "unknown-role": ".nax/templates/unknown.md",
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});
