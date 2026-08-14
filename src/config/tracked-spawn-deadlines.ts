/**
 * trackedSpawn teardown/startup deadline resolution (#1583).
 *
 * Not a ConfigSelector (see ./selectors.ts) — its callers hold a config slice
 * (AgentManagerConfig) or a possibly-undefined NaxConfig, neither of which
 * satisfies ConfigSelector.select()'s `(config: NaxConfig) => C` shape.
 */

import type { NaxConfig } from "./types";

/**
 * trackedSpawn teardown/startup deadlines (ms), resolved from config.agent.acp.
 * Shared by AgentManager.completeAs and SessionManager.openSession so both
 * wiring layers stay consistent.
 */
export function trackedSpawnDeadlines(config: Pick<NaxConfig, "agent"> | undefined): {
  trackedSpawnDeadlineMs?: number;
  trackedSpawnStartupDeadlineMs?: number;
} {
  const acp = config?.agent?.acp;
  return {
    trackedSpawnDeadlineMs: acp?.trackedSpawnDeadlineMs,
    trackedSpawnStartupDeadlineMs: acp?.trackedSpawnStartupDeadlineMs,
  };
}
