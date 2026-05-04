/**
 * Curator Observation Collector
 *
 * Reads Tier 1 run artifacts and projects them to normalized observations.
 */

import type { CuratorPostRunContext, Observation } from "./types";

/**
 * Collect observations from run artifacts.
 *
 * Reads from:
 * - metrics.json in outputDir
 * - review-audit/<feature>/*.json in outputDir
 * - context manifests in workdir/.nax/features/<feature>/stories/<storyId>/
 * - active run JSONL when logFilePath is available
 *
 * Returns a list of schemaVersion=1 observations. Never throws — logs warnings
 * for missing sources or malformed data and continues.
 *
 * @param context - Extended post-run context with curator fields
 * @returns Array of observations
 */
export async function collectObservations(context: CuratorPostRunContext): Promise<Observation[]> {
  // TODO: Implement observation collection
  // - Read metrics.json
  // - Read review-audit/*.json
  // - Read context manifests
  // - Read run JSONL
  // - Project to normalized observation schema
  // - Never throw on missing sources; log and continue
  return [];
}
