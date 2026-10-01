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

/**
 * nax#2017: the time axis is normally derived from the tool-call-only idle
 * watchdog — half its timeout, so the breaker ends a slow spin and classifies
 * the turn `fail-spin` before the watchdog cancels it as `fail-stale`. An
 * explicit `agent.spinBreaker.stopAfterNoProgressSeconds` always wins, and the
 * 900 s fallback covers a watchdog that is off (or absent).
 */
function resolveStopAfterNoProgressSeconds(
  configured: number | undefined,
  config: AgentManagerConfig | undefined,
): number {
  if (configured !== undefined) return configured;
  const watchdog = config?.agent?.idleWatchdog;
  const timeoutSeconds = watchdog?.toolCallOnlyIdleTimeoutSeconds;
  if (watchdog?.enabled !== false && watchdog?.mode !== "off" && timeoutSeconds !== undefined && timeoutSeconds > 0) {
    return Math.floor(timeoutSeconds / 2);
  }
  return DEFAULT_SPIN_BREAKER_SETTINGS.stopAfterNoProgressSeconds;
}

export function selectSpinBreakerSettings(config: AgentManagerConfig | undefined): ResolvedSpinBreakerSettings {
  const cfg = config?.agent?.spinBreaker;
  return {
    enabled: cfg?.enabled ?? DEFAULT_SPIN_BREAKER_SETTINGS.enabled,
    nudgeAfterRepeats: cfg?.nudgeAfterRepeats ?? DEFAULT_SPIN_BREAKER_SETTINGS.nudgeAfterRepeats,
    maxNudges: cfg?.maxNudges ?? DEFAULT_SPIN_BREAKER_SETTINGS.maxNudges,
    stopAfterRepeats: cfg?.stopAfterRepeats ?? DEFAULT_SPIN_BREAKER_SETTINGS.stopAfterRepeats,
    recentKeyWindow: cfg?.recentKeyWindow ?? DEFAULT_SPIN_BREAKER_SETTINGS.recentKeyWindow,
    stopAfterSameKeyRepeats: cfg?.stopAfterSameKeyRepeats ?? DEFAULT_SPIN_BREAKER_SETTINGS.stopAfterSameKeyRepeats,
    stopAfterNoProgressSeconds: resolveStopAfterNoProgressSeconds(cfg?.stopAfterNoProgressSeconds, config),
  };
}
