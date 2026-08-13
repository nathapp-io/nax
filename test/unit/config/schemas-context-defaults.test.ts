/**
 * Context config defaults — one source of truth.
 *
 * `NaxConfigSchema` used to attach a hand-written `.default({...})` literal to
 * the `context` block that restated every inner `.default()`. Zod does not
 * re-parse a default value, so that literal *shadowed* the schema: a field
 * added to `ContextConfigSchema` but forgotten in the literal would be absent
 * from `parse({})` (and from DEFAULT_CONFIG) while still resolving correctly
 * whenever an operator supplied the parent partially.
 *
 * These tests pin both halves of that asymmetry, so the literal cannot return.
 */

import { describe, expect, test } from "bun:test";
import { ContextConfigSchema, ContextV2ConfigSchema, NaxConfigSchema } from "@/config";

describe("context config defaults are schema-derived", () => {
  test("the root-derived context block equals a direct ContextConfigSchema parse", () => {
    expect(NaxConfigSchema.parse({}).context).toEqual(ContextConfigSchema.parse({}));
  });

  test("the root-derived v2 block equals a direct ContextV2ConfigSchema parse", () => {
    expect(NaxConfigSchema.parse({}).context.v2).toEqual(ContextV2ConfigSchema.parse({}));
  });

  test("an empty parent and a partially supplied parent agree on every inner default", () => {
    // The shadowing bug is invisible unless both paths are compared: the literal
    // fed `parse({})`, while a partial parent went through the real sub-schemas.
    const empty = NaxConfigSchema.parse({}).context.v2;
    const partial = NaxConfigSchema.parse({ context: { v2: { enabled: true } } }).context.v2;

    expect({ ...partial, enabled: false }).toEqual(empty);
  });

  test("a partially supplied nested block keeps its siblings' defaults", () => {
    const parsed = NaxConfigSchema.parse({ context: { v2: { fragments: { enabled: true } } } }).context.v2;

    expect(parsed.fragments).toEqual({ enabled: true, decay: 0.6, maxTokens: 400, extractor: "deterministic" });
    expect(parsed.pull).toEqual(ContextV2ConfigSchema.parse({}).pull);
  });
});
