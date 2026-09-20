/**
 * Curator auto-prune — US-004 (Size-gate automatic rollup retention)
 *
 * The post-run hook reads `Bun.file(rollupPath).size` after each run. Below
 * `retention.pruneThresholdBytes` it does nothing — the file's size is
 * effectively free, but a full pass + rewrite is not. Above the threshold it
 * calls `scanAndPruneNewest`, which itself scans this project's run ids
 * under the shared path lock and either rewrites (keeping the newest
 * `retention.keepRuns`) or returns `null` when this project's own run count
 * is already at or below `keepRuns` — nothing this prune could shrink.
 *
 * Reading size and pruning failures are caught and reported on `error` with
 * `pruned: false` so the curator stays an observer: a prune miss must never
 * fail the run that triggered it.
 */

import { CuratorRetentionConfigSchema } from "@/config";
import type { CuratorRetentionConfig } from "@/config/runtime-types-curator";
import type { PostRunContext } from "@/plugins";
import { _curatorPruneDeps, type PruneResult } from "./rollup-prune";

export type { CuratorRetentionConfig };

/**
 * Schema-derived defaults — parsing `{}` through `CuratorRetentionConfigSchema`
 * applies its own `.default(...)` values, so this can never drift from the
 * schema the way a hand-copied literal could.
 */
export const DEFAULT_RETENTION: CuratorRetentionConfig = CuratorRetentionConfigSchema.parse({});

/**
 * Read a retention field defensively — non-finite, non-integer, or
 * out-of-range values fall back to the schema default.
 *
 * `PostRunContext.config` is `unknown`; a malformed retention object that
 * has slipped past the schema (e.g. an out-of-band mutation in a fixture,
 * or `keepRuns: -1` whose slice(0, -1) keeps more than `keepRuns` rows)
 * must not silently change behaviour. `minimum` defaults to `0`
 * (`pruneThresholdBytes` may legitimately be zero — an always-open gate) but
 * `keepRuns` passes `1`: `0` is schema-valid range-wise yet would make the
 * unattended auto-prune empty this project's entire rollup history on the
 * very next over-threshold run, mirroring the schema's `.positive()`.
 */
function readRetentionField(value: unknown, fallback: number, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    return fallback;
  }
  return value;
}

/**
 * Resolve curator retention from a post-run context.
 *
 * `PostRunContext.config` is untyped (`unknown`), so the schema default cannot
 * reach it automatically. Read `context.config.curator.retention` and fall
 * back to `DEFAULT_RETENTION` for any missing or malformed field — this is
 * the untyped counterpart of what `CuratorConfigSchema` already does at parse
 * time.
 */
export function getCuratorRetention(context: PostRunContext): CuratorRetentionConfig {
  const cfg = context.config as Record<string, unknown> | undefined;
  const curator = cfg?.curator as Record<string, unknown> | undefined;
  const raw = curator?.retention as Partial<CuratorRetentionConfig> | undefined;
  return {
    pruneThresholdBytes: readRetentionField(raw?.pruneThresholdBytes, DEFAULT_RETENTION.pruneThresholdBytes),
    keepRuns: readRetentionField(raw?.keepRuns, DEFAULT_RETENTION.keepRuns, 1),
  };
}

/**
 * Size-gated, project-scoped, full-file rollup rewrite.
 *
 * Reads `Bun.file(input.rollupPath).size`, returns `{ pruned: false }` when
 * the size is at or below `retention.pruneThresholdBytes`, and otherwise
 * calls `scanAndPruneNewest` — the scan-then-prune pair under a single lock
 * acquisition, so a concurrent `appendToRollup` cannot land between them
 * and have its observations dropped. `scanAndPruneNewest` itself returns
 * `null` (mapped to `{ pruned: false }` here) when this project's own run
 * count is already at or below `retention.keepRuns` — the rollup is shared
 * across every project on the machine (#1429), and a project-scoped rewrite
 * cannot shrink it further in that case. A rejection from the call is
 * caught and reported on `error` with `pruned: false`; the error string is
 * normalised so it is never empty (the post-run hook suppresses an empty
 * string and the AC10 contract guarantees a prune-failure warning fires).
 *
 * Routing the file-system work through `_curatorPruneDeps` keeps it
 * injectable for tests — there is no monkey-patch of globals anywhere.
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

    // The rollup is a single global file shared by every project on the
    // machine (#1429), but a prune can only drop THIS project's rows.
    // `scanAndPruneNewest` returns `null` — without rewriting — when this
    // project already has at most `keepRuns` of its own runs: another
    // project's bytes (or this project's own already-minimal history) hold
    // the file above threshold, and a rewrite could not reduce it further.
    const result = await _curatorPruneDeps.scanAndPruneNewest(rollupPath, projectKey, retention.keepRuns);
    if (result === null) {
      return { pruned: false };
    }
    return { pruned: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      pruned: false,
      // The post-run hook logs on `error !== undefined`; an empty `err.message`
      // (or `String(undefined)`) would silently bypass that warn. Substitute a
      // non-empty sentinel so a real failure always surfaces.
      error: message.length > 0 ? message : `Unknown error: ${err === undefined ? "undefined" : typeof err}`,
    };
  }
}
