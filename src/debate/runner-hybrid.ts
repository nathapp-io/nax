/**
 * runner-hybrid.ts
 *
 * runHybrid() implementation for DebateRunner — callOp/barrier pattern.
 */

import type { DebateConfig } from "../config/selectors";
import { NaxError } from "../errors";
import * as callModule from "../operations/call";
import { type DebateHybridInput, hybridDebaterOp } from "../operations/debate-hybrid";
import type { CallContext } from "../operations/types";
import { DebatePromptBuilder } from "../prompts";
import type { DispatchContext } from "../runtime/dispatch-context";
import type { SessionRole } from "../session/types";
import { allSettledBounded } from "./concurrency";
import { buildDebaterLabel, resolvePersonas } from "./personas";
import { createDebaterCallContext, resolveStatefulSignal } from "./runner-stateful-helpers";
import {
  type ResolveOutcome,
  type ResolvedDebater,
  type ResolverContextInput,
  _debateSessionDeps,
  buildFailedResult,
  resolveOutcome,
} from "./session-helpers";
import type { DebateResult, DebateStageConfig, Proposal, Rebuttal } from "./types";

export interface HybridCtx extends DispatchContext {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: DebateConfig;
  readonly workdir: string;
  readonly featureName: string;
  readonly timeoutSeconds: number;
  readonly callContext: CallContext;
  readonly reviewerSession?: import("../review/dialogue").ReviewerSession;
  readonly resolverContextInput?: ResolverContextInput;
}

export async function runHybrid(ctx: HybridCtx, prompt: string): Promise<DebateResult> {
  const logger = _debateSessionDeps.getSafeLogger();
  const personaStage: "plan" | "review" = ctx.stage === "plan" ? "plan" : "review";
  const rawDebaters = ctx.stageConfig.debaters ?? [];
  const debaters = resolvePersonas(rawDebaters, personaStage, ctx.stageConfig.autoPersona ?? false);
  const agentManager = ctx.agentManager;

  const resolved: ResolvedDebater[] = [];
  for (const debater of debaters) {
    if (!agentManager.getAgent(debater.agent)) {
      logger?.warn("debate", `Agent '${debater.agent}' not found — skipping debater`);
      continue;
    }
    resolved.push({ debater, agentName: debater.agent });
  }

  // Hybrid mode requires all debaters to run concurrently (shared barriers would deadlock
  // if any debater can't start because all slots are occupied by waiting peers).
  const concurrencyLimit = resolved.length;
  const rounds = ctx.stageConfig.rounds;

  const proposalBuilder = new DebatePromptBuilder(
    { taskContext: prompt, outputFormat: "", stage: ctx.stage },
    { debaters: resolved.map((e) => e.debater), sessionMode: "stateful" },
  );
  const rebutBuilder = new DebatePromptBuilder(
    { taskContext: prompt, outputFormat: "", stage: ctx.stage },
    { debaters: resolved.map((e) => e.debater), sessionMode: "stateful" },
  );

  const debaterScope = ctx.runtime.costAggregator.openScope();
  const resolverScope = ctx.runtime.costAggregator.openScope();
  try {
    const signal = resolveStatefulSignal(ctx);

    // Shared barriers — one slot per debater, one round array per rebuttal round.
    const proposalBarriers: PromiseWithResolvers<string>[] = resolved.map(() => Promise.withResolvers<string>());
    const rebutBarriers: PromiseWithResolvers<string>[][] = Array.from({ length: rounds }, () =>
      resolved.map(() => Promise.withResolvers<string>()),
    );

    const debaterRole = (index: number) => `debate-hybrid-${index}` as SessionRole;
    const debaterCallContext = (agentName: string, index: number): CallContext => ({
      ...createDebaterCallContext(ctx, agentName),
      sessionOverride: { role: debaterRole(index) },
      scopeId: debaterScope.scopeId,
    });

    const proposalListFromOutputs = (peerOutputs: string[]): Proposal[] =>
      peerOutputs.map((output, i) => ({ debater: resolved[i]?.debater ?? resolved[0].debater, output }));

    const priorRoundsToRebuttals = (priorRoundOutputs: string[][]): Rebuttal[] =>
      priorRoundOutputs.flatMap((roundOutputs, roundIndex) =>
        roundOutputs.map((output, debaterIndex) => ({
          debater: resolved[debaterIndex]?.debater ?? resolved[0].debater,
          round: roundIndex + 1,
          output,
        })),
      );

    const rejectDebaterBarriers = (index: number, reason: Error): void => {
      proposalBarriers[index].reject(reason);
      for (const roundBarriers of rebutBarriers) {
        roundBarriers[index].reject(reason);
      }
    };

    // Launch N parallel callOp invocations using hybridDebaterOp.
    // The op's hopBody handles the per-round barrier loop internally.
    // On failure, reject this debater's barriers immediately so waiting peers don't deadlock.
    const settled = await allSettledBounded(
      resolved.map(({ debater, agentName }, index) => async () => {
        try {
          const result = await callModule.callOp(debaterCallContext(agentName, index), hybridDebaterOp, {
            debater,
            index,
            proposePrompt: proposalBuilder.buildProposalPrompt(index),
            buildRebutPrompt: (_round, peerOutputs, priorRoundOutputs) =>
              rebutBuilder.buildRebuttalPrompt(
                index,
                proposalListFromOutputs(peerOutputs),
                priorRoundsToRebuttals(priorRoundOutputs),
              ),
            proposalBarriers,
            rebutBarriers,
            signal,
            storyId: ctx.storyId,
            rounds,
          } satisfies DebateHybridInput);
          // If the hop returned a failure result without resolving its barriers (e.g. runAsSession
          // threw inside hopBody, which buildHopCallback caught and turned into a failed AgentResult),
          // reject any unresolved barriers now so waiting peers don't deadlock.
          if (!result.success) {
            rejectDebaterBarriers(
              index,
              new NaxError("[debate] debater returned failure", "CALL_OP_ABORTED", { storyId: ctx.storyId }),
            );
          }
          return result;
        } catch (err) {
          rejectDebaterBarriers(
            index,
            err instanceof Error
              ? err
              : new NaxError("[debate] debater failed", "CALL_OP_ABORTED", { storyId: ctx.storyId }),
          );
          throw err;
        }
      }),
      concurrencyLimit,
    );

    // Reject all unresolved peer barriers so no surviving debater deadlocks waiting.
    const barrierFailureReason = new NaxError("[debate] peer failed", "CALL_OP_ABORTED", {
      storyId: ctx.storyId,
    });
    for (const barrier of proposalBarriers) {
      Promise.resolve(barrier.promise).catch(() => {});
      barrier.reject(barrierFailureReason);
    }
    for (const roundBarriers of rebutBarriers) {
      for (const barrier of roundBarriers) {
        Promise.resolve(barrier.promise).catch(() => {});
        barrier.reject(barrierFailureReason);
      }
    }

    if (signal.aborted) {
      throw new NaxError("[debate] Hybrid debate aborted", "CALL_OP_ABORTED", { storyId: ctx.storyId });
    }

    const successfulResults = settled.flatMap((result, index) =>
      result.status === "fulfilled" && result.value.success
        ? [
            {
              debater: resolved[index].debater,
              agentName: resolved[index].agentName,
              output: result.value.rebut,
              cost: 0,
              resolvedIndex: index,
            },
          ]
        : [],
    );

    if (successfulResults.length < 2) {
      if (successfulResults.length === 1) {
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
          debaters: [successfulResults[0].debater.agent],
          resolverType: ctx.stageConfig.resolver.type,
          proposals: [{ debater: successfulResults[0].debater, output: successfulResults[0].output }],
          totalCostUsd: debaterScope.snapshot().totalCostUsd + resolverScope.snapshot().totalCostUsd,
        };
      }

      return buildFailedResult(
        ctx.storyId,
        ctx.stage,
        ctx.stageConfig,
        debaterScope.snapshot().totalCostUsd + resolverScope.snapshot().totalCostUsd,
      );
    }

    // Build rebuttal list from rebutBarriers — collect settled barrier outputs per round.
    const rebuttals: Rebuttal[] = [];
    for (let round = 0; round < rounds; round++) {
      const roundBarriersSettled = await Promise.allSettled(rebutBarriers[round].map((b) => b.promise));
      for (let i = 0; i < resolved.length; i++) {
        const res = roundBarriersSettled[i];
        if (res?.status === "fulfilled") {
          rebuttals.push({ debater: resolved[i].debater, round: round + 1, output: res.value });
        }
      }
    }

    const proposalOutputs = successfulResults.map((p) => p.output);
    const resolveResult: ResolveOutcome = await resolveOutcome(
      proposalOutputs,
      rebuttals.map((r) => r.output),
      ctx.stageConfig,
      ctx.config,
      { ...ctx.callContext, scopeId: resolverScope.scopeId },
      ctx.storyId,
      ctx.timeoutSeconds * 1000,
      ctx.workdir,
      ctx.featureName,
      ctx.reviewerSession,
      ctx.resolverContextInput
        ? {
            ...ctx.resolverContextInput,
            labeledProposals: successfulResults.map((p) => ({
              debater: buildDebaterLabel(p.debater),
              output: p.output,
            })),
          }
        : undefined,
      undefined,
      successfulResults.map((p) => p.debater),
      agentManager,
    );

    return {
      storyId: ctx.storyId,
      stage: ctx.stage,
      outcome: resolveResult.outcome,
      rounds,
      debaters: successfulResults.map((p) => p.debater.agent),
      resolverType: ctx.stageConfig.resolver.type,
      proposals: successfulResults.map((proposal) => ({ debater: proposal.debater, output: proposal.output })),
      rebuttals,
      totalCostUsd: debaterScope.snapshot().totalCostUsd + resolverScope.snapshot().totalCostUsd,
    };
  } finally {
    debaterScope.close();
    resolverScope.close();
  }
}
