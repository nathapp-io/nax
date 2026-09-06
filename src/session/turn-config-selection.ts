/**
 * Native-turn-loop config fields forwarded from NaxConfig to the adapter's
 * `openSession` call.
 *
 * Its own module for the same reason as `model-selection.ts`: `manager.ts` is
 * a grandfathered oversized file that may not grow, and the alternative
 * homes are worse fits (`manager-run.ts` is the tracked-session lifecycle,
 * `manager-deps.ts` is the injectable-dependency facade).
 */

import type { ResolvedCompaction } from "../agents/native/session/compaction";
import type { TurnRetryConfig } from "../agents/native/session/turn-retry";
import type { AgentManagerConfig } from "../config/selectors";

export interface NativeTurnConfigSelection {
  compaction?: ResolvedCompaction;
  transportRetry: TurnRetryConfig;
}

/**
 * Resolves the native turn loop's config-derived settings once, at the
 * wiring layer — `src/agents/native/` must not read NaxConfig directly
 * (check:adapter-no-config-import).
 *
 * `transportRetry` (nax#1870) always resolves to concrete numbers, matching
 * the schema's own defaults (`schemas-infra.ts`'s
 * `AgentNativeTransportRetryConfigSchema`), so a hand-built NaxConfig that
 * skipped zod parsing still gets a sane policy rather than `undefined`
 * fields reaching the adapter.
 */
export function selectNativeTurnConfig(config: AgentManagerConfig | undefined): NativeTurnConfigSelection {
  const retry = config?.agent?.native?.transportRetry;
  return {
    compaction: config?.execution?.compaction,
    transportRetry: { maxAttempts: retry?.maxAttempts ?? 3, baseDelayMs: retry?.baseDelayMs ?? 2000 },
  };
}
