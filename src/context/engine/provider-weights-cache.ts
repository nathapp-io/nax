/**
 * Provider Weights Cache
 *
 * loadFeatureManifests() re-reads and re-parses every manifest file under a
 * feature's stories/ directory. Deriving providerWeights on every stage
 * assembly — the context stage's own request, plus every assembleForStage()
 * call for execution, rectify, tdd, and review stages — without caching makes
 * per-story context I/O grow with the number of already-completed stories in
 * the feature: manifest reads grow quadratically across a full run.
 *
 * ProviderWeightsCache memoizes the derived weights per featureId for the
 * lifetime of one run. It is invalidated whenever a new manifest is written
 * for that feature so the next assembly re-derives with the fresh signal.
 */

import { loadFeatureManifests } from "./manifest-store";
import { deriveProviderWeights } from "./provider-weights";

export const _providerWeightsCacheDeps = {
  loadFeatureManifests,
  deriveProviderWeights,
};

export class ProviderWeightsCache {
  private readonly cache = new Map<string, Record<string, number>>();

  /** Returns cached weights for featureId, deriving and caching them on a miss. */
  async loadOrGet(featureId: string, projectDir: string): Promise<Record<string, number>> {
    const cached = this.cache.get(featureId);
    if (cached) return cached;

    const stored = await _providerWeightsCacheDeps.loadFeatureManifests({ featureId, projectDir });
    const weights = _providerWeightsCacheDeps.deriveProviderWeights(stored.map((s) => s.manifest));
    this.cache.set(featureId, weights);
    return weights;
  }

  /** Drops the cached weights for a feature so the next loadOrGet re-derives them. */
  invalidate(featureId: string): void {
    this.cache.delete(featureId);
  }
}
