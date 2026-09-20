/**
 * Curator auto-prune — US-004 (Size-gate automatic rollup retention)
 *
 * STUBS ONLY. The test-writer phase added the symbols required by the
 * acceptance criteria so the failing tests can import and run; the
 * implementer replaces the throws with the real size-gate logic.
 */

import { NaxError } from "@/errors";
import type { PostRunContext } from "@/plugins";
import type { PruneResult } from "./rollup-prune";

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
 * reach it automatically. The real implementation reads `context.config.curator.retention`
 * with `DEFAULT_RETENTION` filling any unset field.
 *
 * STUB: returns DEFAULT_RETENTION unconditionally so tests can import the symbol.
 */
export function getCuratorRetention(_context: PostRunContext): CuratorRetentionConfig {
  return DEFAULT_RETENTION;
}

/**
 * Size-gated, project-scoped, full-file rollup rewrite.
 *
 * STUB: throws "not implemented". The real implementation reads
 * `Bun.file(input.rollupPath).size`, returns `{ pruned: false }` when the
 * size is at or below `retention.pruneThresholdBytes`, and otherwise derives
 * `keepRunIds` from the first `retention.keepRuns` ids of `scanProjectRunIds`
 * before calling `pruneRollup`. A rejection from either call is caught and
 * reported on `error` with `pruned: false`.
 */
export async function maybePruneRollup(input: {
  rollupPath: string;
  projectKey: string;
  retention: CuratorRetentionConfig;
}): Promise<{ pruned: boolean; result?: PruneResult; error?: string }> {
  void input;
  throw new NaxError("maybePruneRollup not implemented", "CURATOR_NOT_IMPLEMENTED", { stage: "auto-prune" });
}
