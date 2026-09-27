/**
 * Acceptance Criteria Refinement
 *
 * Per-story refinement of PRD acceptance criteria, extracted from
 * `acceptance-setup`'s `runAcceptanceSetup` so that stage stays under the
 * source-size limit.
 *
 * Each story is dispatched through the injected `callOp` under a bounded
 * concurrency cap, and the results are returned in input story order. A story
 * whose `callOp` rejects (after the op's own retry budget is exhausted) falls
 * back to its unrefined criteria, flagged `refinementFallback: true`, and its
 * id is collected into `fallbackStoryIds` so the caller can emit one
 * run-level warning.
 */

import type { RefinedCriterion } from "@/acceptance";
import type { NaxConfig } from "@/config";
import type { AcceptanceConfig } from "@/config/selectors";
import type { AcceptanceRefineInput, AcceptanceRefineOutput, Operation } from "@/operations";
import type { UserStory } from "@/prd/types";
import type { PipelineContext } from "../types";

/** Outcome of refining every supplied story's acceptance criteria. */
export interface RefineAcceptanceCriteriaResult {
  /** Refined criteria for every story, in the order the stories were supplied. */
  criteria: RefinedCriterion[];
  /** Stories that fell back to their unrefined criteria, in story order. */
  fallbackStoryIds: string[];
}

/**
 * Dispatch seam for refinement. Mirrors `_acceptanceSetupDeps.callOp` so the
 * stage can pass its injectable dep straight through.
 */
export type RefineCallOp = (
  ctx: PipelineContext,
  packageDir: string,
  op: Operation<AcceptanceRefineInput, AcceptanceRefineOutput, AcceptanceConfig>,
  input: AcceptanceRefineInput,
  storyId?: string,
  config?: NaxConfig,
) => Promise<AcceptanceRefineOutput>;

/**
 * Refine each story's acceptance criteria through `callOp`.
 *
 * @internal stub — the implementer supplies the real loop.
 */
export function refineAcceptanceCriteria(
  _ctx: PipelineContext,
  _stories: UserStory[],
  _groupConfigs: Map<string, NaxConfig>,
  _callOp: RefineCallOp,
): Promise<RefineAcceptanceCriteriaResult> {
  return Promise.resolve({ criteria: [], fallbackStoryIds: [] });
}
