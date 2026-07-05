/**
 * proposeAdjustments — pure calibration proposal logic (US-003)
 *
 * Converts `BandStat[]` evidence into one-rung tier proposals, advisory
 * keyword hints, and a skipped-band report. The function is pure: no I/O,
 * no wall-clock reads, no globals — identical inputs produce identical
 * outputs.
 *
 * Rules (defaults from `config.autoRoute`):
 * - skip any band with `sampleCount < thresholds.minSamples`
 * - upgrade one rung when `escalationRate >= upgradeEscalationRate`
 *   AND `mismatchRate >= upgradeMismatchRate`
 * - downgrade one rung when `firstPassRate >= downgradeFirstPassRate`
 *   AND `escalationRate <= downgradeEscalationRate` (and `mismatchRate > 0`,
 *   proving the band observed a different tier than the mapping assigned)
 * - never propose a tier below `fast` or above `powerful`
 * - never move more than one rung
 * - emit an advisory hint whenever `mismatchRate >= upgradeMismatchRate`
 *   so hints and adjustments share a single threshold source
 *
 * @design The pure core cannot infer the *direction* of mismatches from
 *   `BandStat.mismatchRate` alone — that signal collapses "observed tier
 *   was below the mapping" and "observed tier was above" into one number.
 *   The AC-2 "all observed finalTiers at or below the mapped tier"
 *   precondition is encoded as `mismatchRate > 0` together with
 *   `escalationRate <= downgradeEscalationRate`. A `balanced`-mapped band
 *   whose escalations push `finalTier` above `balanced` will still record a
 *   mismatch, but its `escalationRate > downgradeEscalationRate` (it IS
 *   escalating) blocks the downgrade — see AC-2 negation test.
 */

import type { ModelTier } from "@/config/schema-types";
import type {
  BandStat,
  CalibrationProposal,
  CalibrationThresholds,
  KeywordHint,
  SkippedBand,
  TierAdjustment,
} from "./types";

/** Mirrors `computeBandStats` — kept loose so the core has no config coupling. */
export type ComplexityMapping = Record<string, ModelTier>;

const LADDER: ModelTier[] = ["fast", "balanced", "powerful"];

const DEFAULT_THRESHOLDS: Required<CalibrationThresholds> = {
  minSamples: 8,
  upgradeEscalationRate: 0.3,
  upgradeMismatchRate: 0.25,
  downgradeEscalationRate: 0.05,
  downgradeFirstPassRate: 0.9,
};

function resolveThresholds(input: CalibrationThresholds): Required<CalibrationThresholds> {
  return {
    minSamples: input.minSamples ?? DEFAULT_THRESHOLDS.minSamples,
    upgradeEscalationRate: input.upgradeEscalationRate ?? DEFAULT_THRESHOLDS.upgradeEscalationRate,
    upgradeMismatchRate: input.upgradeMismatchRate ?? DEFAULT_THRESHOLDS.upgradeMismatchRate,
    downgradeEscalationRate: input.downgradeEscalationRate ?? DEFAULT_THRESHOLDS.downgradeEscalationRate,
    downgradeFirstPassRate: input.downgradeFirstPassRate ?? DEFAULT_THRESHOLDS.downgradeFirstPassRate,
  };
}

function ladderIndex(tier: ModelTier): number {
  const idx = LADDER.indexOf(tier);
  return idx === -1 ? -1 : idx;
}

function nextTier(tier: ModelTier, direction: "upgrade" | "downgrade"): ModelTier | null {
  const idx = ladderIndex(tier);
  if (idx === -1) return null;
  const target = direction === "upgrade" ? idx + 1 : idx - 1;
  if (target < 0 || target >= LADDER.length) return null;
  return LADDER[target];
}

export function proposeAdjustments(
  bandStats: BandStat[],
  mapping: ComplexityMapping,
  thresholds: CalibrationThresholds = {},
): CalibrationProposal {
  const t = resolveThresholds(thresholds);
  const adjustments: TierAdjustment[] = [];
  const skipped: SkippedBand[] = [];
  const hints: KeywordHint[] = [];

  for (const stat of bandStats) {
    const currentTier = mapping[stat.complexity];
    if (currentTier === undefined) {
      skipped.push({
        complexity: stat.complexity,
        reason: "missing-mapping",
      });
      continue;
    }

    if (stat.sampleCount < t.minSamples) {
      skipped.push({
        complexity: stat.complexity,
        reason: "insufficient-samples",
        sampleCount: stat.sampleCount,
        minSamples: t.minSamples,
      });
      continue;
    }

    const upgraded = stat.escalationRate >= t.upgradeEscalationRate && stat.mismatchRate >= t.upgradeMismatchRate;
    const downgraded =
      stat.firstPassRate >= t.downgradeFirstPassRate &&
      stat.escalationRate <= t.downgradeEscalationRate &&
      stat.mismatchRate > 0;

    if (upgraded) {
      const to = nextTier(currentTier, "upgrade");
      if (to !== null) {
        adjustments.push({
          band: stat.complexity,
          complexity: stat.complexity,
          from: currentTier,
          to,
          fromTier: currentTier,
          toTier: to,
          direction: "upgrade",
          rationale: `escalationRate=${stat.escalationRate} ≥ ${t.upgradeEscalationRate}, mismatchRate=${stat.mismatchRate} ≥ ${t.upgradeMismatchRate}`,
        });
      }
    } else if (downgraded) {
      const to = nextTier(currentTier, "downgrade");
      if (to !== null) {
        adjustments.push({
          band: stat.complexity,
          complexity: stat.complexity,
          from: currentTier,
          to,
          fromTier: currentTier,
          toTier: to,
          direction: "downgrade",
          rationale: `firstPassRate=${stat.firstPassRate} ≥ ${t.downgradeFirstPassRate} and escalationRate=${stat.escalationRate} ≤ ${t.downgradeEscalationRate}`,
        });
      }
    }

    if (stat.mismatchRate >= t.upgradeMismatchRate) {
      hints.push({
        message: `classify.ts: high mismatch for band "${stat.complexity}" (mismatchRate=${stat.mismatchRate}) — review keyword classification.`,
      });
    }
  }

  return {
    generatedAt: "",
    bandStats,
    adjustments,
    hints,
    skipped,
  };
}
