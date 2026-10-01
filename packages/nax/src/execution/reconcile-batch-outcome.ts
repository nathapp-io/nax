import { markStoryFailed, markStoryPassed } from "../prd";
import type { PRD } from "../prd/types";
import type { RunParallelBatchResult } from "./parallel-batch";

/**
 * Single-writer reconciliation of a parallel batch outcome onto the in-memory PRD.
 * Worktree pipelines no longer persist PRD (skipPrdPersistence), so the executor
 * is the authority for:
 *   - completed       → passed
 *   - mergeConflicts  → passed iff rectified, else failed
 * FAILED stories are intentionally NOT handled here — handlePipelineFailure
 * (pipeline-result-handler.ts) already marks + saves them; touching them again
 * double-increments attempts.
 *
 * PRD state ONLY (BUG-3, nax review 20260829). This function is deliberately a pure
 * `(prd, batchResult) => void` with no access to `ctx`, `featureDir`, or the cost
 * aggregator, so it cannot also correct the event bus or per-agent cost attribution for
 * a non-rectified merge conflict. That correction — emitting `story:failed`, appending
 * progress, and synthesizing a StoryMetric — is `recordMergeConflictOutcomes`
 * (merge-conflict-outcomes.ts), called from the batch loop right after this function.
 * Do not read this function's return (`void`) as proof a non-rectified conflict is
 * fully handled — check the caller too.
 */
export function reconcileBatchOutcome(
  prd: PRD,
  batchResult: Pick<RunParallelBatchResult, "completed" | "mergeConflicts">,
): void {
  for (const story of batchResult.completed) {
    markStoryPassed(prd, story.id);
  }
  for (const conflict of batchResult.mergeConflicts) {
    if (conflict.rectified) {
      markStoryPassed(prd, conflict.story.id);
    } else {
      markStoryFailed(prd, conflict.story.id, undefined, "merge-conflict");
    }
  }
}
