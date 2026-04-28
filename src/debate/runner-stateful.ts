/**
 * runner-stateful.ts
 *
 * runStateful(), runStatefulTurn() implementations for DebateRunner.
 */

import type { IAgentManager } from "../agents";
import type { ModelDef } from "../config";
import type { NaxConfig } from "../config";
import { DebatePromptBuilder } from "../prompts";
import { allSettledBounded } from "./concurrency";
import { buildDebaterLabel, resolvePersonas } from "./personas";
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
import type { DebateResult, DebateStageConfig, Debater } from "./types";

interface StatefulCtx {
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
  readonly signal?: AbortSignal;
}

export async function runStatefulTurn(
  ctx: StatefulCtx,
  agentManager: IAgentManager,
  agentName: string,
  debater: Debater,
  prompt: string,
  handle: import("../agents/types").SessionHandle,
): Promise<SuccessfulProposal> {
  const pipelineStage = pipelineStageForDebate(ctx.stage);

  const turnResult = await agentManager.runAsSession(agentName, handle, prompt, {
    storyId: ctx.storyId,
    pipelineStage,
  });

  return {
    debater,
    agentName,
    output: turnResult.output,
    cost: turnResult.estimatedCostUsd ?? 0,
    handle,
  };
}

export async function runStateful(ctx: StatefulCtx, prompt: string): Promise<DebateResult> {
  const logger = _debateSessionDeps.getSafeLogger();
  const config = ctx.stageConfig;
  const personaStage: "plan" | "review" = ctx.stage === "plan" ? "plan" : "review";
  const rawDebaters = config.debaters ?? [];
  const debaters = resolvePersonas(rawDebaters, personaStage, config.autoPersona ?? false);
  let totalCostUsd = 0;
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

  logger?.info("debate", "debate:start", {
    storyId: ctx.storyId,
    stage: ctx.stage,
    debaters: resolved.map((r) => r.debater.agent),
  });

  const debate = ctx.config?.debate;
  const concurrencyLimit = debate?.maxConcurrentDebaters ?? 2;
  const proposalBuilder = new DebatePromptBuilder(
    { taskContext: prompt, outputFormat: "", stage: ctx.stage },
    { debaters: resolved.map((r) => r.debater), sessionMode: "stateful" },
  );

  // Pre-open one session per resolved debater
  const openHandles: Array<import("../agents/types").SessionHandle | null> = [];
  const sessionManager = ctx.sessionManager;

  try {
    for (let i = 0; i < resolved.length; i++) {
      const { debater, agentName } = resolved[i];
      const roleKey = `debate-${ctx.stage}-${i}` as import("../runtime/session-role").SessionRole;
      if (sessionManager) {
        const modelTier = modelTierFromDebater(debater);
        const modelDef: ModelDef = resolveModelDefForDebater(debater, modelTier, ctx.config);
        const name = sessionManager.nameFor({
          workdir: ctx.workdir,
          featureName: ctx.featureName,
          storyId: ctx.storyId,
          role: roleKey,
        });
        const handle = await sessionManager.openSession(name, {
          agentName,
          role: roleKey,
          workdir: ctx.workdir,
          pipelineStage: pipelineStageForDebate(ctx.stage),
          modelDef,
          timeoutSeconds: ctx.timeoutSeconds,
          featureName: ctx.featureName,
          storyId: ctx.storyId,
          signal: ctx.signal,
        });
        openHandles.push(handle);
      } else {
        openHandles.push(null);
      }
    }

    // Proposal round
    const proposalSettled = await allSettledBounded(
      resolved.map(({ debater, agentName }, debaterIdx) => () => {
        const handle = openHandles[debaterIdx];
        if (!handle) {
          return Promise.reject(new Error(`No session handle for debater ${debaterIdx}`));
        }
        return runStatefulTurn(
          ctx,
          agentManager,
          agentName,
          debater,
          proposalBuilder.buildProposalPrompt(debaterIdx),
          handle,
        );
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
        logger?.info("debate", "debate:result", {
          storyId: ctx.storyId,
          stage: ctx.stage,
          outcome: "passed",
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

      // 0 succeeded — retry with first adapter (uses existing open handle)
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
            logger?.info("debate", "debate:result", {
              storyId: ctx.storyId,
              stage: ctx.stage,
              outcome: "passed",
            });
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
          // Retry also failed — fall through to failed result.
        }
      }

      logger?.warn("debate", "debate:fallback", {
        storyId: ctx.storyId,
        stage: ctx.stage,
        reason: "fewer than 2 proposal rounds succeeded",
      });
      return buildFailedResult(ctx.storyId, ctx.stage, config, totalCostUsd);
    }

    for (let i = 0; i < successfulProposals.length; i++) {
      const s = successfulProposals[i];
      logger?.info("debate", "debate:proposal", {
        storyId: ctx.storyId,
        stage: ctx.stage,
        debaterIndex: i,
        agent: s.debater.agent,
      });
    }

    // Critique round (when rounds > 1)
    let critiqueOutputs: string[] = [];
    if (config.rounds > 1) {
      const proposals = successfulProposals.map((s) => ({ debater: s.debater, output: s.output }));
      const critiqueBuilder = new DebatePromptBuilder(
        { taskContext: prompt, outputFormat: "", stage: ctx.stage },
        { debaters: proposals.map((p) => p.debater), sessionMode: ctx.stageConfig.sessionMode ?? "one-shot" },
      );
      const critiqueSettled = await allSettledBounded(
        successfulProposals.map((proposal, successfulIdx) => () => {
          if (!proposal.handle) {
            return Promise.reject(new Error("No handle on successful proposal for critique round"));
          }
          return runStatefulTurn(
            ctx,
            agentManager,
            proposal.agentName,
            proposal.debater,
            critiqueBuilder.buildCritiquePrompt(successfulIdx, proposals),
            proposal.handle,
          );
        }),
        concurrencyLimit,
      );

      for (const r of critiqueSettled) {
        if (r.status === "fulfilled") {
          totalCostUsd += r.value.cost;
        }
      }

      critiqueOutputs = critiqueSettled
        .filter((r): r is PromiseFulfilledResult<SuccessfulProposal> => r.status === "fulfilled")
        .map((r) => r.value.output);
    }

    // Resolve outcome
    const proposalOutputs = successfulProposals.map((s) => s.output);
    const fullResolverContext = ctx.resolverContextInput
      ? {
          ...ctx.resolverContextInput,
          labeledProposals: successfulProposals.map((s) => ({
            debater: buildDebaterLabel(s.debater),
            output: s.output,
          })),
        }
      : undefined;
    const outcome: ResolveOutcome = await resolveOutcome(
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
    totalCostUsd += outcome.resolverCostUsd;

    const proposals = successfulProposals.map((s) => ({
      debater: s.debater,
      output: s.output,
    }));

    logger?.info("debate", "debate:result", {
      storyId: ctx.storyId,
      stage: ctx.stage,
      outcome: outcome.outcome,
    });
    return {
      storyId: ctx.storyId,
      stage: ctx.stage,
      outcome: outcome.outcome,
      rounds: config.rounds,
      debaters: successfulProposals.map((s) => s.debater.agent),
      resolverType: config.resolver.type,
      proposals,
      totalCostUsd,
    };
  } finally {
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
