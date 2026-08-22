/**
 * Batch pre-iteration tier-budget check (extracted from unified-executor.ts).
 *
 * Runs `preIterationTierCheck` for every story in a parallel batch and
 * returns only the stories still eligible for dispatch. A story whose budget
 * check marks it failed/paused has already been persisted by
 * `preIterationTierCheck` and must not also be handed to `runParallelBatch` —
 * the sequential and single-story dispatchers already skip on
 * `shouldSkipIteration`; this is the batch-mode equivalent.
 */

import type { NaxConfig } from "@/config";
import type { LoadedHooksConfig } from "@/hooks";
import type { PRD, UserStory } from "@/prd";
import type { preIterationTierCheck } from "./tier-escalation";

export interface BatchPreCheckOptions {
  batch: UserStory[];
  prd: PRD;
  config: NaxConfig;
  prdPath: string;
  featureDir: string | undefined;
  hooks: LoadedHooksConfig;
  feature: string;
  totalCost: number;
  workdir: string;
  /** Injected seam — pass `_unifiedExecutorDeps.preIterationTierCheck` so callers stay testable. */
  preIterationTierCheckFn: typeof preIterationTierCheck;
  /** Injected seam — pass `loadPRD` from `../../prd`. */
  loadPRDFn: (prdPath: string) => Promise<PRD>;
}

export interface BatchPreCheckResult {
  prd: PRD;
  prdDirty: boolean;
  /** Batch stories still eligible for dispatch — escalated/failed stories are excluded. */
  dispatchable: UserStory[];
}

export async function runBatchPreChecks(options: BatchPreCheckOptions): Promise<BatchPreCheckResult> {
  const { batch, config, prdPath, featureDir, hooks, feature, totalCost, workdir, preIterationTierCheckFn, loadPRDFn } =
    options;
  let prd = options.prd;
  let prdDirty = false;
  const skipped = new Set<string>();

  for (const batchStory of batch) {
    const batchPre = await preIterationTierCheckFn(
      batchStory,
      { modelTier: batchStory.routing?.modelTier ?? "balanced" },
      config,
      prd,
      prdPath,
      featureDir,
      hooks,
      feature,
      totalCost,
      workdir,
    );
    if (batchPre.prdDirty) prdDirty = true;
    if (batchPre.shouldSkipIteration) {
      skipped.add(batchStory.id);
      // Story escalated (max attempts / no tier available) — reload PRD so
      // runParallelBatch sees the updated tier/status. Batch escalation
      // semantics (escalateEntireBatch) are unchanged.
      prd = await loadPRDFn(prdPath);
      prdDirty = false;
    }
  }

  // BUG-8: a sibling skip reloads `prd` into a fresh generation of story objects,
  // but `batch` still holds the pre-reload ones — dispatching those orphans loses
  // worker mutations (storyGitRef, repo-scoped fix records) written by reference,
  // since the single-writer save only serialises the new generation. Re-resolve
  // by id from the fresh PRD so dispatched stories share identity with it.
  const dispatchable = batch
    .filter((s) => !skipped.has(s.id))
    .map((s) => prd.userStories.find((p) => p.id === s.id) ?? s);

  return { prd, prdDirty, dispatchable };
}
