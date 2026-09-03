/**
 * Dry Run Handler (ADR-005, Phase 4)
 *
 * Extracted from pipeline-result-handler.ts to slim that file below 200 lines.
 */

import { pipelineEventBus } from "@/pipeline";
import { getSafeLogger } from "../logger";
import type { PluginRegistry } from "../plugins";
import { markStoryPassed } from "../prd";
import type { PRD, UserStory } from "../prd/types";
import type { routeTask } from "../routing";
import type { StatusWriter } from "./status-writer";

export interface DryRunContext {
  prd: PRD;
  storiesToExecute: UserStory[];
  routing: ReturnType<typeof routeTask>;
  statusWriter: StatusWriter;
  pluginRegistry: PluginRegistry;
  runId: string;
  totalCost: number;
  iterations: number;
}

export interface DryRunResult {
  storiesCompletedDelta: number;
  prdDirty: boolean;
}

/** Handle dry-run iteration: log what would happen, mark stories passed IN MEMORY. */
export async function handleDryRun(ctx: DryRunContext): Promise<DryRunResult> {
  const logger = getSafeLogger();

  ctx.statusWriter.setPrd(ctx.prd);
  ctx.statusWriter.setCurrentStory({
    storyId: ctx.storiesToExecute[0].id,
    title: ctx.storiesToExecute[0].title,
    complexity: ctx.routing.complexity,
    tddStrategy: ctx.routing.testStrategy,
    model: ctx.routing.modelTier,
    attempt: (ctx.storiesToExecute[0].attempts ?? 0) + 1,
    phase: "routing",
  });
  await ctx.statusWriter.update(ctx.totalCost, ctx.iterations);

  for (const s of ctx.storiesToExecute) {
    logger?.info("execution", "[DRY RUN] Would execute agent here", {
      storyId: s.id,
      storyTitle: s.title,
      modelTier: ctx.routing.modelTier,
      complexity: ctx.routing.complexity,
      testStrategy: ctx.routing.testStrategy,
    });
  }

  // Marked in memory only, and deliberately NOT persisted (nax#1808). The
  // marks are what let isComplete(prd) end the loop; writing them is what made
  // a later real run skip the story and execute nothing.
  //
  // This is why the returned prdDirty is false: unified-executor answers
  // prdDirty by reloading the PRD from disk, which would drop these marks and
  // spin the loop to maxIterations.
  for (const s of ctx.storiesToExecute) {
    markStoryPassed(ctx.prd, s.id);
  }

  for (const s of ctx.storiesToExecute) {
    pipelineEventBus.emit({
      type: "story:completed",
      storyId: s.id,
      story: { id: s.id, title: s.title, status: s.status, attempts: s.attempts },
      passed: true,
      runElapsedMs: 0,
      cost: 0,
      modelTier: ctx.routing.modelTier,
      testStrategy: ctx.routing.testStrategy,
    });
  }

  ctx.statusWriter.setPrd(ctx.prd);
  ctx.statusWriter.setCurrentStory(null);
  await ctx.statusWriter.update(ctx.totalCost, ctx.iterations);

  return { storiesCompletedDelta: ctx.storiesToExecute.length, prdDirty: false };
}
