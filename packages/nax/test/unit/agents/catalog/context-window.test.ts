/**
 * AC-1..AC-4: `lookupContextWindow(provider, model)` reads nax-ai's normalised
 * catalog and is fail-open exactly like `lookupPricing` — undefined on a model
 * miss, on a load failure, and on a catalog whose `model()` throws.
 *
 * `_catalogDeps.loadProviders` is a fresh mock per test, so `loadCatalog`'s
 * per-loader cache slot is fresh too and no test inherits another's outcome.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Catalog, Pricing, RawProvider, ResolvedModel } from "@nathapp/nax-ai";
import { _catalogDeps, lookupContextWindow } from "@/agents/catalog";

const CONTEXT_WINDOW = 200_000;

const PRICING: Pricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

/** One raw provider whose only model, `anthropic/m1`, declares a 200k context window. */
function rawProvider(): RawProvider {
  return {
    id: "anthropic",
    baseUrl: "https://test.invalid",
    auth: { kind: "api-key" },
    defaultProtocol: "test",
    models: [
      {
        id: "m1",
        protocol: "test",
        pricing: PRICING,
        contextWindow: CONTEXT_WINDOW,
        supportsTools: true,
        thinkingLevels: [],
      },
    ],
  };
}

/** A catalog that resolves nothing and throws from `model()`. */
function throwingCatalog(): Catalog {
  return {
    provider: () => undefined,
    model: (): ResolvedModel | undefined => {
      throw new Error("catalog model() failed");
    },
    listModels: () => [],
  };
}

describe("lookupContextWindow", () => {
  let originalLoadProviders: typeof _catalogDeps.loadProviders;
  let originalNormalise: typeof _catalogDeps.normalise;

  beforeEach(() => {
    originalLoadProviders = _catalogDeps.loadProviders;
    originalNormalise = _catalogDeps.normalise;
  });

  afterEach(() => {
    _catalogDeps.loadProviders = originalLoadProviders;
    _catalogDeps.normalise = originalNormalise;
    mock.restore();
  });

  function loadedFrom(load: () => Promise<RawProvider[]>): void {
    _catalogDeps.loadProviders = mock(load);
  }

  test("AC-1 resolves a model's contextWindow from the normalised catalog", async () => {
    loadedFrom(async () => [rawProvider()]);
    expect(await lookupContextWindow("anthropic", "m1")).toBe(CONTEXT_WINDOW);
  });

  test("AC-2 resolves undefined when the catalog holds no such model", async () => {
    loadedFrom(async () => [rawProvider()]);
    expect(await lookupContextWindow("anthropic", "missing")).toBeUndefined();
  });

  test("AC-3 resolves undefined when the catalog fails to load", async () => {
    loadedFrom(async () => {
      throw new Error("catalog load failed");
    });
    expect(await lookupContextWindow("anthropic", "m1")).toBeUndefined();
  });

  test("AC-4 resolves undefined when the catalog's model() throws", async () => {
    loadedFrom(async () => [rawProvider()]);
    _catalogDeps.normalise = () => throwingCatalog();
    expect(await lookupContextWindow("anthropic", "m1")).toBeUndefined();
  });
});
