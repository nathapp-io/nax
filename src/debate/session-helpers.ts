import { resolveDefaultAgent } from "../agents";
import type { IAgentManager } from "../agents";
import type { CompleteOptions, CompleteResult } from "../agents/types";
import type { ConfiguredModel, ModelTier } from "../config";
import { DEFAULT_CONFIG, resolveConfiguredModel, resolveModelForAgent } from "../config";
import type { PipelineStage } from "../config/permissions";
import type { ModelsConfig } from "../config/schema-types";
import type { ModelDef } from "../config/schema-types";
import type { DebateConfig } from "../config/selectors";
import { getSafeLogger } from "../logger";
import type { CallContext } from "../operations/types";
import type { DispatchContext } from "../runtime/dispatch-context";
import type { SessionRole } from "../session/types";
import { pickBaseSelectorKind, pickSelectorKind, resolveSelector } from "./selectors";
import type { SelectorContext } from "./selectors";
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
  /** Optional findings from selector output. */
  findings?: unknown[];
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
  /**
   * Ref-mode production diff excludes derived from resolveTestFilePatterns().
   * Used to avoid hardcoded language-specific test file patterns in debate prompts.
   */
  productionExcludePatterns?: readonly string[];
  story: { id: string; title: string; acceptanceCriteria: string[] };
  semanticConfig: import("../review/types").SemanticReviewConfig;
  /** Blocking threshold used by semantic review post-processing. */
  blockingThreshold?: "error" | "warning" | "info";
  labeledProposals: Array<{ debater: string; output: string }>;
  resolverType: import("./types").ResolverType;
  /** True when this is a re-review after autofix (calls reReviewDebate instead of resolveDebate) */
  isReReview?: boolean;
}

/** Input type for DebateSessionOptions — ResolverContext without labeledProposals (added by sub-modules after proposals collected). */
export type ResolverContextInput = Omit<ResolverContext, "labeledProposals">;

export interface DebateSessionOptions extends DispatchContext {
  storyId: string;
  stage: string;
  stageConfig: DebateStageConfig;
  config?: DebateConfig;
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
  agentManager: undefined as IAgentManager | undefined,
  getSafeLogger: getSafeLogger as () => ReturnType<typeof getSafeLogger>,
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
};

/** Resolve the model string for a debater. Defaults to "fast" tier; falls back to raw model string on config error. */
export function resolveDebaterModel(debater: Debater, config?: DebateConfig): string | undefined {
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
  _modelTier: ModelTier,
  timeoutMs?: number,
): Promise<CompleteResult> {
  return agentManager.completeAs(agentName, prompt, {
    ...options,
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

export function resolveModelDefForDebater(
  debater: Debater,
  model: ConfiguredModel,
  modelsConfig: ModelsConfig,
  defaultAgent: string,
): ModelDef {
  try {
    return resolveConfiguredModel(modelsConfig, debater.agent, model, defaultAgent).modelDef;
  } catch {
    // Fall through to secondary fallback strategies.
  }

  try {
    return resolveConfiguredModel(DEFAULT_CONFIG.models, debater.agent, model, resolveDefaultAgent(DEFAULT_CONFIG))
      .modelDef;
  } catch {
    return resolveModelForAgent(modelsConfig, debater.agent, "fast", defaultAgent);
  }
}

/**
 * Build a CallContext suitable for resolver ops (synthesis/judge).
 *
 * Overrides runtime.agentManager with the effective agent manager so that
 * test mocks injected via _debateSessionDeps.agentManager are visible to callOp.
 * Sets sessionOverride.role so callOp emits sessionRole and sessionName in
 * completeOptions (matching what tests capture and the ACP adapter would derive).
 */
function buildResolverCallContext(
  provided: CallContext,
  agentManager: IAgentManager,
  storyId: string,
  workdir: string,
  featureName: string,
  sessionRole: "synthesis" | "judge" | undefined,
): CallContext {
  const sessionOverride = sessionRole !== undefined ? { role: sessionRole as SessionRole } : undefined;
  return {
    ...provided,
    runtime: { ...provided.runtime, agentManager } as typeof provided.runtime,
    packageDir: workdir,
    storyId,
    featureName,
    ...(sessionOverride !== undefined ? { sessionOverride } : {}),
  };
}

/** Standalone resolver logic — delegates to resolveSelector(pickSelectorKind(...)). */
export async function resolveOutcome(
  proposalOutputs: string[],
  critiqueOutputs: string[],
  stageConfig: DebateStageConfig,
  config: DebateConfig,
  callContext: CallContext,
  storyId: string,
  timeoutMs: number,
  workdir: string | undefined,
  featureName: string | undefined,
  reviewerSession: import("../review/dialogue").ReviewerSession | undefined,
  resolverContext: ResolverContext | undefined,
  promptSuffix: string | undefined,
  debaters: Debater[] | undefined,
  agentManager: IAgentManager,
): Promise<ResolveOutcome> {
  const logger = _debateSessionDeps.getSafeLogger();

  // Warn when session supplied without resolverContext
  if (reviewerSession && !resolverContext) {
    logger?.warn(
      "debate",
      "ReviewerSession provided but resolverContext is undefined — falling back to stateless resolver",
      { storyId },
    );
  }

  // Strip labeledProposals to build resolverContextInput
  const resolverContextInput: ResolverContextInput | undefined = resolverContext
    ? (({ labeledProposals: _lp, ...rest }) => rest)(resolverContext)
    : undefined;

  const kind = pickSelectorKind(stageConfig, { reviewerSession, resolverContextInput });

  // Legacy: majority resolver warning when workdir is defined
  if ((kind === "majority-fail-closed" || kind === "majority-fail-open") && workdir !== undefined && !reviewerSession) {
    logger?.warn(
      "debate",
      "majority resolver does not support implementer session resumption — switch to synthesis or custom resolver for context-aware semantic review",
    );
  }

  // Reconstruct SuccessfulProposal[] from flat arrays
  const proposalList = debaters
    ? debaters.map((debater, i) => ({
        debater,
        agentName: debater.agent,
        output: proposalOutputs[i] ?? "",
        cost: 0,
      }))
    : proposalOutputs.map((output) => ({
        debater: { agent: RESOLVER_FALLBACK_AGENT },
        agentName: RESOLVER_FALLBACK_AGENT,
        output,
        cost: 0,
      }));

  const effectiveAgentManager = (agentManager ?? _debateSessionDeps.agentManager) as IAgentManager;

  const resolverSessionRole: "synthesis" | "judge" | undefined =
    kind === "synthesis" ? "synthesis" : kind === "judge" ? "judge" : undefined;
  const effectiveConfig = config ?? {
    debate: DEFAULT_CONFIG.debate,
    models: DEFAULT_CONFIG.models,
    agent: DEFAULT_CONFIG.agent,
  };
  const effectiveCallContext = buildResolverCallContext(
    callContext,
    effectiveAgentManager,
    storyId,
    workdir ?? "",
    featureName ?? "",
    resolverSessionRole,
  );

  const selectorCtx: SelectorContext = {
    storyId,
    stage: "",
    stageConfig,
    config: effectiveConfig,
    proposals: proposalList,
    labeledProposals: resolverContext?.labeledProposals,
    critiques: critiqueOutputs,
    workdir: workdir ?? "",
    featureName: featureName ?? "",
    timeoutMs,
    agentManager: effectiveAgentManager,
    reviewerSession,
    resolverContextInput,
    promptSuffix,
    debaters: debaters ?? [],
    callContext: effectiveCallContext,
  };

  // Stateless fallback kind: map resolver.type only (ignores explicit selector and dialogue-verdict elevation)
  const resolverTypeMappedKind = pickBaseSelectorKind(stageConfig);

  // Preserve the legacy dialogue fallback only for dialogue selection. Explicit
  // non-dialogue selector failures should surface to the caller.
  if (kind === "dialogue-verdict") {
    try {
      const result = await resolveSelector(kind)(selectorCtx);
      return {
        outcome: result.outcome,
        resolverCostUsd: result.resolverCostUsd,
        output: result.output,
        findings: result.findings,
        dialogueResult: result.dialogueResult,
      };
    } catch (err) {
      logger?.warn("debate", "dialogue-verdict selector failed, falling back to stateless", {
        storyId,
        error: err instanceof Error ? err.message : String(err),
      });
      const fallbackResult = await resolveSelector(resolverTypeMappedKind)(selectorCtx);
      return {
        outcome: fallbackResult.outcome,
        resolverCostUsd: fallbackResult.resolverCostUsd,
        output: fallbackResult.output,
        findings: fallbackResult.findings,
        dialogueResult: fallbackResult.dialogueResult,
      };
    }
  }

  const result = await resolveSelector(kind)(selectorCtx);
  return {
    outcome: result.outcome,
    resolverCostUsd: result.resolverCostUsd,
    output: result.output,
    findings: result.findings,
    dialogueResult: result.dialogueResult,
  };
}
