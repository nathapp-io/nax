/** Command-wide bot budget and live canonical spend (including failed dispatches). */
import { DEFAULT_CONFIG, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { type NaxRuntime, totalSpendUsd } from "@/runtime";

export interface BotCostEnv {
  readonly limitUsd: number;
  spentUsd(): number;
}

export function botCostLimit(config: NaxConfig, override?: number): number {
  const limit = override ?? config.bot?.costLimit ?? DEFAULT_CONFIG.bot?.costLimit;
  if (limit === undefined) throw new NaxError("[bot] Missing cost limit", "BOT_COST_LIMIT_MISSING", { stage: "bot" });
  return limit;
}

export function botCostEnv(
  config: NaxConfig,
  runtime: Pick<NaxRuntime, "costAggregator">,
  override?: number,
): BotCostEnv {
  return {
    limitUsd: botCostLimit(config, override),
    spentUsd: () => totalSpendUsd(runtime.costAggregator.snapshot()),
  };
}
