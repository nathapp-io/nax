import { errorMessage } from "@nathapp/nax-agent/internal";
import { resolveDefaultAgent } from "../agents";
import { type ConfiguredModel, DEFAULT_CONFIG, type NaxConfig, resolveConfiguredModel } from "../config";
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

/** The two shapes `--model` accepts, named in every refusal. */
const ACCEPTED_MODEL_FORMS = "accepted forms: <tier> or <agent>:<model>";

/** The override as the user wrote it: the tier string, or the `agent:model` pair it parses to. */
function overrideText(model: ConfiguredModel): string {
  return typeof model === "string" ? model : `${model.agent}:${model.model}`;
}

/** The default agent's declared tiers, in config order; `none` when it has no entry at all. */
function configuredTierList(config: NaxConfig, defaultAgent: string): string {
  const tiers = Object.keys((config.models ?? DEFAULT_CONFIG.models)[defaultAgent] ?? {});
  return tiers.length === 0 ? "none" : tiers.join(", ");
}

/** A provider-qualified id written without an agent prefix is a `parseModelOption` slip, not a typo. */
function agentPrefixHint(defaultAgent: string, model: ConfiguredModel): string | undefined {
  const bare = typeof model === "string" && model.includes("/") && !model.includes(":");
  return bare ? `a provider/model id needs its agent prefix, for example ${defaultAgent}:${model}` : undefined;
}

/**
 * US-003 (#2999): why an explicit `--model` cannot dispatch, or `undefined` when it can.
 *
 * The tiers are read from the config loaded out of the checkout's base snapshot, so this runs right
 * after `loadBotConfig` and before the runtime, the run log or any install/build step. It resolves
 * through the same `resolveConfiguredModel` call the op dispatch prologue makes, so a value this
 * accepts cannot fail later: a string is always a tier (and throws `MODEL_NOT_FOUND` when no agent
 * configures it), while an `{ agent, model }` literal keeps the resolver's warn-only treatment.
 */
export function checkBotModelOverride(config: NaxConfig, model: ConfiguredModel | undefined): string | undefined {
  if (model === undefined) return undefined;
  const defaultAgent = resolveDefaultAgent(config);
  try {
    resolveConfiguredModel(config.models ?? DEFAULT_CONFIG.models, defaultAgent, model, defaultAgent);
    return undefined;
  } catch (error) {
    const parts = [
      `invalid --model "${overrideText(model)}": ${errorMessage(error)}`,
      ACCEPTED_MODEL_FORMS,
      `configured tiers: ${configuredTierList(config, defaultAgent)}`,
    ];
    const hint = agentPrefixHint(defaultAgent, model);
    if (hint !== undefined) parts.push(hint);
    return parts.join("; ");
  }
}
