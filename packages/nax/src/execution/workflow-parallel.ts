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

/** Parallel paths are unreachable in workflow mode (normalisation forces parallel off). Reaching one is a bug. */
export function assertPipelineMode(config: NaxConfig, site: string): void {
  if (isWorkflowMode(config)) {
    throw new NaxError(`[${site}] parallel execution reached in workflow mode`, "WORKFLOW_PARALLEL_UNREACHABLE", {
      stage: "execution",
      site,
    });
  }
}
