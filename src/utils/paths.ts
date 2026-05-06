/**
 * Shared path utilities
 */

import { join } from "node:path";
import { globalConfigDir } from "../config/paths";

/**
 * Get the central runs directory, respecting NAX_RUNS_DIR env var override.
 */
export function getRunsDir(): string {
  return process.env.NAX_RUNS_DIR ?? join(globalConfigDir(), "runs");
}

/**
 * Get the central events directory beneath the global nax dir.
 */
export function getEventsRootDir(): string {
  return join(globalConfigDir(), "events");
}
