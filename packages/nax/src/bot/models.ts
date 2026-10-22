import type { ConfiguredModel, NaxConfig } from "../config";
import { NaxError } from "../errors";

/** Review/fix leave an unset model to the op; rulings default independently to fast. */
export function botModel(
  config: NaxConfig,
  role: "review" | "fix" | "rulings",
  override?: ConfiguredModel,
): ConfiguredModel | undefined {
  if (role === "rulings") return override ?? config.bot?.models.rulings ?? "fast";
  const workflowRole = role === "review" ? "branchReview" : "branchFix";
  const finishRole = role === "review" ? "quality" : "fix";
  return (
    override ??
    config.bot?.models[role] ??
    config.workflow?.models[workflowRole] ??
    config.finish?.reviewers[finishRole] ??
    undefined
  );
}

/** Parse a tier or an explicit agent:model, preserving colons inside the model id. */
export function parseModelOption(value: string): ConfiguredModel {
  const separator = value.indexOf(":");
  if (value.length === 0 || separator === 0 || separator === value.length - 1) {
    throw new NaxError("[bot] Invalid --model: expected a tier or non-empty agent:model", "BOT_MODEL_INVALID", {
      stage: "bot",
      value,
    });
  }
  if (separator === -1) return value;
  return { agent: value.slice(0, separator), model: value.slice(separator + 1) };
}
