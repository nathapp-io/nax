/**
 * runner-hybrid.ts
 *
 * runHybrid() implementation for DebateRunner — callOp/barrier pattern.
 */

import type { DebateConfig } from "../config/selectors";
import { NaxError } from "../errors";
import * as callModule from "../operations/call";
import { type DebateStatefulInput, statefulDebaterOp } from "../operations/debate-stateful";
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
import type { DebateResult, DebateStageConfig, Rebuttal } from "./types";

const DEFAULT_MAX_CONCURRENT_DEBATERS = 2;

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

  const concurrencyLimit = ctx.config?.debate?.maxConcurrentDebaters ?? DEFAULT_MAX_CONCURRENT_DEBATERS;

  const proposalBuilder = new DebatePromptBuilder(
    { taskContext: prompt, outputFormat: "", stage: ctx.stage },
    { debaters: resolved.map((e) => e.debater), sessionMode: "stateful" },
  );

  const signal = resolveStatefulSignal(ctx);
  let totalDebaterCostUsd = 0;
  const noopBuildRebutPrompt = (): string => "";
  const localProposalBarrier = () => [Promise.withResolvers<string>()];
  const debaterRole = (index: number) => `debate-hybrid-${index}` as SessionRole;
  const debaterCallContext = (agentName: string, index: number): CallContext => ({
    ...createDebaterCallContext(ctx, agentName),
    sessionOverride: { role: debaterRole(index) },
    onCostAccumulated: (cost: number) => {
      totalDebaterCostUsd += cost;
    },
  });
  const throwIfAborted = (): void => {
    if (signal.aborted) {
      throw new NaxError("[debate] Hybrid debate aborted", "CALL_OP_ABORTED", { storyId: ctx.storyId });
    }
  };

  const proposalSettled = await allSettledBounded(
    resolved.map(
      ({ debater, agentName }, index) =>
        () =>
          callModule
            .callOp(debaterCallContext(agentName, index), statefulDebaterOp, {
              debater,
              index,
              proposePrompt: proposalBuilder.buildProposalPrompt(index),
              buildRebutPrompt: noopBuildRebutPrompt,
              proposalBarriers: localProposalBarrier(),
              signal,
              storyId: ctx.storyId,
              skipRebuttal: true,
            } satisfies DebateStatefulInput)
            .then((result) => ({ ...result, resolvedIndex: index })),
    ),
    concurrencyLimit,
  );
  throwIfAborted();

  const successfulProposals = proposalSettled.flatMap((result) =>
    result.status === "fulfilled" && result.value.success
      ? [
          {
            debater: resolved[result.value.resolvedIndex].debater,
            agentName: resolved[result.value.resolvedIndex].agentName,
            output: result.value.rebut,
            cost: 0,
            resolvedIndex: result.value.resolvedIndex,
          },
        ]
      : [],
  );

  if (successfulProposals.length < 2) {
    if (successfulProposals.length === 1) {
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
        debaters: [successfulProposals[0].debater.agent],
        resolverType: ctx.stageConfig.resolver.type,
        proposals: [{ debater: successfulProposals[0].debater, output: successfulProposals[0].output }],
        totalCostUsd: totalDebaterCostUsd,
      };
    }

    return buildFailedResult(ctx.storyId, ctx.stage, ctx.stageConfig, totalDebaterCostUsd);
  }

  const proposalList = successfulProposals.map((proposal) => ({ debater: proposal.debater, output: proposal.output }));
  const rebuttals: Rebuttal[] = [];
  for (let round = 1; round <= ctx.stageConfig.rounds; round++) {
    const priorRebuttals = rebuttals.filter((entry) => entry.round < round);
    const roundSettled = await allSettledBounded(
      successfulProposals.map(
        (proposal, index) => () =>
          callModule
            .callOp(debaterCallContext(proposal.agentName, proposal.resolvedIndex), statefulDebaterOp, {
              debater: proposal.debater,
              index,
              proposePrompt: proposalBuilder.buildRebuttalPrompt(index, proposalList, priorRebuttals),
              buildRebutPrompt: noopBuildRebutPrompt,
              proposalBarriers: localProposalBarrier(),
              signal,
              storyId: ctx.storyId,
              skipRebuttal: true,
            } satisfies DebateStatefulInput)
            .then((result) => ({ ...result, resolvedIndex: proposal.resolvedIndex })),
      ),
      concurrencyLimit,
    );
    throwIfAborted();

    rebuttals.push(
      ...roundSettled.flatMap((result) =>
        result.status === "fulfilled" && result.value.success
          ? [{ debater: resolved[result.value.resolvedIndex].debater, round, output: result.value.rebut }]
          : [],
      ),
    );
  }

  const proposalOutputs = successfulProposals.map((p) => p.output);
  const resolveResult: ResolveOutcome = await resolveOutcome(
    proposalOutputs,
    rebuttals.map((r) => r.output),
    ctx.stageConfig,
    ctx.config,
    ctx.callContext,
    ctx.storyId,
    ctx.timeoutSeconds * 1000,
    ctx.workdir,
    ctx.featureName,
    ctx.reviewerSession,
    ctx.resolverContextInput
      ? {
          ...ctx.resolverContextInput,
          labeledProposals: successfulProposals.map((p) => ({
            debater: buildDebaterLabel(p.debater),
            output: p.output,
          })),
        }
      : undefined,
    undefined,
    successfulProposals.map((p) => p.debater),
    agentManager,
  );

  return {
    storyId: ctx.storyId,
    stage: ctx.stage,
    outcome: resolveResult.outcome,
    rounds: ctx.stageConfig.rounds,
    debaters: successfulProposals.map((p) => p.debater.agent),
    resolverType: ctx.stageConfig.resolver.type,
    proposals: successfulProposals.map((proposal) => ({ debater: proposal.debater, output: proposal.output })),
    rebuttals,
    totalCostUsd: totalDebaterCostUsd + resolveResult.resolverCostUsd,
  };
}
