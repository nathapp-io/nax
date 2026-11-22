/** The `nax-agents` provider: validated, named-agent invocation for a chat session. */
import type { ProviderTool, ToolProvider, ToolResult } from "@nathapp/nax-agent";
import { BACKGROUND_DEFAULT_SENTENCE, buildAgentsInstructions, EXPLORE_SENTENCE } from "@/prompts";
import type { AgentResource, ResourceCatalog } from "@/resources";
import { agentNamed, EXPLORE_AGENT_NAME, GENERAL_AGENT_NAME, generalAgent } from "./builtin-agent";

const MAX_AVAILABLE_AGENTS = 20;

const BACKGROUND_PLACEHOLDER = "{background}";
const RUN_DESCRIPTION = `Run a named catalog agent on a self-contained task and return its final answer. Optional model overrides the agent's model: provider/model (for example openai-codex/gpt-6-luna) runs it on the nax native agent with that provider's model; acp:<agent> (for example acp:codex) runs it on an installed ACP agent. A provider name such as openai-codex is a native provider, not the Codex ACP agent. To run a task with no catalog agent, omit agent (or pass agent general): the task runs on the built-in general agent with your tools, on your model unless you pass model. ${BACKGROUND_PLACEHOLDER}${EXPLORE_SENTENCE}`;

const INVALID_INPUT = "[chat] run requires agent: string and task: string";
const BAD_MODEL = "[chat] run model must be a non-empty string";
const BAD_RUN_IN_BACKGROUND = "[chat] run runInBackground must be a boolean";
const NO_RUN_IN_BACKGROUND = "[chat] runInBackground is not available in this chat";

export interface AgentsProviderOptions {
  readonly catalog: ResourceCatalog;
  /** Runs the nested agent; the nested session lifecycle lives behind it. */
  readonly run: (
    agent: AgentResource,
    task: string,
    signal: AbortSignal | undefined,
    model?: string,
  ) => Promise<ToolResult>;
  /** Starts a background run; absent when the chat has no background task registry. */
  readonly runInBackground?: (agent: AgentResource, task: string, model?: string) => Promise<ToolResult>;
  /**
   * Read per call: whether `runInBackground` can start a run now. Absent means it can whenever
   * the callback exists. A host whose registry is attached later reports it here, so an absent
   * flag never lands on a refusal.
   */
  readonly backgroundAvailable?: () => boolean;
}

function failure(content: string): ToolResult {
  return { content, isError: true };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The built-in agents first, then the catalog's (capped), each name once. */
function availableAgents(catalog: ResourceCatalog): readonly string[] {
  const builtins = [GENERAL_AGENT_NAME, EXPLORE_AGENT_NAME];
  const catalogNames = catalog.agents.slice(0, MAX_AVAILABLE_AGENTS).map((entry) => entry.qualifiedName);
  return [...builtins, ...catalogNames.filter((name) => !builtins.includes(name))];
}

function unknownAgent(catalog: ResourceCatalog, name: string): ToolResult {
  return failure(`unknown agent ${name}; available: ${availableAgents(catalog).join(", ")}`);
}

/**
 * The `run` input's dispatch target, in the order the checks apply: a failure, the
 * built-in general agent for a bare task or a bare model, or a named agent.
 */
type RunTarget =
  | { readonly kind: "failure"; readonly result: ToolResult }
  | { readonly kind: "general"; readonly task: string; readonly model?: string }
  | { readonly kind: "agent"; readonly name: string; readonly task: string; readonly model?: string };

function targetOf(input: Record<string, unknown>): RunTarget {
  const { agent: name, task, model } = input;
  if (!nonEmptyString(task) || (name !== undefined && !nonEmptyString(name))) {
    return { kind: "failure", result: failure(INVALID_INPUT) };
  }
  if (model !== undefined && !nonEmptyString(model)) return { kind: "failure", result: failure(BAD_MODEL) };
  // No agent at all is the general agent: it runs on the chat's model unless `model` names one.
  if (name === undefined) return { kind: "general", task, ...(model !== undefined ? { model } : {}) };
  return { kind: "agent", name, task, ...(model !== undefined ? { model } : {}) };
}

/** The description, naming the background default only where the chat can honour it. */
function runDescription(options: AgentsProviderOptions): string {
  return RUN_DESCRIPTION.replace(
    BACKGROUND_PLACEHOLDER,
    backgroundOffered(options) ? `${BACKGROUND_DEFAULT_SENTENCE} ` : "",
  );
}

/** True when a call that names no flag would start a background run. */
function backgroundOffered(options: AgentsProviderOptions): boolean {
  return options.runInBackground !== undefined && (options.backgroundAvailable?.() ?? true);
}

/**
 * Whether this call runs in the background. Background is the default wherever the chat can
 * start one; an explicit `false` is the foreground. An absent flag where no registry exists
 * falls back to the foreground silently, while an explicit `true` there stays an error.
 */
function wantsBackground(options: AgentsProviderOptions, flag: unknown): boolean {
  if (flag === true) return true;
  return flag !== false && backgroundOffered(options);
}

/**
 * Starts a background run instead of a foreground one. The agent already skipped the
 * turn's signal, so it is not passed: a background run outlives the turn that started it.
 */
function startBackground(
  options: AgentsProviderOptions,
  agent: AgentResource,
  task: string,
  model: string | undefined,
): Promise<ToolResult> {
  const start = options.runInBackground;
  if (!start || options.backgroundAvailable?.() === false) return Promise.resolve(failure(NO_RUN_IN_BACKGROUND));
  return model === undefined ? start(agent, task) : start(agent, task, model);
}

/**
 * A static provider. It is always offered: even with no catalog agent the built-in
 * `general` and `explore` agents are reachable, and the three fixed instruction lines
 * still tell the model so.
 */
export function createAgentsProvider(options: AgentsProviderOptions): ToolProvider {
  const { catalog } = options;
  const tool: ProviderTool = {
    localName: "run",
    get description() {
      return runDescription(options);
    },
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        task: { type: "string" },
        model: { type: "string" },
        runInBackground: { type: "boolean" },
      },
      required: ["task"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const target = targetOf(input);
      if (target.kind === "failure") return target.result;
      // A present flag must be a boolean; an absent one follows the chat's default.
      if (input.runInBackground !== undefined && typeof input.runInBackground !== "boolean") {
        return failure(BAD_RUN_IN_BACKGROUND);
      }
      const background = wantsBackground(options, input.runInBackground);
      if (target.kind === "general") {
        const general = generalAgent();
        if (background) return startBackground(options, general, target.task, target.model);
        return options.run(general, target.task, ctx.signal, target.model);
      }
      const agent = agentNamed(catalog, target.name);
      // An unknown name is reported before the background capability is checked.
      if (!agent) return unknownAgent(catalog, target.name);
      if (background) return startBackground(options, agent, target.task, target.model);
      return target.model === undefined
        ? options.run(agent, target.task, ctx.signal)
        : options.run(agent, target.task, ctx.signal, target.model);
    },
  };
  return {
    id: "nax-agents",
    kind: "static",
    stages: ["*"],
    tools: async () => [tool],
    instructions: async () => buildAgentsInstructions(catalog.agents, { background: backgroundOffered(options) }),
  };
}
