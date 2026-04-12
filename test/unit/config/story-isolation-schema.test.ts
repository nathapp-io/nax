/**
 * Unit tests for storyIsolation config field (EXEC-002 / US-001)
 *
 * Covers:
 * - Default value is "shared"
 * - Valid values: "shared", "worktree"
 * - Invalid values produce a validation error
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";

/** Build a full config with a specific storyIsolation value (all required fields present). */
function withIsolation(storyIsolation: string): unknown {
  return {
    ...(DEFAULT_CONFIG as unknown as Record<string, unknown>),
    execution: {
      ...(DEFAULT_CONFIG.execution as unknown as Record<string, unknown>),
      storyIsolation,
    },
  };
}

describe("execution.storyIsolation schema", () => {
  test('defaults to "shared" when omitted (NaxConfigSchema.parse({}))', () => {
    const config = NaxConfigSchema.parse({});
    expect(config.execution.storyIsolation).toBe("shared");
  });

  test('accepts "shared" explicitly', () => {
    const result = NaxConfigSchema.safeParse(withIsolation("shared"));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.execution.storyIsolation).toBe("shared");
  });

  test('accepts "worktree"', () => {
    const result = NaxConfigSchema.safeParse(withIsolation("worktree"));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.execution.storyIsolation).toBe("worktree");
  });

  test("rejects invalid values", () => {
    const result = NaxConfigSchema.safeParse(withIsolation("invalid"));
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.includes("storyIsolation"));
    expect(issue).toBeDefined();
  });

  test("DEFAULT_CONFIG.execution.storyIsolation === 'shared' (SSOT default)", () => {
    expect(DEFAULT_CONFIG.execution.storyIsolation).toBe("shared");
  });
});
