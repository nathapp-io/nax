/**
 * AutoPr Config Schema Tests
 *
 * Story: Add autoPr root config schema — defines `autoPr` as a sibling top-level
 * key beside `curator` on NaxConfigSchema with opt-in defaults.
 */

import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "../../../src/config/schemas";

describe("NaxConfigSchema — autoPr root config", () => {
  test("defaults autoPr.enabled to false when omitted", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.autoPr.enabled).toBe(false);
  });

  test("defaults autoPr.draft to true when omitted", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.autoPr.draft).toBe(true);
  });

  test("autoPr.enabled overrides default to true while draft keeps its default", () => {
    const parsed = NaxConfigSchema.parse({ autoPr: { enabled: true } });
    expect(parsed.autoPr.enabled).toBe(true);
    expect(parsed.autoPr.draft).toBe(true);
  });

  test("rejects autoPr.enabled when value is not boolean", () => {
    const result = NaxConfigSchema.safeParse({ autoPr: { enabled: "yes" } });
    expect(result.success).toBe(false);
  });
});
