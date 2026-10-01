/**
 * computeBandStats — pure band-stat aggregation
 *
 * Flattens `RunMetrics[]` into per-complexity `BandStat` records. The
 * function is pure: it reads only the inputs it is given and returns a
 * plain data structure. No filesystem, network, or process I/O.
 *
 * Used by later calibration stages to derive `TierAdjustment` and
 * `KeywordHint` proposals.
 */

import type { Complexity, ModelTier } from "@/config/schema-types";
import type { RunMetrics, StoryMetrics } from "@/metrics/types";
import type { BandStat } from "./types";

/**
 * Complexity-to-tier mapping shape used by the calibration math. Mirrors
 * `config.autoMode.complexityRouting` so the live config can be passed
 * through directly.
 */
export type ComplexityMapping = Record<Complexity, ModelTier>;

export function computeBandStats(runs: RunMetrics[], mapping: ComplexityMapping): BandStat[] {
  const stories: StoryMetrics[] = runs.flatMap((run) => run.stories ?? []);
  if (stories.length === 0) return [];

  const groups = new Map<string, StoryMetrics[]>();
  for (const story of stories) {
    const complexity = story.initialComplexity ?? story.complexity;
    const bucket = groups.get(complexity);
    if (bucket) {
      bucket.push(story);
    } else {
      groups.set(complexity, [story]);
    }
  }

  const bands: BandStat[] = [];
  for (const [complexity, bucket] of groups) {
    const sampleCount = bucket.length;
    const escalated = bucket.filter((s) => s.attempts > 1).length;
    const firstPassed = bucket.filter((s) => s.firstPassSuccess === true).length;
    const expectedTier = mapping[complexity as Complexity];
    const mismatchCount = expectedTier === undefined ? 0 : bucket.filter((s) => s.finalTier !== expectedTier).length;

    bands.push({
      complexity,
      sampleCount,
      escalationRate: sampleCount === 0 ? 0 : escalated / sampleCount,
      firstPassRate: sampleCount === 0 ? 0 : firstPassed / sampleCount,
      mismatchRate: sampleCount === 0 || expectedTier === undefined ? 0 : mismatchCount / sampleCount,
    });
  }

  return bands;
}
