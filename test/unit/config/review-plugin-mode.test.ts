/**
 * Review pluginMode schema tests
 *
 * Verifies that ReviewConfig accepts pluginMode field with values "per-story" and "deferred",
 * defaults to "per-story", and maintains backward compatibility with existing configs.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";

describe("ReviewConfig pluginMode schema", () => {
  test("schema accepts pluginMode: 'per-story'", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        pluginMode: "per-story",
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.pluginMode).toBe("per-story");
    }
  });

  test("schema accepts pluginMode: 'deferred'", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        pluginMode: "deferred",
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.pluginMode).toBe("deferred");
    }
  });

  test("schema defaults pluginMode to 'per-story' when not provided", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.pluginMode).toBe("per-story");
    }
  });

  test("schema rejects invalid pluginMode values", () => {
    const config = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        pluginMode: "invalid-mode",
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("backward compatibility: existing config without pluginMode works", () => {
    // Simulate a legacy config without pluginMode
    const configData = {
      ...DEFAULT_CONFIG,
      review: {
        enabled: true,
        checks: ["typecheck", "lint"],
        commands: {
          typecheck: "bun run typecheck",
          lint: "bun run lint",
        },
        // pluginMode intentionally omitted
      },
    };
    const result = NaxConfigSchema.safeParse(configData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.pluginMode).toBe("per-story");
    }
  });

  test("DEFAULT_CONFIG review has pluginMode set to 'per-story'", () => {
    const result = NaxConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review.pluginMode).toBe("per-story");
    }
  });
});
