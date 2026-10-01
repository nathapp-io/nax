/**
 * Unit tests for src/context/engine/provider-weights-cache.ts — nax-finish
 * MEDIUM finding (effectiveness-scoring-loop): loadFeatureManifests re-reads
 * and re-parses every manifest file in a feature on every stage assembly,
 * making per-story context I/O grow with the number of already-completed
 * stories. ProviderWeightsCache memoizes deriveProviderWeights' result per
 * featureId for the lifetime of one run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StoredContextManifest } from "@/context/engine";
import { _providerWeightsCacheDeps, ProviderWeightsCache } from "@/context/engine";

let origLoadFeatureManifests: typeof _providerWeightsCacheDeps.loadFeatureManifests;
let origDeriveProviderWeights: typeof _providerWeightsCacheDeps.deriveProviderWeights;

beforeEach(() => {
  origLoadFeatureManifests = _providerWeightsCacheDeps.loadFeatureManifests;
  origDeriveProviderWeights = _providerWeightsCacheDeps.deriveProviderWeights;
});

afterEach(() => {
  _providerWeightsCacheDeps.loadFeatureManifests = origLoadFeatureManifests;
  _providerWeightsCacheDeps.deriveProviderWeights = origDeriveProviderWeights;
});

describe("ProviderWeightsCache", () => {
  test("loadOrGet derives weights on a miss and returns them", async () => {
    _providerWeightsCacheDeps.loadFeatureManifests =
      (async () => []) as typeof _providerWeightsCacheDeps.loadFeatureManifests;
    _providerWeightsCacheDeps.deriveProviderWeights = (() => ({
      "code-neighbor": 0.6,
    })) as typeof _providerWeightsCacheDeps.deriveProviderWeights;

    const cache = new ProviderWeightsCache();
    const weights = await cache.loadOrGet("feature-a", "/repo");

    expect(weights).toEqual({ "code-neighbor": 0.6 });
  });

  test("loadOrGet serves subsequent calls for the same feature from cache, not re-loading manifests", async () => {
    let loadCalls = 0;
    _providerWeightsCacheDeps.loadFeatureManifests = (async () => {
      loadCalls++;
      return [];
    }) as typeof _providerWeightsCacheDeps.loadFeatureManifests;
    _providerWeightsCacheDeps.deriveProviderWeights =
      (() => ({})) as typeof _providerWeightsCacheDeps.deriveProviderWeights;

    const cache = new ProviderWeightsCache();
    await cache.loadOrGet("feature-a", "/repo");
    await cache.loadOrGet("feature-a", "/repo");
    await cache.loadOrGet("feature-a", "/repo");

    expect(loadCalls).toBe(1);
  });

  test("loadOrGet caches independently per featureId", async () => {
    const seenFeatureIds: string[] = [];
    _providerWeightsCacheDeps.loadFeatureManifests = (async (opts?: { featureId?: string }) => {
      seenFeatureIds.push(opts?.featureId ?? "");
      return [] as StoredContextManifest[];
    }) as typeof _providerWeightsCacheDeps.loadFeatureManifests;
    _providerWeightsCacheDeps.deriveProviderWeights =
      (() => ({})) as typeof _providerWeightsCacheDeps.deriveProviderWeights;

    const cache = new ProviderWeightsCache();
    await cache.loadOrGet("feature-a", "/repo");
    await cache.loadOrGet("feature-b", "/repo");
    await cache.loadOrGet("feature-a", "/repo");
    await cache.loadOrGet("feature-b", "/repo");

    expect(seenFeatureIds).toEqual(["feature-a", "feature-b"]);
  });

  test("invalidate drops the cached entry so the next loadOrGet re-derives", async () => {
    let loadCalls = 0;
    _providerWeightsCacheDeps.loadFeatureManifests = (async () => {
      loadCalls++;
      return [];
    }) as typeof _providerWeightsCacheDeps.loadFeatureManifests;
    _providerWeightsCacheDeps.deriveProviderWeights =
      (() => ({})) as typeof _providerWeightsCacheDeps.deriveProviderWeights;

    const cache = new ProviderWeightsCache();
    await cache.loadOrGet("feature-a", "/repo");
    cache.invalidate("feature-a");
    await cache.loadOrGet("feature-a", "/repo");

    expect(loadCalls).toBe(2);
  });

  test("invalidate on one feature does not evict another feature's cache entry", async () => {
    let loadCalls = 0;
    _providerWeightsCacheDeps.loadFeatureManifests = (async () => {
      loadCalls++;
      return [];
    }) as typeof _providerWeightsCacheDeps.loadFeatureManifests;
    _providerWeightsCacheDeps.deriveProviderWeights =
      (() => ({})) as typeof _providerWeightsCacheDeps.deriveProviderWeights;

    const cache = new ProviderWeightsCache();
    await cache.loadOrGet("feature-a", "/repo");
    await cache.loadOrGet("feature-b", "/repo");
    cache.invalidate("feature-a");
    await cache.loadOrGet("feature-b", "/repo");

    expect(loadCalls).toBe(2);
  });
});
