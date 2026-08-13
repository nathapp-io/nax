/**
 * Context Engine v2 — Per-provider Effectiveness Weights (US-003)
 *
 * Pure, fail-open derivation of bounded per-provider weights from a list of
 * stored context manifests. Aggregation keys on chunk → provider attribution
 * recorded on each manifest's `chunkProviders` sibling map; only chunks that
 * are (a) mapped and (b) classified `ignored` contribute to the ratio.
 *
 * Behaviour pinned by acceptance criteria:
 *   - Empty / malformed / legacy input → identity (weight 1.0 for any provider).
 *   - Below observation gate → identity (1.0).
 *   - weight(provider) ∈ (0, 1.0], monotone non-increasing w.r.t. ignored ratio,
 *     bounded above by 1.0, bounded below by a non-zero MIN_WEIGHT.
 *   - Verdict other than `ignored` never contributes to the ratio.
 *
 * No I/O, no logging, no clock reads — every input is passed in.
 *
 * The constants are deliberately not pinned by acceptance criteria (not
 * knowable at authoring time) — they are whatever satisfies the AC-pinned
 * properties: monotone non-increasing, never above 1.0, identity below the
 * observation gate, never below MIN_WEIGHT.
 */

import type { ContextManifest } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants (not pinned by ACs — chosen to satisfy the pinned properties)
// ─────────────────────────────────────────────────────────────────────────────

/** Slope of the ignored-ratio penalty: weight = 1 - K × ignoredRatio. */
const K = 1.0;

/** Lower bound of the multiplier — keeps a heavily-ignored provider non-zero. */
const MIN_WEIGHT = 0.2;

/**
 * Minimum number of classified (mapped + verdict-bearing) chunks a provider
 * must have before its weight may fall below 1.0. Below this, weight is 1.0.
 */
const MIN_OBSERVATIONS = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function clampWeight(value: number): number {
  return Math.min(1.0, Math.max(MIN_WEIGHT, value));
}

/** Signals a classified chunk can carry (mirrors `ChunkEffectiveness.signal`). */
const CLASSIFIED_SIGNALS = new Set(["followed", "contradicted", "ignored", "unknown"]);

/** True when `value` is a well-formed verdict with a recognised signal. */
function isClassifiedVerdict(value: unknown): value is { signal: string } {
  if (typeof value !== "object" || value === null) return false;
  const signal = (value as { signal?: unknown }).signal;
  return typeof signal === "string" && CLASSIFIED_SIGNALS.has(signal);
}

/**
 * Derive bounded per-provider effectiveness weights from stored manifests.
 *
 * For each provider, aggregates across manifests the number of mapped,
 * verdict-bearing chunks (the observation count) and the subset of those
 * classified `ignored`. A provider with fewer than MIN_OBSERVATIONS mapped
 * classified chunks keeps the identity weight 1.0; otherwise its weight is
 * `clamp(1 - K × ignoredRatio, MIN_WEIGHT, 1.0)`.
 *
 * The returned mapping yields 1.0 for any provider ID not present in the
 * input (empty, malformed, and legacy manifests) — an identity fallback
 * implemented via a Proxy so a query for an unseen provider reads as 1.0.
 * Malformed manifests (null, non-objects, missing maps) are skipped without
 * throwing; the remaining well-formed manifests drive the result.
 */
export function deriveProviderWeights(manifests: ContextManifest[]): Record<string, number> {
  // Null-prototype so provider-controlled IDs ("__proto__", "constructor")
  // become ordinary own numeric counters rather than mutating Object.prototype.
  const classifiedCounts: Record<string, number> = Object.create(null);
  const ignoredCounts: Record<string, number> = Object.create(null);

  for (const manifest of manifests) {
    if (manifest === null || typeof manifest !== "object") continue;

    const providers = manifest.chunkProviders;
    const effectiveness = manifest.chunkEffectiveness;
    if (providers === null || typeof providers !== "object") continue;
    if (effectiveness === null || typeof effectiveness !== "object") continue;

    for (const [chunkId, verdict] of Object.entries(effectiveness as Record<string, unknown>)) {
      const providerId = (providers as Record<string, unknown>)[chunkId];
      if (typeof providerId !== "string" || providerId === "") continue;
      if (!isClassifiedVerdict(verdict)) continue;

      classifiedCounts[providerId] = (classifiedCounts[providerId] ?? 0) + 1;
      if (verdict.signal === "ignored") {
        ignoredCounts[providerId] = (ignoredCounts[providerId] ?? 0) + 1;
      }
    }
  }

  const computed: Record<string, number> = Object.create(null);
  for (const providerId of Object.keys(classifiedCounts)) {
    const observations = classifiedCounts[providerId] ?? 0;
    const ignored = ignoredCounts[providerId] ?? 0;
    if (observations < MIN_OBSERVATIONS) {
      computed[providerId] = 1.0;
      continue;
    }
    const ignoredRatio = ignored / observations;
    computed[providerId] = clampWeight(1 - K * ignoredRatio);
  }

  return new Proxy(computed, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && Object.hasOwn(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      if (typeof prop === "string") return 1.0;
      return Reflect.get(target, prop, receiver);
    },
  });
}
