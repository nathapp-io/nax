/**
 * nax#1982: agent.native.catalogOverrides — explicit catalog entries for
 * native model ids the bundled pi-ai snapshot does not know.
 *
 * Strict on purpose: an unknown key (baseUrl, tiers, a typo) must fail the
 * load, because Zod would otherwise strip it silently — the exact trap
 * documented for pricing.tiers (#1847) and contextWindow (#1848).
 */

import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config";
import type { ProviderCatalogOverride } from "@/config/schema-types";

const VALID_OVERRIDE: ProviderCatalogOverride = {
  provider: "opencode-go",
  models: [
    {
      id: "deepseek-flash",
      protocol: "openai-completions",
      contextWindow: 1_000_000,
      supportsTools: true,
      thinkingLevels: ["off", "low", "medium", "high"],
      pricing: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    },
  ],
};

function parseNative(native: unknown) {
  return NaxConfigSchema.parse({ agent: { native } });
}

describe("agent.native.catalogOverrides", () => {
  test("defaults to an empty array when agent.native is omitted", () => {
    const config = NaxConfigSchema.parse({});
    expect(config.agent?.native?.catalogOverrides).toEqual([]);
  });

  test("round-trips a valid override and stays assignable to the hand-written type", () => {
    const config = NaxConfigSchema.parse({
      agent: { native: { catalogOverrides: [VALID_OVERRIDE] } },
    });
    // Both lines must compile: the Zod output is assignable to the interface
    // that the rest of src/ consumes.
    const parsed: ProviderCatalogOverride | undefined = config.agent?.native?.catalogOverrides?.[0];
    expect(parsed).toEqual(VALID_OVERRIDE);
  });

  test("rejects an unknown key instead of stripping it", () => {
    const withUnknown = { ...VALID_OVERRIDE, baseUrl: "https://example.test" };
    expect(() => parseNative({ catalogOverrides: [withUnknown] })).toThrow();
  });

  test.each<[string, unknown]>([
    ["a model-level unknown key", { ...VALID_OVERRIDE.models[0], contextWindowSize: 1 }],
    [
      "a tiers array inside pricing",
      {
        ...VALID_OVERRIDE.models[0],
        pricing: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0, tiers: [] },
      },
    ],
  ])("rejects %s at the nested level instead of stripping it", (_label, model) => {
    expect(() => parseNative({ catalogOverrides: [{ provider: "opencode-go", models: [model] }] })).toThrow();
  });

  test("rejects an unknown thinking level", () => {
    const model = { ...VALID_OVERRIDE.models[0], thinkingLevels: ["turbo"] };
    expect(() => parseNative({ catalogOverrides: [{ provider: "opencode-go", models: [model] }] })).toThrow();
  });

  test("rejects pricing missing a required rate", () => {
    const model = { ...VALID_OVERRIDE.models[0], pricing: { input: 0.15, output: 0.6, cacheRead: 0.003 } };
    expect(() => parseNative({ catalogOverrides: [{ provider: "opencode-go", models: [model] }] })).toThrow();
  });

  test("rejects a negative rate", () => {
    const model = { ...VALID_OVERRIDE.models[0], pricing: { input: -1, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } };
    expect(() => parseNative({ catalogOverrides: [{ provider: "opencode-go", models: [model] }] })).toThrow();
  });

  test("rejects an empty models list", () => {
    expect(() => parseNative({ catalogOverrides: [{ provider: "opencode-go", models: [] }] })).toThrow();
  });

  test("rejects the retracted singular catalogOverride key (the parent block is strict)", () => {
    // The issue's first proposal spelled this `catalogOverride` on the model
    // entry; a user carrying that spelling over must not get it stripped.
    expect(() => parseNative({ catalogOverride: VALID_OVERRIDE })).toThrow();
  });
});
