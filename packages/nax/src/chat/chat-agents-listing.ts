/** What `/agents` shows: each catalog agent with the model and tools it would run with. */
import type { NaxConfig } from "@/config";
import { cleanIndexDescription } from "@/prompts";
import type { ResourceCatalog } from "@/resources";
import { resolveSubagentModel, type SubagentModelSource } from "./subagent-model";
import { type DroppedSubagentTool, mapSubagentTools } from "./subagent-tools";

export interface ChatAgentRow {
  /** The qualified name, so a shadowed agent stays addressable. */
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly modelSource: SubagentModelSource;
  /** The nax tools the agent is admitted to, or `"all"` when its file declares no `tools:`. */
  readonly tools: readonly string[] | "all";
  readonly dropped: readonly DroppedSubagentTool[];
}

export interface ListAgentRowsOptions {
  readonly catalog: Pick<ResourceCatalog, "agents"> | undefined;
  readonly config: Pick<NaxConfig, "agent" | "models">;
  /** The chat session's model now; inherited models follow switches. */
  readonly parentModel: string;
}

const NO_AGENTS = "(no agents)";

/** One row per catalog agent in catalog order, resolved the way a run resolves them. */
export function listAgentRows({ catalog, config, parentModel }: ListAgentRowsOptions): readonly ChatAgentRow[] {
  return (catalog?.agents ?? []).map((agent) => {
    const { model, source } = resolveSubagentModel({
      ...(agent.model !== undefined ? { requested: agent.model } : {}),
      parentModel,
      aliases: config.agent?.modelAliases ?? {},
      tiers: config.models.native,
    });
    const { allowedTools, dropped } = mapSubagentTools(agent.tools);
    return {
      name: agent.qualifiedName,
      description: agent.description,
      model,
      modelSource: source,
      tools: allowedTools ?? "all",
      dropped,
    };
  });
}

function toolsLabel(tools: ChatAgentRow["tools"]): string {
  if (tools === "all") return "all";
  return tools.length === 0 ? "none" : tools.join(", ");
}

function agentLines(row: ChatAgentRow): string[] {
  return [
    `${row.name}  ${row.model} (${row.modelSource})  tools ${toolsLabel(row.tools)}  ${cleanIndexDescription(row.description)}`,
    ...row.dropped.map((tool) => `  dropped: ${tool.name} (${tool.reason})`),
  ];
}

export function formatAgentsListing(rows: readonly ChatAgentRow[]): string {
  return rows.length === 0 ? NO_AGENTS : rows.flatMap(agentLines).join("\n");
}
