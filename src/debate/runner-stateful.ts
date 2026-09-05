import { NaxError } from "../errors";
import { type DebateStatefulInput, statefulDebaterOp } from "../operations/debate-stateful";
import type { CallContext } from "../operations/types";
import { DebatePromptBuilder } from "../prompts";
import type { DispatchContext } from "../runtime/dispatch-context";
import type { SessionRole } from "../session/types";
import { allSettledBounded } from "./concurrency";
import { resolvePersonas } from "./personas";
import {
  _statefulDeps,
  buildRebuttalPromptBuilder,
  createDebaterCallContext,
  resolveStatefulSignal,
  runZeroSuccessFallback,
} from "./runner-stateful-helpers";
import { _debateSessionDeps, buildFailedResult, type ResolveOutcome, resolveOutcome } from "./session-helpers";
import type { DebateResult, DebateStageConfig, Proposal } from "./types";

const DEFAULT_MAX_CONCURRENT_DEBATERS = 2;

interface StatefulCtx extends DispatchContext {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: import("../config/selectors").DebateConfig;
  readonly workdir: string;
  readonly featureName: string;
  readonly timeoutSeconds: number;
  readonly callContext: CallContext;
  readonly resolverCallContext?: CallContext;
}

export async function runStateful(ctx: StatefulCtx, prompt: string): Promise<DebateResult> {
  const logger = _debateSessionDeps.getSafeLogger();
  const personaStage: "plan" | "review" = ctx.stage === "plan" ? "plan" : "review";
  const shouldRunRebuttal = ctx.stageConfig.rounds > 1;
  const debaters = resolvePersonas(ctx.stageConfig.debaters ?? [], personaStage, ctx.stageConfig.autoPersona ?? false);
  const resolved = debaters.flatMap((debater) =>
    ctx.agentManager.getAgent(debater.agent) ? [{ debater, agentName: debater.agent }] : [],
  );

  for (const debater of debaters) {
    if (!ctx.agentManager.getAgent(debater.agent)) {
      logger?.warn("debate", `Agent '${debater.agent}' not found — skipping debater`, { storyId: ctx.storyId });
    }
  }

  logger?.info("debate", "debate:start", {
    storyId: ctx.storyId,
    stage: ctx.stage,
    debaters: resolved.map((entry) => entry.debater.agent),
  });

  const concurrencyLimit =
    ctx.callContext.runtime.configLoader.current().debate?.maxConcurrentDebaters ?? DEFAULT_MAX_CONCURRENT_DEBATERS;
  const proposalBuilder = new DebatePromptBuilder(
    { taskContext: prompt, outputFormat: "", stage: ctx.stage },
    { debaters: resolved.map((entry) => entry.debater), sessionMode: "stateful" },
  );
  const rebuttalBuilder = buildRebuttalPromptBuilder(
    ctx.stage,
    prompt,
    resolved.map((entry) => entry.debater),
  );

  const signal = resolveStatefulSignal(ctx);
  const noopBuildRebutPrompt = (): string => "";
  const debaterRole = (index: number) => `debate-${ctx.stage}-${index}` as SessionRole;
  const debaterCallContext = (agentName: string, index: number): CallContext => ({
    ...createDebaterCallContext(ctx, agentName),
    sessionOverride: { role: debaterRole(index) },
    scopeId: ctx.callContext.scopeId,
  });
  const throwIfAborted = (): void => {
    if (signal.aborted) {
      throw new NaxError("[debate] Stateful debate aborted", "CALL_OP_ABORTED", { storyId: ctx.storyId });
    }
  };

  // One barrier array shared by every debater in this round, sized to the
  // participant count — each debater resolves its OWN slot by `index` (BUG-12:
  // a fresh 1-element array per debater meant every debater but #0 indexed past
  // the end and threw inside hopBody, which allSettledBounded then dropped
  // silently, leaving only debater 0's proposal to ever succeed).
  const proposalBarriers = resolved.map(() => Promise.withResolvers<string>());

  const proposalSettled = await allSettledBounded(
    resolved.map(
      ({ debater, agentName }, index) =>
        () =>
          _statefulDeps
            .callOp(debaterCallContext(agentName, index), statefulDebaterOp, {
              debater,
              index,
              proposePrompt: proposalBuilder.buildProposalPrompt(index),
              buildRebutPrompt: noopBuildRebutPrompt,
              proposalBarriers,
              signal,
              storyId: ctx.storyId,
              timeoutSeconds: ctx.timeoutSeconds,
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

  for (let index = 0; index < successfulProposals.length; index++) {
    logger?.info("debate", "debate:proposal", {
      storyId: ctx.storyId,
      stage: ctx.stage,
      debaterIndex: index,
      agent: successfulProposals[index].debater.agent,
    });
  }

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
        totalCostUsd: 0,
      };
    }

    logger?.warn("debate", "debate:fallback", {
      storyId: ctx.storyId,
      stage: ctx.stage,
      reason: "all debaters failed — retrying with first adapter",
    });

    const fallback = await runZeroSuccessFallback(ctx, prompt, resolved[0]);
    if (fallback) {
      return {
        storyId: ctx.storyId,
        stage: ctx.stage,
        outcome: "passed",
        rounds: 1,
        debaters: [fallback.debater.agent],
        resolverType: ctx.stageConfig.resolver.type,
        proposals: [{ debater: fallback.debater, output: fallback.output }],
        totalCostUsd: 0,
      };
    }

    logger?.warn("debate", "debate:fallback", {
      storyId: ctx.storyId,
      stage: ctx.stage,
      reason: "fewer than 2 proposal rounds succeeded",
    });
    return buildFailedResult(ctx.storyId, ctx.stage, ctx.stageConfig, 0);
  }

  // Same sizing fix as the proposal round above — one shared array, sized to
  // this round's participant count (survivors of the proposal round), not a
  // fresh 1-element array per debater.
  const rebuttalRoundBarriers = successfulProposals.map(() => Promise.withResolvers<string>());

  const rebuttals = shouldRunRebuttal
    ? (
        await allSettledBounded(
          successfulProposals.map(
            (proposal, index) => () =>
              _statefulDeps
                .callOp(debaterCallContext(proposal.agentName, proposal.resolvedIndex), statefulDebaterOp, {
                  debater: proposal.debater,
                  index,
                  proposePrompt: rebuttalBuilder.buildCritiquePrompt(
                    index,
                    successfulProposals.map((entry) => ({
                      debater: entry.debater,
                      output: entry.output,
                    })),
                  ),
                  buildRebutPrompt: noopBuildRebutPrompt,
                  proposalBarriers: rebuttalRoundBarriers,
                  signal,
                  storyId: ctx.storyId,
                  timeoutSeconds: ctx.timeoutSeconds,
                  skipRebuttal: true,
                } satisfies DebateStatefulInput)
                .then((result) => ({ ...result, resolvedIndex: proposal.resolvedIndex })),
          ),
          concurrencyLimit,
        )
      ).flatMap((result) =>
        result.status === "fulfilled" && result.value.success
          ? [{ debater: resolved[result.value.resolvedIndex].debater, round: 1, output: result.value.rebut }]
          : [],
      )
    : [];
  throwIfAborted();
  const proposalOutputs = successfulProposals.map((proposal) => proposal.output);
  const outcome: ResolveOutcome = await resolveOutcome(
    proposalOutputs,
    rebuttals.map((rebuttal) => rebuttal.output),
    ctx.stageConfig,
    ctx.config,
    { ...ctx.callContext, scopeId: ctx.resolverCallContext?.scopeId ?? ctx.callContext.scopeId },
    ctx.storyId,
    ctx.timeoutSeconds * 1000,
    ctx.workdir,
    ctx.featureName,
    undefined,
    successfulProposals.map((proposal) => proposal.debater),
    ctx.agentManager,
  );

  logger?.info("debate", "debate:result", {
    storyId: ctx.storyId,
    stage: ctx.stage,
    outcome: outcome.outcome,
  });

  const proposals: Proposal[] = successfulProposals.map((proposal) => ({
    debater: proposal.debater,
    output: proposal.output,
  }));

  return {
    storyId: ctx.storyId,
    stage: ctx.stage,
    outcome: outcome.outcome,
    rounds: ctx.stageConfig.rounds,
    debaters: successfulProposals.map((proposal) => proposal.debater.agent),
    resolverType: ctx.stageConfig.resolver.type,
    proposals,
    rebuttals,
    totalCostUsd: 0,
  };
}
