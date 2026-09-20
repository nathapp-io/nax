/**
 * Curator auto-prune — US-004 (Size-gate automatic rollup retention)
 *
 * The post-run hook reads `Bun.file(rollupPath).size` after each run. Below
 * `retention.pruneThresholdBytes` it does nothing — the file's size is
 * effectively free, but a full pass + rewrite is not. Above the threshold it
 * derives `keepRunIds` from the first `retention.keepRuns` ids of
 * `scanProjectRunIds` and calls the existing path-locked `pruneRollup`.
 *
 * Reading size and pruning failures are caught and reported on `error` with
 * `pruned: false` so the curator stays an observer: a prune miss must never
 * fail the run that triggered it.
 */

import type { PostRunContext } from "@/plugins";
import { _curatorPruneDeps, type PruneResult } from "./rollup-prune";

/** Curator retention config — threshold + keep count for the auto-prune size gate. */
export interface CuratorRetentionConfig {
  /** Rollup size in bytes above which the post-run hook invokes pruneRollup. */
  pruneThresholdBytes: number;
  /** Run-id cap passed to pruneRollup as keepRunIds when the gate opens. */
  keepRuns: number;
}

/** Schema-aligned defaults. The schema declares these as `.default(...)` values. */
export const DEFAULT_RETENTION: CuratorRetentionConfig = {
  pruneThresholdBytes: 67108864,
  keepRuns: 50,
};

/**
 * Resolve curator retention from a post-run context.
 *
 * `PostRunContext.config` is untyped (`unknown`), so the schema default cannot
 * reach it automatically. Read `context.config.curator.retention` and fall
 * back to `DEFAULT_RETENTION` for any missing field — this is the untyped
 * counterpart of what `CuratorConfigSchema` already does at parse time.
 */
export function getCuratorRetention(context: PostRunContext): CuratorRetentionConfig {
  const cfg = context.config as Record<string, unknown> | undefined;
  const curator = cfg?.curator as Record<string, unknown> | undefined;
  const raw = curator?.retention as Partial<CuratorRetentionConfig> | undefined;
  return {
    pruneThresholdBytes: raw?.pruneThresholdBytes ?? DEFAULT_RETENTION.pruneThresholdBytes,
    keepRuns: raw?.keepRuns ?? DEFAULT_RETENTION.keepRuns,
  };
}

/**
 * Size-gated, project-scoped, full-file rollup rewrite.
 *
 * Reads `Bun.file(input.rollupPath).size`, returns `{ pruned: false }` when
 * the size is at or below `retention.pruneThresholdBytes`, and otherwise
 * derives `keepRunIds` from the first `retention.keepRuns` ids of
 * `scanProjectRunIds` before calling `pruneRollup`. A rejection from either
 * call is caught and reported on `error` with `pruned: false`.
 *
 * Routing `pruneRollup` and `scanProjectRunIds` through `_curatorPruneDeps`
 * keeps the file-system work injectable for tests — there is no monkey-patch
 * of globals anywhere.
 */
export async function maybePruneRollup(input: {
  rollupPath: string;
  projectKey: string;
  retention: CuratorRetentionConfig;
}): Promise<{ pruned: boolean; result?: PruneResult; error?: string }> {
  const { rollupPath, projectKey, retention } = input;
  try {
    // The size gate is the whole point of this module: read the size (free)
    // and short-circuit when it sits at or below the threshold. A missing
    // file reports size=0, so this branch also covers AC7.
    const size = Bun.file(rollupPath).size;
    if (size <= retention.pruneThresholdBytes) {
      return { pruned: false };
    }

    const runIds = await _curatorPruneDeps.scanProjectRunIds(rollupPath, projectKey);
    const keepRunIds = new Set(runIds.slice(0, retention.keepRuns));

    const result = await _curatorPruneDeps.pruneRollup({ rollupPath, projectKey, keepRunIds });
    return { pruned: true, result };
  } catch (err) {
    return {
      pruned: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
