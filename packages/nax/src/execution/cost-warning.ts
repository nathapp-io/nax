import { checkCostWarning, isTriggerEnabled } from "../interaction/triggers";
import type { SequentialExecutionContext } from "./executor-types";

/** Shared 80%-of-budget cost-warning trigger — used by both the sequential and batch paths. */
export async function maybeSendCostWarning(
  ctx: SequentialExecutionContext,
  enforcedCost: number,
  costLimit: number,
  warningSent: boolean,
): Promise<boolean> {
  if (warningSent || !ctx.interactionChain || !isTriggerEnabled("cost-warning", ctx.config)) return warningSent;
  const triggerCfg = ctx.config.interaction?.triggers?.["cost-warning"];
  const threshold = typeof triggerCfg === "object" ? (triggerCfg.threshold ?? 0.8) : 0.8;
  if (enforcedCost < costLimit * threshold) return warningSent;
  await checkCostWarning(
    { featureName: ctx.feature, cost: enforcedCost, limit: costLimit },
    ctx.config,
    ctx.interactionChain,
  );
  return true;
}
