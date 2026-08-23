// RE-ARCH: keep
/**
 * Config Merger Test Suite
 *
 * Tests for deep merge utility with special handling for:
 * - Arrays: replace (not merge)
 * - Null values: remove keys
 * - Hooks: concatenate
 * - Constitution: concatenate
 */

import { describe, expect, test } from "bun:test";
import { deepMergeConfig } from "@/config/merger";
import type { NaxConfig } from "@/config/schema";
import type { DeepPartial } from "@test/helpers";

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
    test("replaces arrays (flat, nested, and empty) instead of merging", () => {
      expect(deepMergeConfig({ items: [1, 2, 3] }, { items: [4, 5] })).toEqual({ items: [4, 5] });
      expect(deepMergeConfig({ config: { tiers: ["fast", "balanced"] } }, { config: { tiers: ["powerful"] } })).toEqual(
        { config: { tiers: ["powerful"] } },
      );
      expect(deepMergeConfig({ items: [1, 2, 3] }, { items: [] })).toEqual({ items: [] });
    });
  });

  describe("null value handling", () => {
    test("removes keys when override is null (flat, nested, multiple)", () => {
      const r1 = deepMergeConfig({ a: 1, b: 2, c: 3 }, { b: null });
      expect(r1).toEqual({ a: 1, c: 3 });
      expect("b" in r1).toBe(false);

      expect(deepMergeConfig({ config: { a: 1, b: 2 } }, { config: { b: null } })).toEqual({ config: { a: 1 } });
      expect(deepMergeConfig({ a: 1, b: 2, c: 3, d: 4 }, { b: null, d: null })).toEqual({ a: 1, c: 3 });
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

      expect(result.constitution.content).toBe("Base constitution rules\n\nOverride constitution rules");
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
          claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" },
        },
        autoMode: {
          enabled: true,
          complexityRouting: {
            simple: "fast",
            medium: "balanced",
            complex: "powerful",
            expert: "powerful",
          },
          escalation: {
            enabled: true,
            resetMode: "initial",
            tierOrder: [
              { tier: "fast", attempts: 5 },
              { tier: "balanced", attempts: 3 },
            ],
          },
        },
      };

      const override: DeepPartial<NaxConfig> = {
        models: {
          claude: { fast: "gemini-flash" },
        },
        autoMode: {
          enabled: false,
          escalation: {
            tierOrder: [{ tier: "fast", attempts: 3 }],
          },
        },
      };

      const result = deepMergeConfig<Partial<NaxConfig>>(base, override);

      // nested scalar overridden, its sibling preserved
      expect(result.models?.claude?.fast).toBe("gemini-flash");
      expect(result.models?.claude?.balanced).toBe("sonnet");
      // scalar overridden in a second nested block
      expect(result.autoMode?.enabled).toBe(false);
      // a block the override never mentions survives untouched
      expect(result.autoMode?.complexityRouting?.simple).toBe("fast");
      // arrays are REPLACED, not element-merged — and the sibling key survives
      expect(result.autoMode?.escalation?.tierOrder).toEqual([{ tier: "fast", attempts: 3 }]);
      expect(result.autoMode?.escalation?.enabled).toBe(true);
    });

    test("handles removal of nested config keys", () => {
      const base = {
        quality: {
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
    test("does not mutate base or override objects", () => {
      const base = { a: 1, b: { c: 2 } };
      const override = { b: { c: 3, d: 4 } };
      const origBase = structuredClone(base);
      const origOverride = structuredClone(override);
      deepMergeConfig(base, override);
      expect(base).toEqual(origBase);
      expect(override).toEqual(origOverride);
    });
  });

  describe("edge cases", () => {
    test("handles undefined in override, type changes, object-to-primitive, empty and both-empty objects", () => {
      expect(deepMergeConfig({ a: 1, b: 2 }, { a: undefined, c: 3 })).toEqual({ a: 1, b: 2, c: 3 });
      expect(deepMergeConfig({ value: 42 }, { value: "string" }).value).toBe("string");
      expect(deepMergeConfig({ config: { a: 1, b: 2 } }, { config: "simple" }).config).toBe("simple");
      expect(deepMergeConfig({}, { a: 1 })).toEqual({ a: 1 });
      expect(deepMergeConfig({}, {})).toEqual({});
    });
  });

  describe("three-level hook merge (BUG-005 / BUG-010)", () => {
    test("flattens hooks to a 1D array when the same event appears in all three config levels", () => {
      const defaults = { hooks: { hooks: { "on-complete": { command: "echo defaults" } } } };
      const global = { hooks: { hooks: { "on-complete": { command: "echo global" } } } };
      const project = { hooks: { hooks: { "on-complete": { command: "echo project" } } } };

      const merged1 = deepMergeConfig(defaults, global);
      const merged2 = deepMergeConfig(merged1, project);

      const onComplete = (merged2 as any).hooks?.hooks?.["on-complete"];
      expect(Array.isArray(onComplete)).toBe(true);
      expect(onComplete).toHaveLength(3);
      // No nesting — first element must be a plain object, not an array
      expect(Array.isArray(onComplete[0])).toBe(false);
    });

    test("does not assign overrideHooks.hooks when it is not a plain object", () => {
      const base = { hooks: { hooks: { "on-start": { command: "echo base" } } } };
      const override = { hooks: { hooks: ["not-an-object"] } };

      const result = deepMergeConfig(base, override as any);

      // The base hooks should be preserved; the invalid override should be ignored
      const onStart = (result as any).hooks?.hooks?.["on-start"];
      expect(onStart).toEqual({ command: "echo base" });
    });
  });

  describe("SEC-07: __proto__/constructor/prototype keys are not merged", () => {
    test("does not tamper with the merged object's prototype via a JSON.parse'd __proto__ key", () => {
      const base = { a: 1 };
      // JSON.parse creates __proto__ as a normal own enumerable property —
      // Object.keys(override) includes it, exactly like an untrusted
      // project/profile config.json would after loadJsonFile parses it.
      const override = JSON.parse('{"__proto__": {"polluted": true}, "b": 2}') as Record<string, unknown>;

      const result = deepMergeConfig(base, override) as Record<string, unknown>;

      expect(result.b).toBe(2);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect((result as { polluted?: boolean }).polluted).toBeUndefined();
      // The global Object.prototype itself must stay clean.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    test("does not assign a constructor key that would defeat isPlainObject on a later merge", () => {
      const base = { section: { a: 1 } };
      const override = { section: { constructor: { fake: true }, b: 2 } };

      const result = deepMergeConfig(base, override) as { section: Record<string, unknown> };

      expect(result.section.b).toBe(2);
      expect(result.section.a).toBe(1);
      expect(result.section.constructor).toBe(Object);
    });

    test("skips a dangerous key inside the hooks special case too", () => {
      const base = { hooks: { hooks: { "on-start": { command: "echo base" } } } };
      const override = JSON.parse(
        '{"hooks": {"hooks": {"on-start": {"command": "echo override"}}, "__proto__": {"polluted": true}}}',
      ) as Record<string, unknown>;

      const result = deepMergeConfig(base, override) as Record<string, unknown>;

      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect((result as { polluted?: boolean }).polluted).toBeUndefined();
    });
  });
});
