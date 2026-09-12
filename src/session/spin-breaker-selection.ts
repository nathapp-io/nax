/**
 * Resolves `agent.spinBreaker` once, at the wiring layer.
 *
 * Its own module rather than a field on `selectNativeTurnConfig` because the
 * breaker is transport-neutral by design (src/runtime/spin-breaker.ts) — only
 * its current consumer is native. `src/agents/native/` must not read NaxConfig
 * (check:adapter-no-config-import), so the resolved primitive is what crosses
 * the boundary.
 *
 * Always returns concrete numbers, matching the schema's own defaults, so a
 * hand-built NaxConfig that skipped zod parsing still gets a sane policy.
 */

import type { AgentManagerConfig } from "../config/selectors";
import { DEFAULT_SPIN_BREAKER_SETTINGS, type ResolvedSpinBreakerSettings } from "../runtime/spin-breaker";

export function selectSpinBreakerSettings(config: AgentManagerConfig | undefined): ResolvedSpinBreakerSettings {
  const cfg = config?.agent?.spinBreaker;
  return {
    enabled: cfg?.enabled ?? DEFAULT_SPIN_BREAKER_SETTINGS.enabled,
    nudgeAfterRepeats: cfg?.nudgeAfterRepeats ?? DEFAULT_SPIN_BREAKER_SETTINGS.nudgeAfterRepeats,
    maxNudges: cfg?.maxNudges ?? DEFAULT_SPIN_BREAKER_SETTINGS.maxNudges,
    stopAfterRepeats: cfg?.stopAfterRepeats ?? DEFAULT_SPIN_BREAKER_SETTINGS.stopAfterRepeats,
    recentKeyWindow: cfg?.recentKeyWindow ?? DEFAULT_SPIN_BREAKER_SETTINGS.recentKeyWindow,
  };
}
