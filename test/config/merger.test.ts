/**
 * Config Merger Test Suite
 *
 * Tests for deep merge utility with special handling for:
 * - Arrays: replace (not merge)
 * - Null values: remove keys
 * - Hooks: concatenate
 * - Constitution: concatenate
 */

import { describe, test, expect } from "bun:test";
import { deepMergeConfig } from "../../src/config/merger";
import type { NaxConfig } from "../../src/config/schema";

describe("config/merger", () => {
  describe("basic object merging", () => {
    test("merges simple objects", () => {
      const base = { a: 1, b: 2 };
      const override = { b: 3, c: 4 };
      const result = deepMergeConfig(base, override);

      expect(result).toEqual({
        a: 1,
        b: 3,
        c: 4,
      });
    });

    test("handles nested objects", () => {
      const base = {
        level1: {
          a: 1,
          b: 2,
        },
      };
      const override = {
        level1: {
          b: 3,
          c: 4,
        },
      };
      const result = deepMergeConfig(base, override);

      expect(result).toEqual({
        level1: {
          a: 1,
          b: 3,
          c: 4,
        },
      });
    });

    test("handles deeply nested objects", () => {
      const base = {
        level1: {
          level2: {
            a: 1,
          },
        },
      };
      const override = {
        level1: {
          level2: {
            b: 2,
          },
        },
      };
      const result = deepMergeConfig(base, override);

      expect(result).toEqual({
        level1: {
          level2: {
            a: 1,
            b: 2,
          },
        },
      });
    });
  });

  describe("array replacement", () => {
    test("replaces arrays instead of merging", () => {
      const base = { items: [1, 2, 3] };
      const override = { items: [4, 5] };
      const result = deepMergeConfig(base, override);

      expect(result).toEqual({ items: [4, 5] });
    });

    test("replaces nested arrays", () => {
      const base = {
        config: {
          tiers: ["fast", "balanced"],
        },
      };
      const override = {
        config: {
          tiers: ["powerful"],
        },
      };
      const result = deepMergeConfig(base, override);

      expect(result).toEqual({
        config: {
          tiers: ["powerful"],
        },
      });
    });

    test("handles empty arrays", () => {
      const base = { items: [1, 2, 3] };
      const override = { items: [] };
      const result = deepMergeConfig(base, override);

      expect(result).toEqual({ items: [] });
    });
  });

  describe("null value handling", () => {
    test("removes keys when override is null", () => {
      const base = { a: 1, b: 2, c: 3 };
      const override = { b: null };
      const result = deepMergeConfig(base, override);

      expect(result).toEqual({ a: 1, c: 3 });
      expect("b" in result).toBe(false);
    });

    test("removes nested keys when override is null", () => {
      const base = {
        config: {
          a: 1,
          b: 2,
        },
      };
      const override = {
        config: {
          b: null,
        },
      };
      const result = deepMergeConfig(base, override);

      expect(result).toEqual({
        config: {
          a: 1,
        },
      });
    });

    test("handles multiple null values", () => {
      const base = { a: 1, b: 2, c: 3, d: 4 };
      const override = { b: null, d: null };
      const result = deepMergeConfig(base, override);

      expect(result).toEqual({ a: 1, c: 3 });
    });
  });

  describe("hooks concatenation", () => {
    test("concatenates hooks from both configs", () => {
      const base = {
        hooks: {
          hooks: {
            "on-start": { command: "echo base-start", enabled: true },
            "on-complete": { command: "echo base-complete", enabled: true },
          },
        },
      };
      const override = {
        hooks: {
          hooks: {
            "on-start": { command: "echo override-start", enabled: true },
            "on-pause": { command: "echo override-pause", enabled: true },
          },
        },
      };
      const result = deepMergeConfig(base, override);

      // When both configs have the same hook event, they are concatenated into an array
      expect(result.hooks.hooks["on-start"]).toEqual([
        { command: "echo base-start", enabled: true },
        { command: "echo override-start", enabled: true },
      ]);
      expect(result.hooks.hooks["on-complete"]).toEqual({
        command: "echo base-complete",
        enabled: true,
      });
      expect(result.hooks.hooks["on-pause"]).toEqual({
        command: "echo override-pause",
        enabled: true,
      });
    });

    test("preserves all hook properties", () => {
      const base = {
        hooks: {
          hooks: {
            "on-start": { command: "echo base", timeout: 5000, enabled: true },
          },
        },
      };
      const override = {
        hooks: {
          hooks: {
            "on-complete": { command: "echo override", timeout: 3000, enabled: false },
          },
        },
      };
      const result = deepMergeConfig(base, override);

      expect(result.hooks.hooks["on-start"]).toEqual({
        command: "echo base",
        timeout: 5000,
        enabled: true,
      });
      expect(result.hooks.hooks["on-complete"]).toEqual({
        command: "echo override",
        timeout: 3000,
        enabled: false,
      });
    });

    test("handles empty hooks object", () => {
      const base = {
        hooks: {
          hooks: {
            "on-start": { command: "echo base", enabled: true },
          },
        },
      };
      const override = {
        hooks: {
          hooks: {},
        },
      };
      const result = deepMergeConfig(base, override);

      expect(result.hooks.hooks).toEqual({
        "on-start": { command: "echo base", enabled: true },
      });
    });
  });

  describe("constitution concatenation", () => {
    test("concatenates constitution strings", () => {
      const base = {
        constitution: {
          enabled: true,
          path: "constitution.md",
          maxTokens: 2000,
          content: "Base constitution rules",
        },
      };
      const override = {
        constitution: {
          content: "Override constitution rules",
        },
      };
      const result = deepMergeConfig(base, override);

      expect(result.constitution.content).toBe(
        "Base constitution rules\n\nOverride constitution rules"
      );
      expect(result.constitution.enabled).toBe(true);
      expect(result.constitution.maxTokens).toBe(2000);
    });

    test("handles missing base constitution content", () => {
      const base = {
        constitution: {
          enabled: true,
          path: "constitution.md",
          maxTokens: 2000,
        },
      };
      const override = {
        constitution: {
          content: "Override constitution rules",
        },
      };
      const result = deepMergeConfig(base, override);

      expect(result.constitution.content).toBe("Override constitution rules");
    });

    test("handles missing override constitution content", () => {
      const base = {
        constitution: {
          enabled: true,
          path: "constitution.md",
          maxTokens: 2000,
          content: "Base constitution rules",
        },
      };
      const override = {
        constitution: {
          enabled: false,
        },
      };
      const result = deepMergeConfig(base, override);

      expect(result.constitution.content).toBe("Base constitution rules");
      expect(result.constitution.enabled).toBe(false);
    });

    test("handles empty constitution content", () => {
      const base = {
        constitution: {
          content: "",
        },
      };
      const override = {
        constitution: {
          content: "New content",
        },
      };
      const result = deepMergeConfig(base, override);

      expect(result.constitution.content).toBe("New content");
    });
  });

  describe("complex NaxConfig merging", () => {
    test("merges realistic config with all special cases", () => {
      const base: Partial<NaxConfig> = {
        version: 1,
        models: {
          fast: "haiku",
          balanced: "sonnet",
          powerful: "opus",
        },
        autoMode: {
          enabled: true,
          defaultAgent: "claude",
          fallbackOrder: ["claude", "codex"],
          complexityRouting: {
            simple: "fast",
            medium: "balanced",
            complex: "powerful",
            expert: "powerful",
          },
          escalation: {
            enabled: true,
            tierOrder: [
              { tier: "fast", attempts: 5 },
              { tier: "balanced", attempts: 3 },
            ],
          },
        },
      };

      const override: Partial<NaxConfig> = {
        models: {
          fast: "gemini-flash",
        },
        autoMode: {
          defaultAgent: "gpt",
          fallbackOrder: ["gpt", "claude"],
          escalation: {
            tierOrder: [
              { tier: "fast", attempts: 3 },
            ],
          },
        },
      };

      const result = deepMergeConfig(base, override) as Partial<NaxConfig>;

      expect(result.models?.fast).toBe("gemini-flash");
      expect(result.models?.balanced).toBe("sonnet");
      expect(result.autoMode?.defaultAgent).toBe("gpt");
      expect(result.autoMode?.fallbackOrder).toEqual(["gpt", "claude"]);
      expect(result.autoMode?.escalation?.tierOrder).toEqual([
        { tier: "fast", attempts: 3 },
      ]);
    });

    test("handles removal of nested config keys", () => {
      const base = {
        quality: {
          requireTypecheck: true,
          requireLint: true,
          requireTests: true,
          commands: {
            typecheck: "tsc --noEmit",
            lint: "biome check",
          },
        },
      };

      const override = {
        quality: {
          commands: {
            typecheck: null,
          },
        },
      };

      const result = deepMergeConfig(base, override);

      expect(result.quality.commands).toEqual({
        lint: "biome check",
      });
      expect("typecheck" in result.quality.commands).toBe(false);
    });
  });

  describe("immutability", () => {
    test("does not mutate base object", () => {
      const base = { a: 1, b: { c: 2 } };
      const override = { b: { c: 3, d: 4 } };
      const original = structuredClone(base);

      deepMergeConfig(base, override);

      expect(base).toEqual(original);
    });

    test("does not mutate override object", () => {
      const base = { a: 1 };
      const override = { b: 2 };
      const original = structuredClone(override);

      deepMergeConfig(base, override);

      expect(override).toEqual(original);
    });
  });

  describe("edge cases", () => {
    test("handles undefined values in override", () => {
      const base = { a: 1, b: 2 };
      const override = { a: undefined, c: 3 };
      const result = deepMergeConfig(base, override);

      expect(result).toEqual({ a: 1, b: 2, c: 3 });
    });

    test("handles primitive type changes", () => {
      const base = { value: 42 };
      const override = { value: "string" };
      const result = deepMergeConfig(base, override);

      expect(result.value).toBe("string");
    });

    test("handles object to primitive changes", () => {
      const base = { config: { a: 1, b: 2 } };
      const override = { config: "simple" };
      const result = deepMergeConfig(base, override);

      expect(result.config).toBe("simple");
    });

    test("handles empty objects", () => {
      const base = {};
      const override = { a: 1 };
      const result = deepMergeConfig(base, override);

      expect(result).toEqual({ a: 1 });
    });

    test("handles both empty objects", () => {
      const base = {};
      const override = {};
      const result = deepMergeConfig(base, override);

      expect(result).toEqual({});
    });
  });
});
