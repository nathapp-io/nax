/**
 * Bake-off Pipeline Adapter
 *
 * Adapts a `ContestantRunContext` into a real `Runner.run()` invocation and
 * normalizes the result + `metrics.json` history into a `ContestantPipelineResult`.
 */

import { join } from "node:path";
import { featureDir, globalConfigDir } from "../config";
import { run } from "../execution";
import type { RunOptions, RunResult } from "../execution";
import { loadHooksConfig } from "../hooks";
import { loadRunMetrics } from "../metrics";
import type { RunMetrics } from "../metrics";
import type {
  ContestantPipelineResult,
  ContestantRunContext,
  ContestantStoryMetric,
  ContestantStoryResult,
} from "./contestant";

/** Injectable deps (project `_deps` convention) — tests override these. */
export const _pipelineAdapterDeps = {
  run: (options: RunOptions): Promise<RunResult> => run(options),
  loadHooksConfig,
  loadRunMetrics,
};

function toResults(result: RunResult): ContestantStoryResult[] {
  const status: ContestantStoryResult["status"] = result.success ? "passed" : "failed";
  return Array.from({ length: result.storiesCompleted }, () => ({ status }));
}

function toMetrics(runs: RunMetrics[], result: RunResult): ContestantStoryMetric[] {
  const latest = runs.at(-1);
  if (latest && latest.stories.length > 0) {
    return latest.stories.map((story) => ({
      cost: story.cost,
      durationMs: story.durationMs,
      attempts: story.attempts,
    }));
  }
  return [{ cost: result.totalCost, durationMs: result.durationMs, attempts: 1 }];
}

/**
 * Executes a contestant's run context through the real pipeline and maps
 * the result back into a `ContestantPipelineResult`.
 */
export async function pipeline(ctx: ContestantRunContext): Promise<ContestantPipelineResult> {
  const hooks = await _pipelineAdapterDeps.loadHooksConfig(ctx.worktree, globalConfigDir());
  const prdPath = join(featureDir(ctx.worktree, ctx.feature), "prd.json");
  const statusFile = join(ctx.outputDir, "status.json");

  const result = await _pipelineAdapterDeps.run({
    prdPath,
    workdir: ctx.worktree,
    config: ctx.config,
    hooks,
    feature: ctx.feature,
    dryRun: false,
    statusFile,
  });

  const runs = await _pipelineAdapterDeps.loadRunMetrics(ctx.outputDir);

  return {
    results: toResults(result),
    metrics: toMetrics(runs, result),
  };
}
