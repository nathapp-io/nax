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
import { getSafeLogger } from "@/logger";
import {
  type AcceptanceRefineInput,
  type AcceptanceRefineOutput,
  acceptanceRefineOp,
  type Operation,
} from "@/operations";
import type { UserStory } from "@/prd/types";
import { errorMessage } from "@/utils/errors";
import { storyAbsWorkdir } from "@/utils/path-frame";
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
 * Results are collected into per-story slots (not appended) so the returned
 * criteria stay in the order the stories were supplied, whatever order the
 * concurrent dispatches settle in.
 */
export async function refineAcceptanceCriteria(
  ctx: PipelineContext,
  stories: UserStory[],
  groupConfigs: Map<string, NaxConfig>,
  callOp: RefineCallOp,
): Promise<RefineAcceptanceCriteriaResult> {
  const maxConcurrency = ctx.config.acceptance.refinementConcurrency ?? 3;
  const perStory: RefinedCriterion[][] = new Array(stories.length);
  const fellBack: boolean[] = new Array(stories.length).fill(false);
  const failureReasons: string[] = new Array(stories.length).fill("");
  const executing = new Set<Promise<void>>();

  for (let i = 0; i < stories.length; i++) {
    const story = stories[i];
    const packageDir = storyAbsWorkdir(ctx.workdir, story);
    const config = groupConfigs.get(packageDir) ?? ctx.config;
    const task = callOp(
      ctx,
      packageDir,
      acceptanceRefineOp,
      {
        criteria: story.acceptanceCriteria,
        codebaseContext: "",
        storyId: story.id,
        testStrategy: config.acceptance.testStrategy,
        testFramework: config.acceptance.testFramework,
        storyTitle: story.title,
        storyDescription: story.description,
      },
      story.id,
      config,
    )
      .then((refined) => {
        // Normalise the discriminator: a caller must be able to read
        // `refinementFallback` as a boolean rather than treating `undefined`
        // as a third state for "refined normally".
        perStory[i] = refined.map((criterion) => ({
          ...criterion,
          refinementFallback: criterion.refinementFallback === true,
        }));
      })
      .catch((err: unknown) => {
        fellBack[i] = true;
        // Keep the rejection cause: the run-level warn below is otherwise a
        // bare list of story ids and diagnosing a fallback (empty output vs
        // unusable JSON vs count mismatch vs transport error) would require
        // reproducing the run.
        failureReasons[i] = errorMessage(err);
        // `testable: true` is deliberate: runHardeningPass discards ACs marked
        // `testable === false`, which would silently drop the story's criteria.
        perStory[i] = story.acceptanceCriteria.map((c) => ({
          original: c,
          refined: c,
          testable: true,
          storyId: story.id,
          refinementFallback: true,
        }));
      })
      .finally(() => {
        executing.delete(task);
      });
    executing.add(task);

    if (executing.size >= maxConcurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);

  const failedIndexes = stories.map((_, i) => i).filter((i) => fellBack[i]);
  const fallbackStoryIds = failedIndexes.map((i) => stories[i].id);
  if (fallbackStoryIds.length > 0) {
    getSafeLogger()?.warn("acceptance-setup", "AC refinement unusable after retries — using unrefined criteria", {
      storyId: fallbackStoryIds[0],
      storyIds: fallbackStoryIds,
      failures: failedIndexes.map((i) => ({ storyId: stories[i].id, error: failureReasons[i] })),
    });
  }

  return { criteria: perStory.flat(), fallbackStoryIds };
}
