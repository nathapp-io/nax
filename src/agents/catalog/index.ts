/**
 * Catalog-backed pricing lookup. Owns the @nathapp/nax-ai boundary for the
 * non-native side of nax; see `scripts/check-nax-ai-imports.ts`.
 *
 * `lookupPricing(provider, model)` reads nax-ai's normalised catalog, maps
 * its `Pricing` shape onto nax's own `TokenPricing`, and returns `undefined`
 * when either lookup misses. The catalog is loaded exactly once per
 * `_catalogDeps.loadProviders` reference — a successful load short-circuits
 * later calls under the same reference; failures are fail-open.
 *
 * Keying the cache on the loader function lets tests swap `_catalogDeps`
 * without leaking cached state from earlier runs: each new mock gets its
 * own cache slot the first time `lookupPricing` resolves under it.
 *
 * This module exports nax's own `TokenPricing` so callers do not import
 * nax-ai types. It depends on neither `cost/` nor `native/`, so adding it
 * as a third nax-ai importer does not close any cycle.
 */

import type { Catalog, RawProvider } from "@nathapp/nax-ai";
import { defaultProviders, normaliseCatalog } from "@nathapp/nax-ai";
import type { TokenPricing } from "@/config/schema-types";

export type { TokenPricing };

/** Injectable seams — tests replace these to drive `lookupPricing` deterministically. */
export interface CatalogDeps {
  loadProviders(ids?: readonly string[]): Promise<RawProvider[]>;
  normalise(raw: readonly RawProvider[]): Catalog;
}

export const _catalogDeps: CatalogDeps = {
  loadProviders: (ids) => defaultProviders(ids),
  normalise: (raw) => normaliseCatalog(raw),
};

/**
 * Per-loader cache. Keyed on the loader function reference so swapping
 * `_catalogDeps.loadProviders` in tests creates a fresh slot rather than
 * inheriting whatever a previous test cached under the old reference.
 *
 * A `WeakMap` would also work, but a plain `Map` keeps the failure path
 * observable in a debugger (failed loaders are recorded as `null` so a
 * later call under the same loader does not retry). A loader that rejects
 * every time stays rejected — `loadCatalog` writes `null` once and never
 * re-runs.
 *
 * `inFlight` deduplicates concurrent loads under the same loader reference
 * so two near-simultaneous `lookupPricing` calls share one load instead of
 * racing two `loadProviders` invocations.
 */
const catalogCache = new Map<CatalogDeps["loadProviders"], Catalog | null>();
const inFlight = new Map<CatalogDeps["loadProviders"], Promise<Catalog | null>>();

/** Load and normalise the catalog. Fail-open: a rejecting loader yields null. */
function loadCatalog(loader: CatalogDeps["loadProviders"]): Promise<Catalog | null> {
  const cached = catalogCache.get(loader);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = inFlight.get(loader);
  if (pending !== undefined) return pending;
  const work = (async () => {
    try {
      const raw = await loader();
      const catalog = _catalogDeps.normalise(raw);
      catalogCache.set(loader, catalog);
      return catalog;
    } catch {
      catalogCache.set(loader, null);
      return null;
    } finally {
      inFlight.delete(loader);
    }
  })();
  inFlight.set(loader, work);
  return work;
}

/**
 * Translate nax-ai's `Pricing` shape onto nax's own `TokenPricing`. Both share
 * the same numeric semantics (per-1M rates) and tier structure
 * (`inputTokensAbove` is preserved); only the field names change.
 */
function toTokenPricing(pricing: import("@nathapp/nax-ai").Pricing): TokenPricing {
  return {
    inputPer1M: pricing.input,
    outputPer1M: pricing.output,
    cacheReadPer1M: pricing.cacheRead,
    cacheCreationPer1M: pricing.cacheWrite,
    ...(pricing.tiers !== undefined
      ? {
          tiers: pricing.tiers.map((tier) => ({
            inputPer1M: tier.input,
            outputPer1M: tier.output,
            cacheReadPer1M: tier.cacheRead,
            cacheCreationPer1M: tier.cacheWrite,
            inputTokensAbove: tier.inputTokensAbove,
          })),
        }
      : {}),
  };
}

/**
 * Look up a model's rate card by `(provider, model)`.
 *
 * - Returns `undefined` on catalog miss, load failure or rejected loader
 *   (US-001 AC2, AC6).
 * - Cache reads and writes that the catalog did not publish fall back to
 *   `inputPer1M` (the conservative rate-card default).
 * - The catalog is loaded exactly once per `_catalogDeps.loadProviders`
 *   reference — a successful load short-circuits every subsequent call
 *   under the same reference (US-001 AC5).
 */
export async function lookupPricing(provider: string, model: string): Promise<TokenPricing | undefined> {
  const catalog = await loadCatalog(_catalogDeps.loadProviders);
  if (catalog === null) return undefined;
  const resolved = catalog.model(provider, model);
  if (resolved === undefined) return undefined;
  const pricing = toTokenPricing(resolved.pricing);
  if (pricing.cacheReadPer1M === undefined) pricing.cacheReadPer1M = pricing.inputPer1M;
  if (pricing.cacheCreationPer1M === undefined) pricing.cacheCreationPer1M = pricing.inputPer1M;
  return pricing;
}
