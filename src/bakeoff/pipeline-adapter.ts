/**
 * Bake-off Pipeline Adapter
 *
 * Adapts a `ContestantRunContext` into a real `Runner.run()` invocation and
 * normalizes the result + `metrics.json` history into a `ContestantPipelineResult`.
 */

import { run } from "../execution";
import type { RunOptions, RunResult } from "../execution";
import { loadHooksConfig } from "../hooks";
import { loadRunMetrics } from "../metrics";
import type { ContestantPipelineResult, ContestantRunContext } from "./contestant";

/** Injectable deps (project `_deps` convention) — tests override these. */
export const _pipelineAdapterDeps = {
  run: (options: RunOptions): Promise<RunResult> => run(options),
  loadHooksConfig,
  loadRunMetrics,
};

/**
 * Executes a contestant's run context through the real pipeline and maps
 * the result back into a `ContestantPipelineResult`.
 */
export async function pipeline(_ctx: ContestantRunContext): Promise<ContestantPipelineResult> {
  throw new Error("not implemented"); // nax-lint-allow: plain-error
}
