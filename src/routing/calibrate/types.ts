/**
 * Routing Calibration Types
 *
 * Shared shapes for the per-band calibration analysis pipeline. US-002
 * introduces `BandStat` and the broader proposal shapes (TierAdjustment,
 * KeywordHint, SkippedBand, CalibrationProposal, CalibrationThresholds)
 * that downstream calibration stages will populate.
 */

import type { Complexity, ModelTier } from "@/config/schema-types";

/**
 * Aggregate statistics for a single complexity band computed from
 * flattened run history. Pure data — no side effects or I/O.
 */
export interface BandStat {
  /** Complexity label, e.g. "simple" | "medium" | "complex" | "expert" */
  complexity: string;
  /** Total stories observed for this complexity */
  sampleCount: number;
  /** Stories whose `attempts > 1` divided by sampleCount */
  escalationRate: number;
  /** Stories whose `firstPassSuccess === true` divided by sampleCount */
  firstPassRate: number;
  /**
   * Fraction of stories whose `finalTier` differs from the tier implied by
   * the current complexity-to-tier mapping. 0 when mapping is undefined
   * for the band.
   */
  mismatchRate: number;
}

/**
 * Proposed change for a complexity band's routing tier. Populated by later
 * calibration stages once threshold logic is introduced.
 */
export interface TierAdjustment {
  complexity: string;
  fromTier: ModelTier;
  toTier: ModelTier;
  rationale: string;
}

/**
 * Evidence-backed keyword suggestion used to refine classification.
 * Populated by later calibration stages.
 */
export interface KeywordHint {
  keyword: string;
  targetComplexity: Complexity;
  occurrences: number;
}

/**
 * Band deliberately skipped by the calibration step (e.g. insufficient samples).
 */
export interface SkippedBand {
  complexity: string;
  reason: "insufficient-samples" | "missing-mapping" | "no-history";
}

/**
 * Composite output of the calibration pipeline. Left unpopulated by US-002
 * — populated by subsequent stories that introduce threshold logic and
 * proposal generation.
 */
export interface CalibrationProposal {
  generatedAt: string;
  bandStats: BandStat[];
  adjustments: TierAdjustment[];
  hints: KeywordHint[];
  skipped: SkippedBand[];
}

/**
 * Threshold inputs governing calibration decisions. Defaults to permissive
 * (no change) so the function remains pure and side-effect free when not
 * provided.
 */
export interface CalibrationThresholds {
  minSamples?: number;
  escalationTrigger?: number;
  mismatchTrigger?: number;
  firstPassFloor?: number;
}
