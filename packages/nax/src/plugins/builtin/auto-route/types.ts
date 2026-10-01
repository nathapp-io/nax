/**
 * Auto-Route Plugin — Types
 *
 * Config and dependency-injection shapes used by the auto-route post-run action.
 *
 * Pure types only — no I/O or runtime behavior lives here.
 */

import type { ModelTier } from "@/config/schema-types";
import type { RunMetrics } from "@/metrics/types";
import type { BandStat, CalibrationProposal, CalibrationThresholds } from "@/routing/calibrate/types";

/** Configuration surface for `autoRoute` in `nax.config.json`. */
export interface AutoRouteConfig {
  /** Whether auto-route calibration is enabled (default: false) */
  enabled: boolean;
  /** Minimum sample count required to produce an adjustment for a band */
  minSamples: number;
  /** Upgrade thresholds */
  upgrade: { escalationRate: number; mismatchRate: number };
  /** Downgrade thresholds */
  downgrade: { firstPassRate: number; escalationRate: number };
}

/** Dependencies injected into the plugin so tests can swap filesystem access. */
export interface AutoRouteDeps {
  /**
   * Load run metrics from the project output directory.
   *
   * @param outputDir - Project output directory (e.g. `<workdir>/.nax`)
   * @returns Array of historical run metrics; empty when no history exists
   */
  loadRunMetrics(outputDir: string): Promise<RunMetrics[]>;

  /**
   * Write a UTF-8 file to disk.
   *
   * @param path - Absolute filesystem path to write to
   * @param contents - String contents to write
   */
  writeFile(path: string, contents: string): Promise<void>;
}

/**
 * Pure-function references that `shouldRun` and `execute` delegate to.
 *
 * Surfaced on `_autoRouteDeps` so tests can pre-stage the proposal without
 * having to fabricate matching `RunMetrics` history.
 */
export interface AutoRouteCoreFns {
  /** Pure adjustment proposal logic (US-003). */
  proposeAdjustments(
    bandStats: BandStat[],
    mapping: Record<string, ModelTier>,
    thresholds: CalibrationThresholds,
  ): CalibrationProposal;
  /** Pure band-stat aggregation (US-002). */
  computeBandStats(runs: RunMetrics[], mapping: Record<string, ModelTier>): BandStat[];
}
