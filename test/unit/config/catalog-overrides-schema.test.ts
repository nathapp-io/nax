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
    // nax#2019 admitted `baseUrl`, so the strictness contract is now pinned by
    // the casing typo it is most likely to be misspelled as. `baseURL` must
    // still fail the load: stripped silently, it would leave requests going to
    // the provider's original endpoint with no indication why.
    const withUnknown = { ...VALID_OVERRIDE, baseURL: "https://example.test" };
    expect(() => parseNative({ catalogOverrides: [withUnknown] })).toThrow();
  });

  describe("baseUrl and headers (nax#2019)", () => {
    test("carries a provider-level baseUrl through to the typed output", () => {
      // nax-ai's ProviderOverride has supported baseUrl all along
      // (providers/types.ts); nax was the only layer withholding it, so a
      // native provider could not be pointed at a proxy or gateway.
      const override = { ...VALID_OVERRIDE, baseUrl: "https://proxy.test/v1" };
      const config = parseNative({ catalogOverrides: [override] });
      const parsed: ProviderCatalogOverride | undefined = config.agent?.native?.catalogOverrides?.[0];
      expect(parsed?.baseUrl).toBe("https://proxy.test/v1");
    });

    test("carries provider-level headers through to the typed output", () => {
      const override = { ...VALID_OVERRIDE, headers: { "X-Route": "pinned" } };
      const config = parseNative({ catalogOverrides: [override] });
      const parsed: ProviderCatalogOverride | undefined = config.agent?.native?.catalogOverrides?.[0];
      expect(parsed?.headers).toEqual({ "X-Route": "pinned" });
    });

    test("leaves both absent when undeclared, rather than defaulting them", () => {
      // nax-ai distinguishes "not set" from "set to something" by
      // `!== undefined` (protocols/override-declaration.ts), so a defaulted
      // empty value would read as a declaration and trip its consistency check.
      const config = parseNative({ catalogOverrides: [VALID_OVERRIDE] });
      const parsed = config.agent?.native?.catalogOverrides?.[0];
      expect(parsed).not.toHaveProperty("baseUrl");
      expect(parsed).not.toHaveProperty("headers");
    });

    test("rejects an empty baseUrl, which would silently mean the default endpoint", () => {
      expect(() => parseNative({ catalogOverrides: [{ ...VALID_OVERRIDE, baseUrl: "" }] })).toThrow();
    });

    test("rejects an empty headers map, which would WIPE the provider's bundled headers", () => {
      // Worse than the empty-baseUrl case, which is merely indistinguishable
      // from silence. nax-ai gates on `!== undefined`, not on emptiness, and
      // headers REPLACE rather than merge (nax-ai providers/catalog.ts:74
      // `override?.headers ?? rawProvider.headers`, protocols/pi-client.ts),
      // so `{}` is a declaration that every bundled header is now absent.
      expect(() => parseNative({ catalogOverrides: [{ ...VALID_OVERRIDE, headers: {} }] })).toThrow();
    });

    test("rejects a baseUrl that is not a parseable URL", () => {
      // `.url()` matches the repo's precedent for endpoints
      // (schemas-reporters.ts). A scheme-less host loads clean under a bare
      // string check and then fails deep inside pi-ai's fetch on the first
      // dispatch, which is the opaque-late-failure this schema exists to avoid.
      expect(() => parseNative({ catalogOverrides: [{ ...VALID_OVERRIDE, baseUrl: "proxy.test/v1" }] })).toThrow();
    });

    test.each([
      ["a plaintext http scheme", "http://gateway.test/v1"],
      ["userinfo credentials in the URL", "https://user:tok@gateway.test/v1"],
      ["a non-http scheme", "file:///etc/passwd"],
    ])("rejects %s", (_label, baseUrl) => {
      // baseUrl redirects a provider whose stored credential is attached by
      // PROVIDER NAME alone — nax-ai's auth resolver takes {provider, model}
      // and deliberately carries no baseUrl (nax-ai auth/resolver.ts), and the
      // redirect applies to every model of that provider including bundled
      // ones (protocols/pi-client.ts). So a bad baseUrl sends a real
      // credential somewhere unintended. https keeps it off the plaintext
      // wire; userinfo in a URL is a credential in config by accident.
      expect(() => parseNative({ catalogOverrides: [{ ...VALID_OVERRIDE, baseUrl }] })).toThrow();
    });

    test.each([
      ["https", "https://gateway.test/v1"],
      ["http on loopback, for a local proxy", "http://127.0.0.1:8080/v1"],
      ["http on localhost, for a local proxy", "http://localhost:8080/v1"],
    ])("accepts %s", (_label, baseUrl) => {
      // A local shim is the motivating use case (injecting an OpenRouter
      // provider block), and loopback never leaves the machine.
      const config = parseNative({ catalogOverrides: [{ ...VALID_OVERRIDE, baseUrl }] });
      expect(config.agent?.native?.catalogOverrides?.[0]?.baseUrl).toBe(baseUrl);
    });

    test("rejects baseUrl placed on a MODEL entry, where an operator will misplace it", () => {
      // The real misplacement risk, given the field sits next to a model list
      // but applies provider-wide. CatalogModelOverrideSchema is .strict(), so
      // this must fail rather than be stripped and silently ignored.
      const model = { ...VALID_OVERRIDE.models[0], baseUrl: "https://proxy.test/v1" };
      expect(() => parseNative({ catalogOverrides: [{ provider: "opencode-go", models: [model] }] })).toThrow();
    });

    test("rejects a non-string header value instead of coercing it", () => {
      const override = { ...VALID_OVERRIDE, headers: { "X-Retries": 3 } };
      expect(() => parseNative({ catalogOverrides: [override] })).toThrow();
    });
  });

  test("carries an optional maxTokens ceiling through to the typed output (#1982)", () => {
    // nax#1982 follow-up: nax-ai 0.1.11 exposes ResolvedModel.maxTokens, and an
    // override that declares none inherits a bundled sibling's smaller ceiling.
    // Without the key in this strict schema the declaration would be stripped at
    // load — the same silent-drop trap as pricing.tiers (#1847).
    const model = { ...VALID_OVERRIDE.models[0], maxTokens: 65_536 };
    const config = parseNative({ catalogOverrides: [{ provider: "opencode-go", models: [model] }] });
    const parsed: ProviderCatalogOverride | undefined = config.agent?.native?.catalogOverrides?.[0];
    expect(parsed?.models[0]?.maxTokens).toBe(65_536);
  });

  test("rejects a non-positive maxTokens", () => {
    const model = { ...VALID_OVERRIDE.models[0], maxTokens: 0 };
    expect(() => parseNative({ catalogOverrides: [{ provider: "opencode-go", models: [model] }] })).toThrow();
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
