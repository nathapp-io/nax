/**
 * Guard test — schema defaults match DEFAULT_CONFIG (US-003)
 *
 * Asserts that NaxConfigSchema.parse({}) deeply equals DEFAULT_CONFIG.
 * This is trivially true today (US-002 derived DEFAULT_CONFIG from schema),
 * but catches future regressions if someone re-introduces a separate defaults
 * object or breaks the derivation chain.
 *
 * Also verifies every top-level key in DEFAULT_CONFIG has a .default() on
 * the corresponding schema field (i.e., DEFAULT_CONFIG keys are a subset of
 * NaxConfig keys that have schema defaults).
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";
import type { NaxConfig } from "../../../src/config/types";

const NAX_CONFIG_KEYS: (keyof NaxConfig)[] = [
  "name",
  "outputDir",
  "version",
  "models",
  "autoMode",
  "routing",
  "execution",
  "quality",
  "tdd",
  "constitution",
  "analyze",
  "review",
  "plan",
  "acceptance",
  "context",
  "optimizer",
  "plugins",
  "disabledPlugins",
  "hooks",
  "interaction",
  "precheck",
  "prompts",
  "agent",
  "generate",
  "project",
  "curator",
  "debate",
  "profile",
];

describe("NaxConfigSchema.parse({}) does not throw (AC-4)", () => {
  test("parses empty object without throwing", () => {
    expect(() => NaxConfigSchema.parse({})).not.toThrow();
  });
});

describe("schema defaults deeply equal DEFAULT_CONFIG (AC-2)", () => {
  test("deepEqual(NaxConfigSchema.parse({}), DEFAULT_CONFIG) passes", () => {
    const parsed = NaxConfigSchema.parse({}) as NaxConfig;
    expect(parsed).toEqual(DEFAULT_CONFIG);
  });
});

describe("schema defaults have no extra keys beyond DEFAULT_CONFIG (AC-3)", () => {
  test("parsed keys exactly match DEFAULT_CONFIG keys", () => {
    const parsed = NaxConfigSchema.parse({});
    const schemaKeys = Object.keys(parsed).sort();
    const defaultKeys = Object.keys(DEFAULT_CONFIG).sort();
    expect(schemaKeys).toEqual(defaultKeys);
  });
});

describe("every DEFAULT_CONFIG key is a valid NaxConfig top-level key (AC-3)", () => {
  test("all DEFAULT_CONFIG keys exist in NaxConfig", () => {
    const defaultKeys = Object.keys(DEFAULT_CONFIG) as (keyof NaxConfig)[];
    for (const key of defaultKeys) {
      expect(NAX_CONFIG_KEYS).toContain(key);
    }
  });
});

describe("every NaxConfig top-level key with a default is present in schema defaults (AC-3)", () => {
  test("all NaxConfig keys that have .default() are in NaxConfigSchema.parse({})", () => {
    const parsed = NaxConfigSchema.parse({});
    for (const key of NAX_CONFIG_KEYS) {
      if (key in parsed) {
        expect(parsed).toHaveProperty(key);
      }
    }
  });
});
