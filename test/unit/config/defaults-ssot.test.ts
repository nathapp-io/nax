/**
 * Guard test — schema defaults match DEFAULT_CONFIG (US-003)
 *
 * Asserts that NaxConfigSchema.parse({}) deeply equals DEFAULT_CONFIG.
 * This is trivially true today (US-002 derived DEFAULT_CONFIG from schema),
 * but catches future regressions if someone re-introduces a separate defaults
 * object or breaks the derivation chain.
 *
 * Also verifies every top-level key that appears in schema defaults has a
 * corresponding .default() on the schema field.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";

const schemaDefaults = NaxConfigSchema.parse({});

describe("NaxConfigSchema.parse({}) does not throw", () => {
  test("parses empty object without throwing", () => {
    expect(() => NaxConfigSchema.parse({})).not.toThrow();
  });
});

describe("schema defaults match DEFAULT_CONFIG (US-003)", () => {
  test("deepEqual(NaxConfigSchema.parse({}), DEFAULT_CONFIG) passes", () => {
    const a = JSON.parse(JSON.stringify(schemaDefaults));
    const b = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    expect(a).toEqual(b);
  });
});

describe("schema defaults have no extra keys (US-003)", () => {
  test("no extra keys exist beyond what DEFAULT_CONFIG has", () => {
    const schemaKeys = Object.keys(schemaDefaults).sort();
    const defaultKeys = Object.keys(DEFAULT_CONFIG).sort();
    expect(schemaKeys).toEqual(defaultKeys);
  });
});

describe("every key in schema defaults exists in DEFAULT_CONFIG (US-003)", () => {
  test("all schema default keys are present in DEFAULT_CONFIG", () => {
    const schemaKeys = Object.keys(schemaDefaults);
    for (const key of schemaKeys) {
      expect(DEFAULT_CONFIG).toHaveProperty(key);
    }
  });
});
