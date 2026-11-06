/**
 * US-007: compose the run input one `nax agents run` task hands to `runAgentTask`.
 *
 * It is a smaller version of what a chat session composes (`chatResources`): the resolved model,
 * the two read-only tool providers and the rule-delivery loop handlers — and nothing else. No
 * memory host or memory tools, no catalog MCP servers, no `nax-jobs` launch tools, no agents
 * provider, no plugin handlers and no agent hooks, so a nax-plugin-provided agent or skill is not
 * found here. Catalog and trust loading belong to the command (US-008); this module is handed the
 * catalog and absolute paths.
 *
 * The model is delegated to {@link resolveAgentsRunModel} and its errors are not caught: an
 * unknown `--model` or a missing `models.native.balanced` is a usage error the command reports.
 *
 * Tools follow the model and the agent file. An agent that declares `tools:` decides for itself —
 * including a write tool, in which case the configured `execution.permissions` ask and deny rules
 * are the only guard. A native agent with no `tools:` line is narrowed to
 * {@link AGENTS_RUN_NATIVE_READ_TOOLS}, and an ACP one is given no `allowedTools` at all, so its
 * unattended `review` profile governs.
 */
import { createWorkflowProvider, type FeatureStateOptions, mapSubagentTools } from "@/chat";
import { getProjectKey, type NaxConfig } from "@/config";
import { createRuleDeliveryHandlers, type RuleDeliveryInput } from "@/context/rules/rule-delivery";
import { type AgentResource, createSkillsProvider, type ResourceCatalog } from "@/resources";
import { projectOutputDir } from "@/runtime";
import type { AgentsRunTaskInput } from "./agents-run-exec";
import { resolveAgentsRunModel } from "./agents-run-model";

/**
 * The tools a native agent that declares no `tools:` line is given: the read-only set, plus the
 * two providers this run attaches. There is no write tool — a spec reviewer reads.
 */
export const AGENTS_RUN_NATIVE_READ_TOOLS: readonly string[] = Object.freeze([
  "Read",
  "Glob",
  "Grep",
  "Git",
  "nax-skills__*",
  "nax-workflow__*",
]);

/** An ACP model names a CLI agent (`acp:<agent>`); every other model runs on the native path. */
const ACP_MODEL_PREFIX = "acp:";

/** Everything the run reaches that must be substitutable in a test. */
export const _agentsRunComposeDeps = {
  resolveAgentsRunModel,
  createSkillsProvider,
  createWorkflowProvider,
  createRuleDeliveryHandlers,
};

export interface AgentsRunComposeInput {
  readonly agent: AgentResource;
  /** Already expanded by `resolveAgentsRunTask`. */
  readonly task: string;
  readonly catalog: ResourceCatalog;
  readonly config: NaxConfig;
  readonly cwd: string;
  readonly repoRoot: string;
  /** `--model`. */
  readonly modelOverride?: string;
  readonly timeoutSeconds?: number;
  readonly signal?: AbortSignal;
}

/**
 * The tool names the run admits.
 *
 * A declared `tools:` line wins — the mapping drops what has no nax equivalent and keeps a write
 * tool, so the permission rules stay the guard. With no `tools:` line the answer follows the
 * model: the native read-only set, or nothing at all for an ACP agent, whose profile decides.
 */
function allowedToolsFor(model: string, tools: readonly string[] | undefined): readonly string[] | undefined {
  if (tools !== undefined) return mapSubagentTools(tools).allowedTools;
  return model.startsWith(ACP_MODEL_PREFIX) ? undefined : AGENTS_RUN_NATIVE_READ_TOOLS;
}

/** The artifact directory the workflow provider reads, as chat passes it. */
function workflowOptions(input: AgentsRunComposeInput): FeatureStateOptions {
  return {
    repoRoot: input.repoRoot,
    outputDir: projectOutputDir(getProjectKey(input.config, input.repoRoot), input.config.outputDir),
  };
}

/** Rule delivery reads the configured override, so an override rule reaches this session too. */
function ruleDeliveryOptions(input: AgentsRunComposeInput): RuleDeliveryInput {
  const rules = input.config.context.rules;
  return { repoRoot: input.repoRoot, overrideDir: rules.overrideDir, overrideMode: rules.overrideMode };
}

/**
 * Build the input of one run: the resolved model, the tools, the two providers and the handlers.
 *
 * The providers are ordered skills then workflow, which is also the tool-name order
 * `AGENTS_RUN_NATIVE_READ_TOOLS` names. A `resolveAgentsRunModel` failure propagates unchanged.
 */
export function buildAgentsRunTaskInput(
  input: AgentsRunComposeInput,
  deps: typeof _agentsRunComposeDeps = _agentsRunComposeDeps,
): AgentsRunTaskInput {
  const model = deps.resolveAgentsRunModel({
    agent: input.agent,
    config: input.config,
    modelOverride: input.modelOverride,
  });
  const allowedTools = allowedToolsFor(model, input.agent.tools);
  return {
    agent: input.agent,
    task: input.task,
    model,
    ...(allowedTools === undefined ? {} : { allowedTools }),
    toolProviders: [
      deps.createSkillsProvider(async () => input.catalog),
      deps.createWorkflowProvider(workflowOptions(input)),
    ],
    loopHandlers: deps.createRuleDeliveryHandlers(ruleDeliveryOptions(input)),
    cwd: input.cwd,
    repoRoot: input.repoRoot,
    config: input.config,
    timeoutSeconds: input.timeoutSeconds,
    signal: input.signal,
  };
}
