/**
 * Stable per-project identity for artifacts that can outlive their directory.
 *
 * Both the curator rollup and the cost ledger stamp this. They must agree: the
 * two are cross-referenced when attributing spend and findings to the same
 * project, and `runId` / `storyId` are project-local names that collide freely
 * across repos (#1429, #1433).
 */

import { basename } from "node:path";
import type { NaxConfig } from "./schema";

/**
 * Resolve a project's stable key.
 *
 * Prefers the configured `name`, falling back to the project directory's
 * basename. Note the fallback is not globally unique — two repos both called
 * `api` produce the same key — so consumers that merge across machines should
 * treat it as a grouping hint rather than an identifier.
 *
 * @param config - Loaded nax config (only `name` is read)
 * @param projectDir - Absolute path to the project root, used for the fallback
 */
export function getProjectKey(config: Pick<NaxConfig, "name">, projectDir: string): string {
  return config.name?.trim() || basename(projectDir);
}
