/**
 * Subagent model resolution (chat-subagents US-004).
 *
 * Pure and cost-blind: no session creation, no provider discovery. An ordered
 * pipeline in which the first step that answers wins. A configured alias always
 * beats the `haiku`/`sonnet`/`opus` -> `models.native` tier step.
 */

import { modelEntryId, type NaxConfig } from "@/config";
import { isChatAcpModel } from "./acp";

export type SubagentModelSource = "inherit" | "alias" | "tier" | "model" | "fallback";

/** How the chat shows where a subagent's model came from. */
export type SubagentModelLabel = "inherited" | "alias" | "tier" | "agent file" | "override" | "fallback to parent";

/**
 * The display label for a resolved model, given where it came from and whether a
 * `nax-agents__run` override asked for it.
 *
 * An override wins only when the model would otherwise have come from the agent
 * file: the label names where the model id came from, and an override that
 * resolves through an alias or a tier got its id there. An override of `inherit`
 * likewise keeps "inherited", because the parent's model is what runs.
 */
export function subagentModelLabel(source: SubagentModelSource, overridden: boolean): SubagentModelLabel {
  if (overridden && source === "model") return "override";
  switch (source) {
    case "inherit":
      return "inherited";
    case "alias":
      return "alias";
    case "tier":
      return "tier";
    case "model":
      return "agent file";
    case "fallback":
      return "fallback to parent";
  }
}

export interface ResolveSubagentModelOptions {
  /** The agent's `model:` frontmatter value, when set. */
  requested?: string;
  /** The parent session's model, as `provider/model`. */
  parentModel: string;
  /** `agent.modelAliases`: Claude Code model name -> nax model id. */
  aliases: Readonly<Record<string, string>>;
  /** `models.native`: tier name -> model entry. */
  tiers: NaxConfig["models"]["native"];
}

export interface ResolvedSubagentModel {
  model: string;
  source: SubagentModelSource;
}

const INHERIT = "inherit";

/** Claude Code model family -> nax tier name. */
const FAMILY_TIERS: Readonly<Record<string, "fast" | "balanced" | "powerful">> = {
  haiku: "fast",
  sonnet: "balanced",
  opus: "powerful",
};

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function tierModel(requested: string, tiers: ResolveSubagentModelOptions["tiers"]): string | undefined {
  const tier = ownValue(FAMILY_TIERS, requested);
  if (tier === undefined) return undefined;
  const entry = tiers?.[tier];
  if (entry === undefined) return undefined;
  // `modelEntryId`, not `${entry.provider}/${entry.model}`: config validation
  // requires a native tier's model string to carry its provider already, so
  // prefixing the sibling field again yields "openai/openai/gpt-5.4-mini".
  return modelEntryId(entry);
}

export function resolveSubagentModel(options: ResolveSubagentModelOptions): ResolvedSubagentModel {
  const { requested, parentModel, aliases, tiers } = options;
  if (requested === undefined || requested === INHERIT) return { model: parentModel, source: "inherit" };

  const alias = ownValue(aliases, requested);
  if (alias !== undefined) return { model: alias, source: "alias" };

  const tier = tierModel(requested, tiers);
  if (tier !== undefined) return { model: tier, source: "tier" };

  // An `acp:` target names an explicit model, exactly like `provider/model`: it
  // asks for a specific agent, never for the parent's model.
  if (isChatAcpModel(requested) || requested.includes("/")) return { model: requested, source: "model" };
  return { model: parentModel, source: "fallback" };
}
