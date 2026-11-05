/** The `nax-agents` provider: validated, named-agent invocation for a chat session. */
import type { ProviderTool, ToolProvider, ToolResult } from "@nathapp/nax-agent";
import { buildAgentsInstructions } from "@/prompts";
import type { AgentResource, ResourceCatalog } from "@/resources";
import { generalAgent } from "./builtin-agent";

const MAX_AVAILABLE_AGENTS = 20;

const RUN_DESCRIPTION =
  "Run a named catalog agent on a self-contained task and return its final answer. Optional model overrides the agent's model: provider/model (for example openai-codex/gpt-6-luna) runs it on the nax native agent with that provider's model; acp:<agent> (for example acp:codex) runs it on an installed ACP agent. A provider name such as openai-codex is a native provider, not the Codex ACP agent. To run a task on a model with no catalog agent, omit agent and pass model: the task runs on the built-in general agent with your tools.";

const INVALID_INPUT = "[chat] run requires agent: string and task: string";
const BAD_MODEL = "[chat] run model must be a non-empty string";
const NO_TARGET = "[chat] run requires agent, or model to run the built-in general agent";

export interface AgentsProviderOptions {
  readonly catalog: ResourceCatalog;
  /** Runs the nested agent; the nested session lifecycle lives behind it. */
  readonly run: (
    agent: AgentResource,
    task: string,
    signal: AbortSignal | undefined,
    model?: string,
  ) => Promise<ToolResult>;
}

function failure(content: string): ToolResult {
  return { content, isError: true };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function unknownAgent(catalog: ResourceCatalog, name: string): ToolResult {
  const available = catalog.agents
    .slice(0, MAX_AVAILABLE_AGENTS)
    .map((entry) => entry.qualifiedName)
    .join(", ");
  return failure(`unknown agent ${name}; available: ${available}`);
}

/**
 * The `run` input's dispatch target, in the order the checks apply: a failure, the
 * built-in general agent for a bare model, or a named catalog agent.
 */
type RunTarget =
  | { readonly kind: "failure"; readonly result: ToolResult }
  | { readonly kind: "general"; readonly task: string; readonly model: string }
  | { readonly kind: "agent"; readonly name: string; readonly task: string; readonly model?: string };

function targetOf(input: Record<string, unknown>): RunTarget {
  const { agent: name, task, model } = input;
  if (!nonEmptyString(task) || (name !== undefined && !nonEmptyString(name))) {
    return { kind: "failure", result: failure(INVALID_INPUT) };
  }
  if (model !== undefined && !nonEmptyString(model)) return { kind: "failure", result: failure(BAD_MODEL) };
  if (name === undefined) {
    return model === undefined ? { kind: "failure", result: failure(NO_TARGET) } : { kind: "general", task, model };
  }
  return { kind: "agent", name, task, ...(model !== undefined ? { model } : {}) };
}

/** A static provider; it advertises nothing for a catalog without agents. */
export function createAgentsProvider(options: AgentsProviderOptions): ToolProvider {
  const { catalog } = options;
  const tool: ProviderTool = {
    localName: "run",
    description: RUN_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" }, task: { type: "string" }, model: { type: "string" } },
      required: ["task"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const target = targetOf(input);
      if (target.kind === "failure") return target.result;
      if (target.kind === "general") return options.run(generalAgent(), target.task, ctx.signal, target.model);
      const agent = catalog.findAgent(target.name);
      if (!agent) return unknownAgent(catalog, target.name);
      return target.model === undefined
        ? options.run(agent, target.task, ctx.signal)
        : options.run(agent, target.task, ctx.signal, target.model);
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
