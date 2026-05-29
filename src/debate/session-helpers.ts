import type { IAgentManager } from "../agents";
import type { ModelTier } from "../config";
import { DEFAULT_CONFIG } from "../config";
import type { PipelineStage } from "../config/permissions";
import type { DebateConfig } from "../config/selectors";
import { getSafeLogger } from "../logger";
import type { CallContext } from "../operations/types";
import type { DispatchContext } from "../runtime/dispatch-context";
import type { SessionRole } from "../session/types";
import { pickSelectorKind, resolveSelector } from "./selectors";
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
  /** Synthesised output from synthesis/custom resolver — undefined for majority resolver */
  output?: string;
  /** Optional findings from selector output. */
  findings?: unknown[];
}

/** Context passed to selectors after proposals are collected. */
export interface ResolverContext {
  labeledProposals: Array<{ debater: string; output: string }>;
}

export interface DebateSessionOptions extends DispatchContext {
  storyId: string;
  stage: string;
  stageConfig: DebateStageConfig;
  config?: DebateConfig;
  workdir?: string;
  featureName?: string;
  timeoutSeconds?: number;
}

/** Injectable deps for testability */
export const _debateSessionDeps = {
  agentManager: undefined as IAgentManager | undefined,
  getSafeLogger: getSafeLogger as () => ReturnType<typeof getSafeLogger>,
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
};

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
  promptSuffix: string | undefined,
  debaters: Debater[] | undefined,
  agentManager: IAgentManager,
): Promise<ResolveOutcome> {
  const logger = _debateSessionDeps.getSafeLogger();

  const kind = pickSelectorKind(stageConfig);

  if ((kind === "majority-fail-closed" || kind === "majority-fail-open") && workdir !== undefined) {
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
    critiques: critiqueOutputs,
    workdir: workdir ?? "",
    featureName: featureName ?? "",
    timeoutMs,
    agentManager: effectiveAgentManager,
    promptSuffix,
    debaters: debaters ?? [],
    callContext: effectiveCallContext,
  };

  const result = await resolveSelector(kind)(selectorCtx);
  return {
    outcome: result.outcome,
    output: result.output,
    findings: result.findings,
  };
}
