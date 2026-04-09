/**
 * session-stateful.ts
 *
 * Extracted runStateful(), runStatefulTurn(), and closeStatefulSession()
 * implementations for DebateSession.
 */

import type { AgentAdapter } from "../agents/types";
import type { ModelDef, ModelTier } from "../config";
import type { NaxConfig } from "../config";
import { resolvePermissions } from "../config/permissions";
import { allSettledBounded } from "./concurrency";
import { resolvePersonas } from "./personas";
import { DebatePromptBuilder } from "./prompt-builder";
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
  readonly reviewerSession?: import("../review/dialogue").ReviewerSession;
  readonly resolverContextInput?: ResolverContextInput;
}

export async function runStatefulTurn(
  ctx: StatefulCtx,
  adapter: AgentAdapter,
  debater: Debater,
  prompt: string,
  roleKey: string,
  keepSessionOpen: boolean,
): Promise<SuccessfulProposal> {
  const modelTier = modelTierFromDebater(debater);
  const modelDef: ModelDef = resolveModelDefForDebater(debater, modelTier, ctx.config);
  const pipelineStage = pipelineStageForDebate(ctx.stage);

  const runResult = await adapter.run({
    prompt,
    workdir: ctx.workdir,
    modelTier,
    modelDef,
    timeoutSeconds: ctx.timeoutSeconds,
    dangerouslySkipPermissions: resolvePermissions(ctx.config, pipelineStage).skipPermissions,
    pipelineStage,
    config: ctx.config,
    featureName: ctx.featureName,
    storyId: ctx.storyId,
    sessionRole: roleKey,
    maxInteractionTurns: ctx.config?.agent?.maxInteractionTurns,
    keepSessionOpen,
  });

  if (!runResult.success) {
    throw new Error(runResult.output || `Stateful debate turn failed for ${debater.agent}`);
  }

  return {
    debater,
    adapter,
    output: runResult.output,
    cost: runResult.estimatedCost,
    roleKey,
  };
}

export async function closeStatefulSession(
  ctx: StatefulCtx,
  adapter: AgentAdapter,
  debater: Debater,
  roleKey: string,
): Promise<number> {
  const modelTier: ModelTier = modelTierFromDebater(debater);
  const modelDef: ModelDef = resolveModelDefForDebater(debater, modelTier, ctx.config);
  const pipelineStage = pipelineStageForDebate(ctx.stage);

  const runResult = await adapter.run({
    prompt: "Close this debate session.",
    workdir: ctx.workdir,
    modelTier,
    modelDef,
    timeoutSeconds: ctx.timeoutSeconds,
    dangerouslySkipPermissions: resolvePermissions(ctx.config, pipelineStage).skipPermissions,
    pipelineStage,
    config: ctx.config,
    featureName: ctx.featureName,
    storyId: ctx.storyId,
    sessionRole: roleKey,
    maxInteractionTurns: ctx.config?.agent?.maxInteractionTurns,
    keepSessionOpen: false,
  });

  return runResult.success ? runResult.estimatedCost : 0;
}

export async function runStateful(ctx: StatefulCtx, prompt: string): Promise<DebateResult> {
  const logger = _debateSessionDeps.getSafeLogger();
  const config = ctx.stageConfig;
  const personaStage: "plan" | "review" = ctx.stage === "plan" ? "plan" : "review";
  const rawDebaters = config.debaters ?? [];
  const debaters = resolvePersonas(rawDebaters, personaStage, config.autoPersona ?? false);
  let totalCostUsd = 0;

  // Resolve adapters — skip unavailable agents
  const resolved: ResolvedDebater[] = [];
  for (const debater of debaters) {
    const adapter = _debateSessionDeps.getAgent(debater.agent, ctx.config);
    if (!adapter) {
      logger?.warn("debate", `Agent '${debater.agent}' not found — skipping debater`);
      continue;
    }
    resolved.push({ debater, adapter });
  }

  logger?.info("debate", "debate:start", {
    storyId: ctx.storyId,
    stage: ctx.stage,
    debaters: resolved.map((r) => r.debater.agent),
  });

  // Proposal round — bounded parallel
  const debate = ctx.config?.debate;
  const concurrencyLimit = debate?.maxConcurrentDebaters ?? 2;
  const proposalSettled = await allSettledBounded(
    resolved.map(
      ({ debater, adapter }, debaterIdx) =>
        () =>
          runStatefulTurn(ctx, adapter, debater, prompt, `debate-${ctx.stage}-${debaterIdx}`, config.rounds > 1),
    ),
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

  // Fewer than 2 succeeded — single-agent fallback for resiliency.
  if (successfulProposals.length < 2) {
    if (successfulProposals.length === 1) {
      const solo = successfulProposals[0];
      if (config.rounds > 1 && solo.roleKey) {
        totalCostUsd += await closeStatefulSession(ctx, solo.adapter, solo.debater, solo.roleKey);
      }
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

    if (resolved.length > 0) {
      const { adapter: fallbackAdapter, debater: fallbackDebater } = resolved[0];
      logger?.warn("debate", "debate:fallback", {
        storyId: ctx.storyId,
        stage: ctx.stage,
        reason: "all debaters failed — retrying with first adapter",
      });
      try {
        const fallbackResult = await runStatefulTurn(
          ctx,
          fallbackAdapter,
          fallbackDebater,
          prompt,
          `debate-${ctx.stage}-fallback`,
          false,
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
  // In stateful mode, send only OTHER debaters' proposals — session retains own history.
  let critiqueOutputs: string[] = [];
  if (config.rounds > 1) {
    const proposals = successfulProposals.map((s) => ({ debater: s.debater, output: s.output }));
    const critiqueBuilder = new DebatePromptBuilder(
      { taskContext: prompt, outputFormat: "", stage: ctx.stage },
      { debaters: proposals.map((p) => p.debater), sessionMode: ctx.stageConfig.sessionMode ?? "one-shot" },
    );
    const critiqueSettled = await allSettledBounded(
      successfulProposals.map(
        (proposal, successfulIdx) => () =>
          runStatefulTurn(
            ctx,
            proposal.adapter,
            proposal.debater,
            critiqueBuilder.buildCritiquePrompt(successfulIdx, proposals),
            proposal.roleKey ?? `debate-${ctx.stage}-${successfulIdx}`,
            false,
          ),
      ),
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
        labeledProposals: successfulProposals.map((s) => ({ debater: s.debater.agent, output: s.output })),
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
}
