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
 * Proposed change for a complexity band's routing tier. US-003 introduces the
 * pure proposal logic that populates these fields. `band`/`from`/`to`/`direction`
 * are the AC surface; `complexity`/`fromTier`/`toTier` keep the older shape for
 * downstream consumers (CLI / artifact writers).
 */
export interface TierAdjustment {
  /** Complexity label, the "band" the proposal refers to. */
  band: string;
  /** Tier the band is currently mapped to. */
  from: ModelTier;
  /** Tier the proposal recommends. */
  to: ModelTier;
  /** Direction of the proposed rung move. */
  direction: "upgrade" | "downgrade";
  /** Complexity label kept for downstream consumers that prefer the longer key. */
  complexity: string;
  fromTier: ModelTier;
  toTier: ModelTier;
  /** Short human-readable rationale for the proposal. */
  rationale: string;
}

/**
 * Evidence-backed keyword suggestion used to refine classification. US-003
 * emits advisory hints carrying a `message` (referencing `classify.ts`) but no
 * tier-move fields — a hint refines classification, not tier routing.
 */
export interface KeywordHint {
  /** Human-readable advisory message pointing at classify.ts. */
  message: string;
  keyword?: string;
  targetComplexity?: Complexity;
  occurrences?: number;
}

/**
 * Band deliberately skipped by the calibration step (e.g. insufficient samples).
 * US-003 records the observed `sampleCount` and the `minSamples` threshold that
 * caused the skip so the consumer can surface them in the artifact.
 */
export interface SkippedBand {
  complexity: string;
  reason: "insufficient-samples" | "missing-mapping" | "no-history";
  sampleCount?: number;
  minSamples?: number;
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
 * provided. The four rule numbers mirror `config.autoRoute`:
 *
 *   - `upgradeEscalationRate`: high trigger — band keeps escalating its tier.
 *   - `upgradeMismatchRate`:   high trigger — observed tiers deviate from mapping.
 *   - `downgradeEscalationRate`: low ceiling — band rarely escalates.
 *   - `downgradeFirstPassRate`: high floor — band usually first-passes.
 *
 * Two separate escalation rates keep the asymmetric rules in the source
 * `autoRoute` config intact: upgrade raises the bar, downgrade lowers it.
 */
export interface CalibrationThresholds {
  minSamples?: number;
  upgradeEscalationRate?: number;
  upgradeMismatchRate?: number;
  downgradeEscalationRate?: number;
  downgradeFirstPassRate?: number;
}

/**
 * Public artifact shape written by both the CLI (`--json`) and the
 * `auto-route` plugin's `routing-proposal.json`. Renames the internal
 * `hints` field to `keywordHints` and omits internal-only fields
 * (`bandStats`) so the two writers share exactly one on-disk contract.
 */
export interface ProposalArtifact {
  generatedAt: string;
  adjustments: TierAdjustment[];
  keywordHints: KeywordHint[];
  skipped: SkippedBand[];
}
