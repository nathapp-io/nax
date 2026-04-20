import { AgentManager, resolveDefaultAgent } from "../agents";
import type { IAgentManager } from "../agents";
import { computeAcpHandle } from "../agents/acp/adapter";
import type { CompleteOptions, CompleteResult } from "../agents/types";
import type { ModelTier, NaxConfig, ResolvedConfiguredModel } from "../config";
import { DEFAULT_CONFIG, resolveConfiguredModel, resolveModelForAgent } from "../config";
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
  agentName: string;
}

export interface SuccessfulProposal {
  debater: Debater;
  agentName: string;
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
  /** How the diff is provided — drives DiffContext construction for the dialogue path */
  diffMode: "embedded" | "ref";
  /** Pre-collected diff (embedded mode) */
  diff?: string;
  /** Git baseline ref (ref mode) */
  storyGitRef?: string;
  /** Git diff --stat summary (ref mode) */
  stat?: string;
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
  config?: NaxConfig;
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
  createManager: (config: NaxConfig): IAgentManager => new AgentManager(config),
  getSafeLogger: getSafeLogger as () => ReturnType<typeof getSafeLogger>,
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
};

/** Resolve the model string for a debater. Defaults to "fast" tier; falls back to raw model string on config error. */
export function resolveDebaterModel(debater: Debater, config?: NaxConfig): string | undefined {
  const modelSelection = { agent: debater.agent, model: debater.model ?? "fast" };
  if (!config?.models) return debater.model;
  try {
    const defaultAgent = resolveDefaultAgent(config);
    return resolveConfiguredModel(config.models, debater.agent, modelSelection, defaultAgent).modelDef.model;
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

export async function runComplete(
  agentManager: IAgentManager,
  agentName: string,
  prompt: string,
  options: CompleteOptions,
  modelTier: ModelTier,
  timeoutMs?: number,
): Promise<CompleteResult> {
  return agentManager.completeAs(agentName, prompt, {
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

export function resolveModelDefForDebater(debater: Debater, tier: ModelTier, config: NaxConfig): ModelDef {
  const configModels = config?.models ?? DEFAULT_CONFIG.models;
  // Use optional chaining throughout: config may be partially-constructed in tests.
  const configDefaultAgent = resolveDefaultAgent(config ?? DEFAULT_CONFIG);

  try {
    return resolveConfiguredModel(
      configModels,
      debater.agent,
      { agent: debater.agent, model: debater.model ?? tier },
      configDefaultAgent,
    ).modelDef;
  } catch {
    // Fall through to secondary fallback strategies.
  }

  try {
    return resolveConfiguredModel(
      DEFAULT_CONFIG.models,
      debater.agent,
      { agent: debater.agent, model: debater.model ?? tier },
      resolveDefaultAgent(DEFAULT_CONFIG),
    ).modelDef;
  } catch {
    return resolveModelForAgent(configModels, debater.agent, "fast", configDefaultAgent);
  }
}

/** Standalone resolver logic — extracted from DebateSession.resolve(). */
export async function resolveOutcome(
  proposalOutputs: string[],
  critiqueOutputs: string[],
  stageConfig: DebateStageConfig,
  config: NaxConfig | undefined,
  storyId: string,
  timeoutMs: number,
  workdir?: string,
  featureName?: string,
  reviewerSession?: import("../review/dialogue").ReviewerSession,
  resolverContext?: ResolverContext,
  promptSuffix?: string,
  debaters?: Debater[],
): Promise<ResolveOutcome> {
  const resolverConfig = stageConfig.resolver;
  const logger = _debateSessionDeps.getSafeLogger();

  // ── Debate + dialogue path ───────────────────────────────────────────────
  // When a ReviewerSession and resolver context are both provided, delegate
  // to the session for a tool-verified verdict. Falls back to stateless on error.
  if (reviewerSession && resolverContext) {
    try {
      const debateCtx: import("./types").DebateResolverContext = {
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

      // Build diffContext from resolverContext — discriminated on diffMode.
      const diffContext: import("../review/types").DiffContext =
        resolverContext.diffMode === "ref"
          ? { mode: "ref", storyGitRef: resolverContext.storyGitRef ?? "", stat: resolverContext.stat }
          : { mode: "embedded", diff: resolverContext.diff ?? "" };

      let dialogueResult: import("../review/dialogue").ReviewDialogueResult;
      if (resolverContext.isReReview) {
        dialogueResult = await reviewerSession.reReviewDebate(
          resolverContext.labeledProposals,
          critiqueOutputs,
          diffContext,
          debateCtx,
        );
      } else {
        dialogueResult = await reviewerSession.resolveDebate(
          resolverContext.labeledProposals,
          critiqueOutputs,
          diffContext,
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
    const manager = _debateSessionDeps.createManager(config ?? DEFAULT_CONFIG);
    if (manager.getAgent(agentName) !== undefined) {
      const configModels = config?.models ?? DEFAULT_CONFIG.models;
      const configDefaultAgent = resolveDefaultAgent(config ?? DEFAULT_CONFIG);
      const synthesisSessionName =
        workdir !== undefined ? computeAcpHandle(workdir, featureName, storyId, "synthesis") : undefined;
      const resolverDebater: Debater = { agent: agentName, model: resolverConfig.model };
      const resolverSelection = { agent: agentName, model: resolverConfig.model ?? "fast" };
      let resolvedResolverModel: ResolvedConfiguredModel;
      try {
        resolvedResolverModel = resolveConfiguredModel(configModels, agentName, resolverSelection, configDefaultAgent);
      } catch {
        resolvedResolverModel = {
          agent: agentName,
          modelDef: { provider: "unknown", model: resolverSelection.model } as ModelDef,
          modelTier: modelTierFromDebater(resolverDebater),
        };
      }
      const resolverTier = resolvedResolverModel.modelTier ?? modelTierFromDebater(resolverDebater);
      const resolverResult = await synthesisResolver(proposalOutputs, critiqueOutputs, {
        agentManager: manager,
        agentName,
        promptSuffix,
        debaters,
        completeOptions: {
          model: resolvedResolverModel.modelDef.model,
          modelTier: resolverTier,
          config: config ?? DEFAULT_CONFIG,
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
    const manager = _debateSessionDeps.createManager(config ?? DEFAULT_CONFIG);
    const configModels = config?.models ?? DEFAULT_CONFIG.models;
    const configDefaultAgent = resolveDefaultAgent(config ?? DEFAULT_CONFIG);
    const judgeSessionName =
      workdir !== undefined ? computeAcpHandle(workdir, featureName, storyId, "judge") : undefined;
    const resolverDebater: Debater = { agent: agentName, model: resolverConfig.model };
    const resolverSelection = { agent: agentName, model: resolverConfig.model ?? "fast" };
    let resolvedResolverModel: ResolvedConfiguredModel;
    try {
      resolvedResolverModel = resolveConfiguredModel(configModels, agentName, resolverSelection, configDefaultAgent);
    } catch {
      resolvedResolverModel = {
        agent: agentName,
        modelDef: { provider: "unknown", model: resolverSelection.model } as ModelDef,
        modelTier: modelTierFromDebater(resolverDebater),
      };
    }
    const resolverTier = resolvedResolverModel.modelTier ?? modelTierFromDebater(resolverDebater);
    const resolverResult = await judgeResolver(proposalOutputs, critiqueOutputs, resolverConfig, {
      agentManager: manager,
      defaultAgentName: RESOLVER_FALLBACK_AGENT,
      debaters,
      completeOptions: {
        model: resolvedResolverModel.modelDef.model,
        modelTier: resolverTier,
        config: config ?? DEFAULT_CONFIG,
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
