/** The run's `execution.costLimit` check, shared by the story loop and the feature workflow (nax#2550). */
import type { NaxRuntime } from "@/runtime";
import { totalSpendUsd } from "@/runtime";

/** True once the run's spend has reached a positive `costLimit`; no limit (or 0) never trips. */
export function costLimitReached(costLimit: number | undefined, runtime: Pick<NaxRuntime, "costAggregator">): boolean {
  return (
    typeof costLimit === "number" && costLimit > 0 && totalSpendUsd(runtime.costAggregator.snapshot()) >= costLimit
  );
}
