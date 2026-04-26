/**
 * session-hybrid.ts
 *
 * runHybrid() implementation for hybrid-mode debate sessions.
 */

import type { IAgentManager } from "../agents";
import type { NaxConfig } from "../config";
import { DebatePromptBuilder } from "../prompts";
import { allSettledBounded } from "./concurrency";
import { buildDebaterLabel, resolvePersonas } from "./personas";
import { runStatefulTurn } from "./runner-stateful";
import {
  type ResolveOutcome,
  type ResolvedDebater,
  type ResolverContextInput,
  type SuccessfulProposal,
  _debateSessionDeps,
  buildFailedResult,
  modelTierFromDebater,
  pipelineStageForDebate,
  resolveModelDefForDebater,
  resolveOutcome,
} from "./session-helpers";
import type { DebateResult, DebateStageConfig, Rebuttal } from "./types";

/** Result of the rebuttal loop — rebuttals collected + accumulated cost. */
export interface RebuttalLoopResult {
  rebuttals: Rebuttal[];
  costUsd: number;
}

export interface HybridCtx {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: NaxConfig;
  readonly workdir: string;
  readonly featureName: string;
  readonly timeoutSeconds: number;
  readonly agentManager?: IAgentManager;
  readonly sessionManager?: import("../session/types").ISessionManager;
  readonly reviewerSession?: import("../review/dialogue").ReviewerSession;
  readonly resolverContextInput?: ResolverContextInput;
}

/**
 * Run the sequential rebuttal loop across all debaters for N rounds.
 * Uses proposal.handle when present (hybrid mode); opens fresh sessions otherwise (plan-mode).
 * Closes only internally-opened handles in finally.
 */
export async function runRebuttalLoop(
  ctx: HybridCtx,
  proposals: SuccessfulProposal[],
  builder: DebatePromptBuilder,
  sessionRolePrefix: string,
): Promise<RebuttalLoopResult> {
  const logger = _debateSessionDeps.getSafeLogger();
  const config = ctx.stageConfig;
  const rebuttals: Rebuttal[] = [];
  let costUsd = 0;
  const agentManager = ctx.agentManager ?? _debateSessionDeps.agentManager;
  if (!agentManager) {
    return { rebuttals: [], costUsd: 0 };
  }

  const proposalList = proposals.map((s) => ({ debater: s.debater, output: s.output }));
  const sessionManager = ctx.sessionManager;

  // Resolve effective handles — use caller-supplied handles when present (hybrid mode),
  // open fresh sessions otherwise (plan-mode rebuttals where proposals came from planAs).
  const internalHandles: Array<import("../agents/types").SessionHandle | null> = [];
  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i];
    const sessionRole = `${sessionRolePrefix}-${i}`;
    if (proposal.handle) {
      internalHandles.push(null); // Caller owns this handle; we do not close it
    } else if (sessionManager) {
      const modelTier = modelTierFromDebater(proposal.debater);
      const modelDef = resolveModelDefForDebater(proposal.debater, modelTier, ctx.config);
      const name = sessionManager.nameFor({
        workdir: ctx.workdir,
        featureName: ctx.featureName,
        storyId: ctx.storyId,
        role: sessionRole,
      });
      const handle = await sessionManager.openSession(name, {
        agentName: proposal.agentName,
        role: sessionRole,
        workdir: ctx.workdir,
        pipelineStage: pipelineStageForDebate(ctx.stage),
        modelDef,
        timeoutSeconds: ctx.timeoutSeconds,
        featureName: ctx.featureName,
        storyId: ctx.storyId,
      });
      internalHandles.push(handle);
    } else {
      internalHandles.push(null);
    }
  }

  try {
    for (let round = 1; round <= config.rounds; round++) {
      const priorRebuttals = rebuttals.filter((r) => r.round < round);

      for (let debaterIdx = 0; debaterIdx < proposals.length; debaterIdx++) {
        const proposal = proposals[debaterIdx];
        const effectiveHandle = proposal.handle ?? internalHandles[debaterIdx];
        if (!effectiveHandle) continue;

        logger?.info("debate:rebuttal-start", "debate:rebuttal-start", {
          storyId: ctx.storyId,
          round,
          debaterIndex: debaterIdx,
        });

        const rebuttalPrompt = builder.buildRebuttalPrompt(debaterIdx, proposalList, priorRebuttals);

        try {
          const turnResult = await agentManager.runAsSession(proposal.agentName, effectiveHandle, rebuttalPrompt, {
            storyId: ctx.storyId,
            pipelineStage: pipelineStageForDebate(ctx.stage),
          });
          costUsd += turnResult.cost?.total ?? 0;
          rebuttals.push({ debater: proposal.debater, round, output: turnResult.output });
        } catch (err) {
          logger?.warn("debate", "debate:rebuttal-failed", {
            storyId: ctx.storyId,
            round,
            debaterIndex: debaterIdx,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  } finally {
    // Close only internally-opened handles (caller-supplied handles are closed by the caller)
    for (const handle of internalHandles) {
      if (handle && sessionManager) {
        try {
          await sessionManager.closeSession(handle);
        } catch {
          // Ignore close errors
        }
      }
    }
  }

  return { rebuttals, costUsd };
}

export async function runHybrid(ctx: HybridCtx, prompt: string): Promise<DebateResult> {
  const logger = _debateSessionDeps.getSafeLogger();
  const config = ctx.stageConfig;
  const personaStage: "plan" | "review" = ctx.stage === "plan" ? "plan" : "review";
  const rawDebaters = config.debaters ?? [];
  const debaters = resolvePersonas(rawDebaters, personaStage, config.autoPersona ?? false);
  let totalCostUsd = 0;
  const sessionManager = ctx.sessionManager;

  const agentManager = ctx.agentManager ?? _debateSessionDeps.agentManager;
  if (!agentManager) {
    return buildFailedResult(ctx.storyId, ctx.stage, config, 0);
  }

  const resolved: ResolvedDebater[] = [];
  for (const debater of debaters) {
    if (!agentManager.getAgent(debater.agent)) {
      logger?.warn("debate", `Agent '${debater.agent}' not found — skipping debater`);
      continue;
    }
    resolved.push({ debater, agentName: debater.agent });
  }

  const debate = ctx.config?.debate;
  const concurrencyLimit = debate?.maxConcurrentDebaters ?? 2;

  // Pre-open one session per resolved debater
  const openHandles: Array<import("../agents/types").SessionHandle | null> = [];

  try {
    for (let i = 0; i < resolved.length; i++) {
      const { debater, agentName } = resolved[i];
      const sessionRole = `debate-hybrid-${i}`;
      if (sessionManager) {
        const modelTier = modelTierFromDebater(debater);
        const modelDef = resolveModelDefForDebater(debater, modelTier, ctx.config);
        const name = sessionManager.nameFor({
          workdir: ctx.workdir,
          featureName: ctx.featureName,
          storyId: ctx.storyId,
          role: sessionRole,
        });
        const handle = await sessionManager.openSession(name, {
          agentName,
          role: sessionRole,
          workdir: ctx.workdir,
          pipelineStage: pipelineStageForDebate(ctx.stage),
          modelDef,
          timeoutSeconds: ctx.timeoutSeconds,
          featureName: ctx.featureName,
          storyId: ctx.storyId,
        });
        openHandles.push(handle);
      } else {
        openHandles.push(null);
      }
    }

    const proposalSettled = await allSettledBounded(
      resolved.map(({ debater, agentName }, debaterIdx) => () => {
        const handle = openHandles[debaterIdx];
        if (!handle) {
          return Promise.reject(new Error(`No session handle for hybrid debater ${debaterIdx}`));
        }
        return runStatefulTurn(ctx, agentManager, agentName, debater, prompt, handle);
      }),
      concurrencyLimit,
    );

    const successfulProposals: SuccessfulProposal[] = proposalSettled
      .filter((r): r is PromiseFulfilledResult<SuccessfulProposal> => r.status === "fulfilled")
      .map((r) => r.value);

    for (const r of proposalSettled) {
      if (r.status === "fulfilled") {
        totalCostUsd += r.value.cost;
      }
    }

    // Fewer than 2 succeeded — single-agent fallback
    if (successfulProposals.length < 2) {
      if (successfulProposals.length === 1) {
        const solo = successfulProposals[0];
        logger?.warn("debate", "debate:fallback", {
          storyId: ctx.storyId,
          stage: ctx.stage,
          reason: "only 1 debater succeeded",
        });
        return {
          storyId: ctx.storyId,
          stage: ctx.stage,
          outcome: "passed",
          rounds: 1,
          debaters: [solo.debater.agent],
          resolverType: config.resolver.type,
          proposals: [{ debater: solo.debater, output: solo.output }],
          totalCostUsd,
        };
      }

      // 0 succeeded — retry with first resolved agent (use existing open handle)
      if (resolved.length > 0) {
        const { agentName: fallbackAgentName, debater: fallbackDebater } = resolved[0];
        const fallbackHandle = openHandles[0];
        logger?.warn("debate", "debate:fallback", {
          storyId: ctx.storyId,
          stage: ctx.stage,
          reason: "all debaters failed — retrying with first adapter",
        });
        try {
          if (fallbackHandle) {
            const fallbackResult = await runStatefulTurn(
              ctx,
              agentManager,
              fallbackAgentName,
              fallbackDebater,
              prompt,
              fallbackHandle,
            );
            totalCostUsd += fallbackResult.cost;
            return {
              storyId: ctx.storyId,
              stage: ctx.stage,
              outcome: "passed",
              rounds: 1,
              debaters: [fallbackDebater.agent],
              resolverType: config.resolver.type,
              proposals: [{ debater: fallbackDebater, output: fallbackResult.output }],
              totalCostUsd,
            };
          }
        } catch {
          // Retry also failed — fall through to failed result
        }
      }

      return buildFailedResult(ctx.storyId, ctx.stage, config, totalCostUsd);
    }

    const proposalOutputs = successfulProposals.map((s) => s.output);
    const proposalList = successfulProposals.map((s) => ({ debater: s.debater, output: s.output }));

    // Rebuttal loop — successfulProposals carry handles, so runRebuttalLoop uses them directly
    const rebuttalBuilder = new DebatePromptBuilder(
      { taskContext: prompt, outputFormat: "", stage: ctx.stage },
      { debaters: successfulProposals.map((s) => s.debater), sessionMode: "stateful" },
    );
    const { rebuttals, costUsd: rebuttalCost } = await runRebuttalLoop(
      ctx,
      successfulProposals,
      rebuttalBuilder,
      "debate-hybrid",
    );
    totalCostUsd += rebuttalCost;

    const critiqueOutputs = rebuttals.map((r) => r.output);

    const fullResolverContext = ctx.resolverContextInput
      ? {
          ...ctx.resolverContextInput,
          labeledProposals: successfulProposals.map((s) => ({
            debater: buildDebaterLabel(s.debater),
            output: s.output,
          })),
        }
      : undefined;
    const resolveResult: ResolveOutcome = await resolveOutcome(
      proposalOutputs,
      critiqueOutputs,
      ctx.stageConfig,
      ctx.config,
      ctx.storyId,
      ctx.timeoutSeconds * 1000,
      ctx.workdir,
      ctx.featureName,
      ctx.reviewerSession,
      fullResolverContext,
      /* promptSuffix */ undefined,
      successfulProposals.map((s) => s.debater),
      agentManager,
    );
    totalCostUsd += resolveResult.resolverCostUsd;

    return {
      storyId: ctx.storyId,
      stage: ctx.stage,
      outcome: "passed",
      rounds: config.rounds,
      debaters: successfulProposals.map((s) => s.debater.agent),
      resolverType: config.resolver.type,
      proposals: proposalList,
      rebuttals,
      totalCostUsd,
    };
  } finally {
    // Close all pre-opened handles
    for (const handle of openHandles) {
      if (handle && sessionManager) {
        try {
          await sessionManager.closeSession(handle);
        } catch {
          // Ignore close errors
        }
      }
    }
  }
}
