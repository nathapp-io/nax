/**
 * Curator Rollup — Phase 3
 *
 * Append-only rollup writer for cross-run observation aggregation.
 */

import type { Observation } from "./types";

/**
 * Append observations to a rollup file (JSONL format).
 *
 * Creates parent directory if needed. Appends one JSON line per observation.
 * Never throws on write errors — logs warning and continues.
 *
 * @param observations - Array of observations to append
 * @param rollupPath - Absolute path to the rollup JSONL file
 */
export async function appendToRollup(observations: Observation[], rollupPath: string): Promise<void> {
  // TODO: Implement append-only JSONL writer
}
