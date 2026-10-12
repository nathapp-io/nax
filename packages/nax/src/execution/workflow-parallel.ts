import type { NaxConfig } from "../config";
import { isWorkflowMode } from "../config";
import { NaxError } from "../errors";

/** A5 W-R11: workflow mode runs stories one at a time. `--parallel` is a CLI flag, not config, so it is clamped here. */
export function effectiveParallelCount(
  config: NaxConfig,
  requested: number | undefined,
  warn: (msg: string) => void,
): number | undefined {
  if (!isWorkflowMode(config) || !requested) return requested;
  warn(`execution.mode "workflow" runs stories one at a time; --parallel ${requested} ignored`);
  return 0;
}

/**
 * A5: workflow mode runs one story per dispatch. Batching groups consecutive simple stories into one
 * pipeline pass, and completionStage would mark every batched story passed while workflowStage only runs
 * the first, so batching is clamped off. `warn` fires once, only when it overrides a requested batch.
 */
export function effectiveUseBatch(config: NaxConfig, requested: boolean, warn: (msg: string) => void): boolean {
  if (!isWorkflowMode(config) || !requested) return requested;
  warn('execution.mode "workflow" runs stories one at a time; story batching disabled');
  return false;
}

/** Parallel paths are unreachable in workflow mode (normalisation forces parallel off). Reaching one is a bug. */
export function assertPipelineMode(config: NaxConfig, site: string): void {
  if (isWorkflowMode(config)) {
    throw new NaxError(`[${site}] parallel execution reached in workflow mode`, "WORKFLOW_PARALLEL_UNREACHABLE", {
      stage: "execution",
      site,
    });
  }
}
