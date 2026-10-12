import type { NaxConfig } from "../config";
import { isWorkflowMode } from "../config";

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
