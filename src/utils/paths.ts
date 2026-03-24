/**
 * Shared path utilities
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Get the central runs directory, respecting NAX_RUNS_DIR env var override.
 */
export function getRunsDir(): string {
  return process.env.NAX_RUNS_DIR ?? join(homedir(), ".nax", "runs");
}
