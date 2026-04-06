/**
 * session-helpers.ts
 *
 * Shared types, constants, injectable deps, and pure helper functions used
 * across DebateSession and its extracted sub-modules.
 */

import { buildSessionName } from "../agents/acp/adapter";
import { createAgentRegistry, getAgent } from "../agents/registry";
import type { AgentAdapter, CompleteOptions, CompleteResult } from "../agents/types";
import type { ModelTier } from "../config";
import type { NaxConfig } from "../config";
import { DEFAULT_CONFIG, resolveModel, resolveModelForAgent } from "../config";
import type { PipelineStage } from "../config/permissions";
import type { ModelDef } from "../config/schema-types";
import { getSafeLogger } from "../logger";
import { judgeResolver, majorityResolver, synthesisResolver } from "./resolvers";
import type { DebateResult, DebateStageConfig, Debater, Rebuttal } from "./types";

/** Fallback agent name used when resolver.agent is not specified for synthesis/judge */
export const RESOLVER_FALLBACK_AGENT = "synthesis";

export const DEFAULT_TIMEOUT_SECONDS = 600;

// ─── Internal shared interfaces ──────────────────────────────────────────────

export interface ResolvedDebater {
  debater: Debater;
  adapter: AgentAdapter;
}

export interface SuccessfulProposal {
  debater: Debater;
  adapter: AgentAdapter;
  output: string;
  /** Cost for this complete() call in USD. */
  cost: number;
  roleKey?: string;
}

export interface ResolveOutcome {
  outcome: "passed" | "failed" | "skipped";
  resolverCostUsd: number;
}

// ─── Exported public API ──────────────────────────────────────────────────────

export interface DebateSessionOptions {
  storyId: string;
  stage: string;
  stageConfig: DebateStageConfig;
  config?: NaxConfig;
  workdir?: string;
  featureName?: string;
  timeoutSeconds?: number;
}

/** Injectable deps for testability */
export const _debateSessionDeps = {
  /**
   * Resolve an agent adapter by name.
   * When config is provided, uses createAgentRegistry(config) so that ACP agents
   * are returned as AcpAgentAdapter (respecting agent.protocol).
   * Falls back to bare getAgent() when config is absent (backward compat / tests).
   */
  getAgent: (name: string, config?: NaxConfig): AgentAdapter | undefined =>
    config ? createAgentRegistry(config).getAgent(name) : getAgent(name),
  getSafeLogger: getSafeLogger as () => ReturnType<typeof getSafeLogger>,
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
};

/**
 * Resolve the model string for a debater.
 * When debater.model is set, treat it as a tier name and resolve via config.models.
 * When absent, default to "fast" tier.
 * Falls back to the raw debater.model string if config resolution fails (backward compat).
 */
export function resolveDebaterModel(debater: Debater, config?: NaxConfig): string | undefined {
  const tier = debater.model ?? "fast";
  if (!config?.models) return debater.model;
  try {
    const defaultAgent = config.autoMode?.defaultAgent ?? debater.agent;
    const modelDef = resolveModelForAgent(config.models, debater.agent, tier, defaultAgent);
    return modelDef.model;
  } catch {
    // Config resolution failed — return raw model string as fallback (backward compat)
    return debater.model;
  }
}

// ─── Pure helper functions ────────────────────────────────────────────────────

export function buildFailedResult(
  storyId: string,
  stage: string,
  stageConfig: DebateStageConfig,
  totalCostUsd = 0,
): DebateResult {
  return {
    storyId,
    stage,
    outcome: "failed",
    rounds: 0,
    debaters: [],
    resolverType: stageConfig.resolver.type,
    proposals: [],
    totalCostUsd,
  };
}

export function modelTierFromDebater(debater: Debater): ModelTier {
  if (debater.model === "fast" || debater.model === "balanced" || debater.model === "powerful") {
    return debater.model;
  }
  return "fast";
}

export function isTierLabel(value: string): value is ModelTier {
  return value === "fast" || value === "balanced" || value === "powerful";
}

export async function runComplete(
  adapter: AgentAdapter,
  prompt: string,
  options: CompleteOptions,
  modelTier: ModelTier,
  timeoutMs?: number,
): Promise<CompleteResult> {
  return adapter.complete(prompt, {
    ...options,
    modelTier,
    ...(timeoutMs !== undefined && { timeoutMs }),
  });
}

export function pipelineStageForDebate(stage: string): PipelineStage {
  switch (stage) {
    case "plan":
    case "review":
    case "rectification":
    case "acceptance":
      return stage;
    default:
      return "run";
  }
}

export function resolveModelDefForDebater(debater: Debater, tier: ModelTier, config: NaxConfig | undefined): ModelDef {
  if (debater.model && !isTierLabel(debater.model)) {
    return resolveModel(debater.model);
  }

  const configModels = config?.models ?? DEFAULT_CONFIG.models;
  const configDefaultAgent = config?.autoMode?.defaultAgent ?? DEFAULT_CONFIG.autoMode.defaultAgent;

  try {
    return resolveModelForAgent(configModels, debater.agent, tier, configDefaultAgent);
  } catch {
    // Fall through to secondary fallback strategies.
  }

  try {
    return resolveModelForAgent(
      DEFAULT_CONFIG.models,
      DEFAULT_CONFIG.autoMode.defaultAgent,
      tier,
      DEFAULT_CONFIG.autoMode.defaultAgent,
    );
  } catch {
    return resolveModelForAgent(configModels, debater.agent, "fast", configDefaultAgent);
  }
}

/**
 * Standalone implementation of the resolver logic (extracted from DebateSession.resolve()).
 */
export async function resolveOutcome(
  proposalOutputs: string[],
  critiqueOutputs: string[],
  stageConfig: DebateStageConfig,
  config: NaxConfig | undefined,
  storyId: string,
  timeoutMs: number,
  workdir?: string,
  featureName?: string,
): Promise<ResolveOutcome> {
  const resolverConfig = stageConfig.resolver;
  const logger = _debateSessionDeps.getSafeLogger();

  if (resolverConfig.type === "majority-fail-closed" || resolverConfig.type === "majority-fail-open") {
    if (workdir !== undefined) {
      logger?.warn(
        "debate",
        "majority resolver does not support implementer session resumption — switch to synthesis or custom resolver for context-aware semantic review",
      );
    }
    return {
      outcome: majorityResolver(proposalOutputs, resolverConfig.type === "majority-fail-open"),
      resolverCostUsd: 0,
    };
  }

  const implementerSessionName =
    workdir !== undefined ? buildSessionName(workdir, featureName, storyId, "implementer") : undefined;

  if (resolverConfig.type === "synthesis") {
    const agentName = resolverConfig.agent ?? RESOLVER_FALLBACK_AGENT;
    const adapter = _debateSessionDeps.getAgent(agentName, config);
    if (adapter) {
      const resolverResult = await synthesisResolver(proposalOutputs, critiqueOutputs, {
        adapter,
        completeOptions: {
          model: resolveDebaterModel({ agent: agentName }, config),
          config,
          storyId,
          sessionRole: "synthesis",
          timeoutMs,
          ...(implementerSessionName !== undefined && { sessionName: implementerSessionName }),
        },
      });
      return {
        outcome: "passed",
        resolverCostUsd: resolverResult.costUsd,
      };
    }
    return { outcome: "passed", resolverCostUsd: 0 };
  }

  if (resolverConfig.type === "custom") {
    const agentName = resolverConfig.agent ?? RESOLVER_FALLBACK_AGENT;
    const resolverResult = await judgeResolver(proposalOutputs, critiqueOutputs, resolverConfig, {
      getAgent: (name: string) => _debateSessionDeps.getAgent(name, config),
      defaultAgentName: RESOLVER_FALLBACK_AGENT,
      completeOptions: {
        model: resolveDebaterModel({ agent: agentName }, config),
        config,
        storyId,
        sessionRole: "judge",
        timeoutMs,
        ...(implementerSessionName !== undefined && { sessionName: implementerSessionName }),
      },
    });
    return {
      outcome: "passed",
      resolverCostUsd: resolverResult.costUsd,
    };
  }

  return { outcome: "passed", resolverCostUsd: 0 };
}

/**
 * Build a rebuttal context string for a debater in the hybrid rebuttal loop.
 * Formats proposals with debater agent labels and appends previous rebuttals when present.
 */
export function buildRebuttalContext(opts: {
  proposals: string[];
  debaters: Debater[];
  rebuttals: Rebuttal[];
  currentDebaterIndex: number;
}): string {
  const { proposals, debaters, rebuttals, currentDebaterIndex } = opts;

  const proposalsSection = proposals
    .map((p, i) => {
      const agentName = debaters[i]?.agent ?? `debater-${i + 1}`;
      return `### ${agentName}\n${p}`;
    })
    .join("\n\n");

  const rebuttalsSection =
    rebuttals.length > 0
      ? `\n\n## Previous Rebuttals\n${rebuttals.map((r, i) => `${i + 1}. ${r.output}`).join("\n\n")}`
      : "";

  const debaterNumber = currentDebaterIndex + 1;

  return `## Proposals\n${proposalsSection}${rebuttalsSection}\n\nYou are debater ${debaterNumber}. Provide your rebuttal.`;
}
