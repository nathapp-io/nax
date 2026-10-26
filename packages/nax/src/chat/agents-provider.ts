/** The `nax-agents` provider: validated, named-agent invocation for a chat session. */
import type { ProviderTool, ToolProvider, ToolResult } from "@nathapp/nax-agent";
import { buildAgentsInstructions } from "@/prompts";
import type { AgentResource, ResourceCatalog } from "@/resources";

const MAX_AVAILABLE_AGENTS = 20;

export interface AgentsProviderOptions {
  readonly catalog: ResourceCatalog;
  /** Runs the nested agent; the nested session lifecycle lives behind it. */
  readonly run: (agent: AgentResource, task: string, signal: AbortSignal | undefined) => Promise<ToolResult>;
}

function failure(content: string): ToolResult {
  return { content, isError: true };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** A static provider; it advertises nothing for a catalog without agents. */
export function createAgentsProvider(options: AgentsProviderOptions): ToolProvider {
  const { catalog } = options;
  const tool: ProviderTool = {
    localName: "run",
    description: "Run a named catalog agent on a self-contained task and return its final answer.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" }, task: { type: "string" } },
      required: ["agent", "task"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const { agent: name, task } = input;
      if (!nonEmptyString(name) || !nonEmptyString(task)) {
        return failure("[chat] run requires agent: string and task: string");
      }
      const agent = catalog.findAgent(name);
      if (!agent) {
        const available = catalog.agents
          .slice(0, MAX_AVAILABLE_AGENTS)
          .map((entry) => entry.qualifiedName)
          .join(", ");
        return failure(`unknown agent ${name}; available: ${available}`);
      }
      return options.run(agent, task, ctx.signal);
    },
  };
  return {
    id: "nax-agents",
    kind: "static",
    stages: ["*"],
    tools: async () => (catalog.agents.length ? [tool] : []),
    instructions: async () => (catalog.agents.length ? buildAgentsInstructions(catalog.agents) : undefined),
  };
}
