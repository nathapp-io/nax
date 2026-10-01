/**
 * AC1-AC6: `lookupPricing(provider, model)` maps nax-ai's catalog onto
 * nax's `TokenPricing`, fail-open on miss and on load failure, with the
 * catalog loaded exactly once across calls.
 *
 * Tests inject `_catalogDeps.loadProviders` and `_catalogDeps.normalise` so
 * no real nax-ai data is reached and no nax-ai types escape into assertions.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Catalog, Pricing, RawModel, RawProvider, ResolvedModel } from "@nathapp/nax-ai";
import { assertDefined } from "@test/helpers";
import { _catalogDeps, lookupPricing } from "@/agents/catalog";

/** Build a fake Catalog that delegates to a per-(provider,model) table. */
function fakeCatalog(entries: ReadonlyMap<string, { readonly pricing: Pricing; readonly model: RawModel }>): Catalog {
  return {
    provider: () => undefined,
    model: (provider: string, model: string) => {
      const e = entries.get(`${provider}/${model}`);
      if (!e) return undefined;
      const { pricing, model: rawModel } = e;
      const resolved = {
        id: rawModel.id,
        provider,
        protocol: rawModel.protocol ?? "test",
        pricing,
        contextWindow: rawModel.contextWindow,
        supportsTools: rawModel.supportsTools,
        thinkingLevels: rawModel.thinkingLevels,
      } satisfies ResolvedModel;
      return resolved;
    },
    listModels: () => [],
  };
}

/** Build a fake RawProvider with one model whose pricing is `pricing`. */
function rawProvider(id: string, modelId: string, pricing: Pricing): RawProvider {
  const rawModel: RawModel = {
    id: modelId,
    pricing,
    protocol: "test",
    contextWindow: 128_000,
    supportsTools: true,
    thinkingLevels: [],
  };
  return {
    id,
    baseUrl: "https://test.invalid",
    auth: { kind: "api-key" },
    defaultProtocol: "test",
    models: [rawModel],
  };
}

const SAMPLE_PRICING: Pricing = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
};

describe("lookupPricing", () => {
  let originalLoadProviders: typeof _catalogDeps.loadProviders;
  let originalNormalise: typeof _catalogDeps.normalise;
  let loadProvidersMock: ReturnType<typeof mock>;
  let normaliseMock: ReturnType<typeof mock>;

  beforeEach(() => {
    originalLoadProviders = _catalogDeps.loadProviders;
    originalNormalise = _catalogDeps.normalise;
    loadProvidersMock = mock(async () => [rawProvider("anthropic", "claude-sonnet-5", SAMPLE_PRICING)]);
    normaliseMock = mock((raw: readonly RawProvider[]) => {
      const entries = new Map<string, { pricing: Pricing; model: RawModel }>();
      for (const p of raw) {
        for (const m of p.models) entries.set(`${p.id}/${m.id}`, { pricing: m.pricing, model: m });
      }
      return fakeCatalog(entries);
    });
    _catalogDeps.loadProviders = loadProvidersMock;
    _catalogDeps.normalise = normaliseMock;
  });

  afterEach(() => {
    _catalogDeps.loadProviders = originalLoadProviders;
    _catalogDeps.normalise = originalNormalise;
    mock.restore();
  });

  // AC1: success path — known provider/model returns a defined TokenPricing
  // whose inputPer1M and outputPer1M are positive finite numbers.
  test("AC1: returns a defined value with positive finite rates for a known provider/model", async () => {
    const rates = await lookupPricing("anthropic", "claude-sonnet-5");
    expect(rates).toBeDefined();
    assertDefined(rates, "rates");
    expect(Number.isFinite(rates.inputPer1M)).toBe(true);
    expect(Number.isFinite(rates.outputPer1M)).toBe(true);
    expect(rates.inputPer1M).toBeGreaterThan(0);
    expect(rates.outputPer1M).toBeGreaterThan(0);
  });

  // AC2: boundary path — unknown provider/model returns undefined.
  test("AC2: returns undefined for an unknown provider/model", async () => {
    const rates = await lookupPricing("no-such-provider", "no-such-model");
    expect(rates).toBeUndefined();
  });

  // AC3: success path — catalog cache rates are mapped onto nax's field names
  // (input/output/cacheRead/cacheWrite -> inputPer1M/outputPer1M/cacheReadPer1M/cacheCreationPer1M).
  test("AC3: maps the catalog's input/output/cacheRead/cacheWrite onto TokenPricing fields", async () => {
    const rates = await lookupPricing("anthropic", "claude-sonnet-5");
    expect(rates).toBeDefined();
    assertDefined(rates, "rates");
    expect(rates.inputPer1M).toBe(3);
    expect(rates.outputPer1M).toBe(15);
    expect(rates.cacheReadPer1M).toBe(0.3);
    expect(rates.cacheCreationPer1M).toBe(3.75);
  });

  // AC4: success path — tiers carry through the mapping with inputTokensAbove preserved.
  test("AC4: maps the catalog's tiers onto TokenPricingTier with inputTokensAbove preserved", async () => {
    _catalogDeps.loadProviders = mock(async () => [
      rawProvider("anthropic", "claude-sonnet-5", {
        ...SAMPLE_PRICING,
        tiers: [{ ...SAMPLE_PRICING, inputTokensAbove: 200_000 }],
      }),
    ]);
    const rates = await lookupPricing("anthropic", "claude-sonnet-5");
    expect(rates).toBeDefined();
    assertDefined(rates, "rates");
    expect(rates.tiers).toBeDefined();
    assertDefined(rates.tiers, "rates.tiers");
    expect(rates.tiers).toHaveLength(1);
    const tier = rates.tiers[0];
    assertDefined(tier, "rates.tiers[0]");
    expect(tier.inputTokensAbove).toBe(200_000);
  });

  // AC5: success path — second lookup reuses the cached catalog; loader runs once.
  test("AC5: calls the loader exactly once across two lookups", async () => {
    await lookupPricing("anthropic", "claude-sonnet-5");
    await lookupPricing("anthropic", "claude-sonnet-5");
    expect(loadProvidersMock).toHaveBeenCalledTimes(1);
  });

  // AC6: failure path — a rejecting loader returns undefined (does not reject).
  test("AC6: returns undefined when the loader rejects, rather than propagating", async () => {
    _catalogDeps.loadProviders = mock(async () => {
      throw new Error("catalog load failed");
    });
    const rates = await lookupPricing("anthropic", "claude-sonnet-5");
    expect(rates).toBeUndefined();
  });
});
