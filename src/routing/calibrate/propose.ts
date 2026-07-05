/**
 * proposeAdjustments — pure calibration proposal logic (US-003)
 *
 * Converts `BandStat[]` evidence into one-rung tier proposals, advisory
 * keyword hints, and a skipped-band report. The function is pure — no
 * filesystem, network, or process I/O.
 *
 * Rules (defaults from `config.autoRoute`):
 * - skip any band with `sampleCount < thresholds.minSamples`
 * - upgrade one rung when `escalationRate >= escalationTrigger`
 *   AND `mismatchRate >= mismatchTrigger`
 * - downgrade one rung when `firstPassRate >= firstPassFloor`
 *   AND `escalationRate <= escalationTrigger` AND final-tier usage is at or
 *   below the current mapped tier
 * - never propose a tier below `fast` or above `powerful`
 * - never move more than one rung
 * - emit a keyword hint for the worst-mismatch band on each pass
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
  escalationTrigger: 0.3,
  mismatchTrigger: 0.25,
  firstPassFloor: 0.9,
};

function resolveThresholds(input: CalibrationThresholds): Required<CalibrationThresholds> {
  return {
    minSamples: input.minSamples ?? DEFAULT_THRESHOLDS.minSamples,
    escalationTrigger: input.escalationTrigger ?? DEFAULT_THRESHOLDS.escalationTrigger,
    mismatchTrigger: input.mismatchTrigger ?? DEFAULT_THRESHOLDS.mismatchTrigger,
    firstPassFloor: input.firstPassFloor ?? DEFAULT_THRESHOLDS.firstPassFloor,
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

function farUnderUtilized(stat: BandStat): boolean {
  return stat.mismatchRate >= DEFAULT_THRESHOLDS.mismatchTrigger;
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

    const upgraded = stat.escalationRate >= t.escalationTrigger && stat.mismatchRate >= t.mismatchTrigger;
    const downgraded =
      stat.firstPassRate >= t.firstPassFloor && stat.escalationRate <= t.escalationTrigger && stat.mismatchRate > 0;

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
          rationale: `escalationRate=${stat.escalationRate} ≥ ${t.escalationTrigger}, mismatchRate=${stat.mismatchRate} ≥ ${t.mismatchTrigger}`,
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
          rationale: `firstPassRate=${stat.firstPassRate} ≥ ${t.firstPassFloor} and escalationRate=${stat.escalationRate} ≤ ${t.escalationTrigger}`,
        });
      }
    }

    if (farUnderUtilized(stat)) {
      hints.push({
        message: `classify.ts: high mismatch for band "${stat.complexity}" (mismatchRate=${stat.mismatchRate}) — review keyword classification.`,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    bandStats,
    adjustments,
    hints,
    skipped,
  };
}
