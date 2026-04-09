import { buildSessionName } from "../agents/acp/adapter";
import { createAgentRegistry, getAgent } from "../agents/registry";
import type { AgentAdapter, CompleteOptions, CompleteResult } from "../agents/types";
import type { ModelTier, NaxConfig } from "../config";
import { DEFAULT_CONFIG, resolveModel, resolveModelForAgent } from "../config";
import type { PipelineStage } from "../config/permissions";
import type { ModelDef } from "../config/schema-types";
import { getSafeLogger } from "../logger";
import { tryParseLLMJson } from "../utils/llm-json";
import { judgeResolver, majorityResolver, synthesisResolver } from "./resolvers";
import type { DebateResult, DebateStageConfig, Debater } from "./types";

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
  /** Synthesised output from synthesis/custom resolver — undefined for majority resolver */
  output?: string;
  /** Structured dialogue result from ReviewerSession resolver (debate+dialogue mode only) */
  dialogueResult?: import("../review/dialogue").ReviewDialogueResult;
}

/** Context required by resolveOutcome() when a ReviewerSession is used. Only populated from semantic.ts debate path. */
export interface ResolverContext {
  diff: string;
  story: { id: string; title: string; acceptanceCriteria: string[] };
  semanticConfig: import("../review/types").SemanticReviewConfig;
  labeledProposals: Array<{ debater: string; output: string }>;
  resolverType: import("./types").ResolverType;
  /** True when this is a re-review after autofix (calls reReviewDebate instead of resolveDebate) */
  isReReview?: boolean;
}

/** Input type for DebateSessionOptions — ResolverContext without labeledProposals (added by sub-modules after proposals collected). */
export type ResolverContextInput = Omit<ResolverContext, "labeledProposals">;

export interface DebateSessionOptions {
  storyId: string;
  stage: string;
  stageConfig: DebateStageConfig;
  config: NaxConfig;
  workdir?: string;
  featureName?: string;
  timeoutSeconds?: number;
  /** Optional ReviewerSession for debate+dialogue mode (US-001/US-002) */
  reviewerSession?: import("../review/dialogue").ReviewerSession;
  /** Outer resolver context (without labeledProposals) — sub-modules complete it */
  resolverContextInput?: ResolverContextInput;
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

/** Resolve the model string for a debater. Defaults to "fast" tier; falls back to raw model string on config error. */
export function resolveDebaterModel(debater: Debater, config: NaxConfig): string | undefined {
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

/** Common model shorthand aliases → tier mapping for debater config convenience */
const MODEL_SHORTHAND_TIERS: Record<string, ModelTier> = {
  haiku: "fast",
  sonnet: "balanced",
  opus: "powerful",
};

export function resolveModelDefForDebater(debater: Debater, tier: ModelTier, config: NaxConfig): ModelDef {
  const modelOverride = debater.model;
  let effectiveTier = tier;
  if (modelOverride) {
    // Check alias first (haiku/sonnet/opus → fast/balanced/powerful).
    const aliasedTier = MODEL_SHORTHAND_TIERS[modelOverride.toLowerCase()];
    if (aliasedTier) {
      // Shorthand alias — resolve through config.models with the mapped tier.
      effectiveTier = aliasedTier;
    } else if (!isTierLabel(modelOverride)) {
      // Full model ID (e.g. "claude-haiku-4-5-20251001") — pass through directly.
      return resolveModel(modelOverride);
    }
    // Explicit tier label (fast/balanced/powerful) — fall through to config-based resolution.
  }

  const configModels = config?.models ?? DEFAULT_CONFIG.models;
  const configDefaultAgent = config?.autoMode?.defaultAgent ?? DEFAULT_CONFIG.autoMode.defaultAgent;

  try {
    return resolveModelForAgent(configModels, debater.agent, effectiveTier, configDefaultAgent);
  } catch {
    // Fall through to secondary fallback strategies.
  }

  try {
    return resolveModelForAgent(
      DEFAULT_CONFIG.models,
      DEFAULT_CONFIG.autoMode.defaultAgent,
      effectiveTier,
      DEFAULT_CONFIG.autoMode.defaultAgent,
    );
  } catch {
    return resolveModelForAgent(configModels, debater.agent, "fast", configDefaultAgent);
  }
}

/** Standalone resolver logic — extracted from DebateSession.resolve(). */
export async function resolveOutcome(
  proposalOutputs: string[],
  critiqueOutputs: string[],
  stageConfig: DebateStageConfig,
  config: NaxConfig,
  storyId: string,
  timeoutMs: number,
  workdir?: string,
  featureName?: string,
  reviewerSession?: import("../review/dialogue").ReviewerSession,
  resolverContext?: ResolverContext,
  promptSuffix?: string,
): Promise<ResolveOutcome> {
  const resolverConfig = stageConfig.resolver;
  const logger = _debateSessionDeps.getSafeLogger();

  // ── Debate + dialogue path ───────────────────────────────────────────────
  // When a ReviewerSession and resolver context are both provided, delegate
  // to the session for a tool-verified verdict. Falls back to stateless on error.
  if (reviewerSession && resolverContext) {
    try {
      const debateCtx: import("../review/dialogue-prompts").DebateResolverContext = {
        resolverType: resolverConfig.type,
      };

      // For majority resolvers: compute raw vote + tally first, pass as context.
      if (resolverConfig.type === "majority-fail-closed" || resolverConfig.type === "majority-fail-open") {
        const failOpen = resolverConfig.type === "majority-fail-open";
        const rawOutcome = majorityResolver(proposalOutputs, failOpen);
        let passCount = 0;
        let failCount = 0;
        for (const proposal of proposalOutputs) {
          const parsed = tryParseLLMJson<Record<string, unknown>>(proposal);
          if (parsed !== null && typeof parsed.passed === "boolean" && parsed.passed) passCount++;
          else if (failOpen) passCount++;
          else failCount++;
        }
        debateCtx.majorityVote = { passed: rawOutcome === "passed", passCount, failCount };
      }

      const story = {
        id: resolverContext.story.id,
        title: resolverContext.story.title,
        description: "",
        acceptanceCriteria: resolverContext.story.acceptanceCriteria,
      };

      let dialogueResult: import("../review/dialogue").ReviewDialogueResult;
      if (resolverContext.isReReview) {
        dialogueResult = await reviewerSession.reReviewDebate(
          resolverContext.labeledProposals,
          critiqueOutputs,
          resolverContext.diff,
          debateCtx,
        );
      } else {
        dialogueResult = await reviewerSession.resolveDebate(
          resolverContext.labeledProposals,
          critiqueOutputs,
          resolverContext.diff,
          story,
          resolverContext.semanticConfig,
          debateCtx,
        );
      }

      const outcome = dialogueResult.checkResult.success ? "passed" : "failed";
      return {
        outcome,
        resolverCostUsd: dialogueResult.cost ?? 0,
        dialogueResult,
      };
    } catch (err) {
      logger?.warn("debate", "ReviewerSession.resolveDebate() failed — falling back to stateless resolver", {
        storyId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall through to stateless resolver
    }
  }

  // Stateless paths (no ReviewerSession, or fallback after error)
  // US-004 AC: warn when session supplied without resolverContext (cannot call resolveDebate without diff/story)
  if (reviewerSession && !resolverContext) {
    logger?.warn(
      "debate",
      "ReviewerSession provided but resolverContext is undefined — falling back to stateless resolver",
      { storyId },
    );
  }

  if (resolverConfig.type === "majority-fail-closed" || resolverConfig.type === "majority-fail-open") {
    if (workdir !== undefined && !reviewerSession) {
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

  if (resolverConfig.type === "synthesis") {
    const agentName = resolverConfig.agent ?? RESOLVER_FALLBACK_AGENT;
    const adapter = _debateSessionDeps.getAgent(agentName, config);
    if (adapter) {
      const synthesisSessionName =
        workdir !== undefined ? buildSessionName(workdir, featureName, storyId, "synthesis") : undefined;
      const resolverResult = await synthesisResolver(proposalOutputs, critiqueOutputs, {
        adapter,
        promptSuffix,
        completeOptions: {
          model: resolveDebaterModel({ agent: agentName }, config),
          config,
          storyId,
          featureName,
          workdir,
          sessionRole: "synthesis",
          timeoutMs,
          ...(synthesisSessionName !== undefined && { sessionName: synthesisSessionName }),
        },
      });
      return {
        outcome: "passed",
        resolverCostUsd: resolverResult.costUsd,
        output: resolverResult.output,
      };
    }
    return { outcome: "passed", resolverCostUsd: 0 };
  }

  if (resolverConfig.type === "custom") {
    const agentName = resolverConfig.agent ?? RESOLVER_FALLBACK_AGENT;
    const judgeSessionName =
      workdir !== undefined ? buildSessionName(workdir, featureName, storyId, "judge") : undefined;
    const resolverResult = await judgeResolver(proposalOutputs, critiqueOutputs, resolverConfig, {
      getAgent: (name: string) => _debateSessionDeps.getAgent(name, config),
      defaultAgentName: RESOLVER_FALLBACK_AGENT,
      completeOptions: {
        model: resolveDebaterModel({ agent: agentName }, config),
        config,
        storyId,
        featureName,
        workdir,
        sessionRole: "judge",
        timeoutMs,
        ...(judgeSessionName !== undefined && { sessionName: judgeSessionName }),
      },
    });
    return {
      outcome: "passed",
      resolverCostUsd: resolverResult.costUsd,
      output: resolverResult.output,
    };
  }

  return { outcome: "passed", resolverCostUsd: 0 };
}
