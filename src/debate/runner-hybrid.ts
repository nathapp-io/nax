/**
 * runner-hybrid.ts
 *
 * runHybrid() implementation for DebateRunner — callOp/barrier pattern.
 */

import * as callModule from "../operations/call";
import { type DebateHybridInput, hybridDebaterOp } from "../operations/debate-hybrid";
import type { CallContext } from "../operations/types";
import { DebatePromptBuilder } from "../prompts";
import type { DispatchContext } from "../runtime/dispatch-context";
import type { SessionRole } from "../session/types";
import { buildDebaterLabel, resolvePersonas } from "./personas";
import {
  createDebaterCallContext,
  createProposalBarrier,
  rejectUnresolvedBarriers,
  resolveStatefulSignal,
  runStatefulBounded,
} from "./runner-stateful-helpers";
import type { DebateConfig } from "../config/selectors";
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

  const barrierStates = resolved.map(() => createProposalBarrier());
  const rebutBarriers: PromiseWithResolvers<string>[][] = Array.from(
    { length: ctx.stageConfig.rounds },
    () => resolved.map(() => Promise.withResolvers<string>()),
  );

  // Build proposal prompts for the build() slot — barriers are NOT pre-resolved;
  // each debater's hopBody resolves its own barrier after the proposal send.
  const proposalPrompts = resolved.map((_, i) => proposalBuilder.buildProposalPrompt(i));

  const signal = resolveStatefulSignal(ctx);
  const failureError = new Error(`[debate] Hybrid debate aborted for story ${ctx.storyId}`);
  let totalDebaterCostUsd = 0;

  const hybridSettled = await runStatefulBounded(
    resolved.map(({ debater, agentName }, index) => () => {
      const debaterCallCtx: CallContext = {
        ...createDebaterCallContext(ctx, agentName),
        sessionOverride: { role: `debate-hybrid-${index}` as SessionRole },
        onCostAccumulated: (c: number) => {
          totalDebaterCostUsd += c;
        },
      };
      return callModule
        .callOp(debaterCallCtx, hybridDebaterOp, {
          debater,
          index,
          proposePrompt: proposalPrompts[index],
          buildRebutPrompt: (_round, peerOutputs) =>
            proposalBuilder.buildRebuttalPrompt(
              index,
              peerOutputs.map((output, peerIdx) => ({
                debater: resolved[peerIdx]?.debater ?? debater,
                output,
              })),
              [],
            ),
          proposalBarriers: barrierStates.map((s) => s.barrier),
          rebutBarriers,
          signal,
          storyId: ctx.storyId,
          rounds: ctx.stageConfig.rounds,
        } satisfies DebateHybridInput)
        .then(
          (result) => {
            if (!result.success) {
              rejectUnresolvedBarriers(barrierStates, failureError);
              for (const round of rebutBarriers) {
                for (const b of round) b.reject(failureError);
              }
            }
            return result;
          },
          (error) => {
            rejectUnresolvedBarriers(barrierStates, failureError);
            for (const round of rebutBarriers) {
              for (const b of round) b.reject(failureError);
            }
            throw error;
          },
        );
    }),
    barrierStates,
    concurrencyLimit,
  );

  // Drain unsettled rebuttal barriers to prevent unhandled rejections when
  // debaters fail before resolving their rebuttal slots (e.g. rounds=1).
  for (const round of rebutBarriers) {
    for (const b of round) b.promise.catch(() => {});
  }

  // Propagate hard failures (callOp threw) rather than silently falling back.
  const firstRejected = hybridSettled.find(r => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (firstRejected) throw firstRejected.reason as Error;

  const successfulProposals = hybridSettled.flatMap((result, index) =>
    result.status === "fulfilled" && result.value.success
      ? [{ debater: resolved[index].debater, output: result.value.rebut }]
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
        proposals: [successfulProposals[0]],
        totalCostUsd: 0,
      };
    }

    return buildFailedResult(ctx.storyId, ctx.stage, ctx.stageConfig, 0);
  }

  const rebuttals: Rebuttal[] = hybridSettled.flatMap((result, index) =>
    result.status === "fulfilled" && result.value.success
      ? [{ debater: resolved[index].debater, round: ctx.stageConfig.rounds, output: result.value.rebut }]
      : [],
  );

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
    proposals: successfulProposals,
    rebuttals,
    totalCostUsd: totalDebaterCostUsd + resolveResult.resolverCostUsd,
  };
}
