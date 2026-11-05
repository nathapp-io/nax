import { resolveSubagentModel } from "@/chat";
import { modelEntryId, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import type { AgentResource } from "@/resources/types";

const UNKNOWN_MODEL_GUIDANCE = "pass provider/model, acp:<agent>, or a configured alias";
const MISSING_PARENT_MODEL = "configure models.native.balanced or pass --model";

export function resolveAgentsRunModel(input: {
  agent: AgentResource;
  config: NaxConfig;
  modelOverride?: string;
}): string {
  const { agent, config, modelOverride } = input;
  const requested = modelOverride ?? agent.model;
  const resolved = resolveSubagentModel({
    requested,
    parentModel: "",
    aliases: config.agent?.modelAliases ?? {},
    tiers: config.models.native,
  });

  if (modelOverride !== undefined && resolved.source === "fallback") {
    throw new NaxError(`unknown model ${modelOverride}; ${UNKNOWN_MODEL_GUIDANCE}`, "AGENTS_RUN_USAGE", {
      stage: "agents-run",
      model: modelOverride,
    });
  }

  if (resolved.source !== "inherit" && resolved.source !== "fallback") return resolved.model;

  const balanced = config.models.native?.balanced;
  if (balanced === undefined) {
    throw new NaxError(MISSING_PARENT_MODEL, "AGENTS_RUN_USAGE", { stage: "agents-run" });
  }
  return modelEntryId(balanced);
}
