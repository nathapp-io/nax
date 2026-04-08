/**
 * session-one-shot.ts
 *
 * Extracted runOneShot() implementation for DebateSession.
 */

import type { NaxConfig } from "../config";
import { allSettledBounded } from "./concurrency";
import { buildCritiquePrompt } from "./prompts";
import {
  type ResolveOutcome,
  type ResolvedDebater,
  type ResolverContextInput,
  type SuccessfulProposal,
  _debateSessionDeps,
  buildFailedResult,
  modelTierFromDebater,
  resolveDebaterModel,
  resolveOutcome,
  runComplete,
} from "./session-helpers";
import type { DebateResult, DebateStageConfig } from "./types";

interface OneShotCtx {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: NaxConfig;
  readonly timeoutMs: number;
  readonly workdir?: string;
  readonly featureName?: string;
  readonly reviewerSession?: import("../review/dialogue").ReviewerSession;
  readonly resolverContextInput?: ResolverContextInput;
}

export async function runOneShot(ctx: OneShotCtx, prompt: string): Promise<DebateResult> {
  const logger = _debateSessionDeps.getSafeLogger();
  const config = ctx.stageConfig;
  const debaters = config.debaters ?? [];
  let totalCostUsd = 0;

  // Step 1: Resolve adapters — skip unavailable agents
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

  // Step 2: Proposal round — bounded parallel
  const debate = ctx.config?.debate;
  const concurrencyLimit = debate?.maxConcurrentDebaters ?? 2;
  const proposalSettled = await allSettledBounded(
    resolved.map(
      ({ debater, adapter }, i) =>
        () =>
          runComplete(
            adapter,
            prompt,
            {
              model: resolveDebaterModel(debater, ctx.config),
              featureName: ctx.stage,
              config: ctx.config,
              storyId: ctx.storyId,
              sessionRole: `debate-proposal-${i}`,
              timeoutMs: ctx.timeoutMs,
            },
            modelTierFromDebater(debater),
          ).then((result) => ({ debater, adapter, output: result.output, cost: result.costUsd })),
    ),
    concurrencyLimit,
  );

  const successful: SuccessfulProposal[] = proposalSettled
    .filter((r): r is PromiseFulfilledResult<SuccessfulProposal> => r.status === "fulfilled")
    .map((r) => r.value);

  // Accumulate proposal round costs
  for (const r of proposalSettled) {
    if (r.status === "fulfilled") {
      totalCostUsd += r.value.cost;
    }
  }

  for (let i = 0; i < successful.length; i++) {
    logger?.info("debate", "debate:proposal", {
      storyId: ctx.storyId,
      stage: ctx.stage,
      debaterIndex: i,
      agent: successful[i].debater.agent,
      model: resolveDebaterModel(successful[i].debater, ctx.config),
    });
  }

  // Step 3: Fewer than 2 succeeded — single-agent fallback
  if (successful.length < 2) {
    if (successful.length === 1) {
      logger?.warn("debate", "debate:fallback", {
        storyId: ctx.storyId,
        stage: ctx.stage,
        reason: "only 1 debater succeeded",
      });
      const solo = successful[0];
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

    // All debaters failed — attempt fresh complete() on first resolved adapter (AC4)
    if (resolved.length > 0) {
      const { adapter: fallbackAdapter, debater: fallbackDebater } = resolved[0];
      logger?.warn("debate", "debate:fallback", {
        storyId: ctx.storyId,
        stage: ctx.stage,
        reason: "all debaters failed — retrying with first adapter",
      });
      try {
        const fallbackResult = await runComplete(
          fallbackAdapter,
          prompt,
          {
            model: resolveDebaterModel(fallbackDebater, ctx.config),
            featureName: ctx.stage,
            config: ctx.config,
            storyId: ctx.storyId,
            sessionRole: "debate-fallback",
            timeoutMs: ctx.timeoutMs,
          },
          modelTierFromDebater(fallbackDebater),
        );
        totalCostUsd += fallbackResult.costUsd;
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
        // Fallback also failed — fall through to buildFailedResult
      }
    }

    return buildFailedResult(ctx.storyId, ctx.stage, config, totalCostUsd);
  }

  // Step 4: Critique rounds (when rounds > 1)
  let critiqueOutputs: string[] = [];
  if (config.rounds > 1) {
    const proposalOutputs = successful.map((p) => p.output);
    const critiqueSettled = await allSettledBounded(
      successful.map(
        ({ debater, adapter }, i) =>
          () =>
            runComplete(
              adapter,
              buildCritiquePrompt(prompt, proposalOutputs, i),
              {
                model: resolveDebaterModel(debater, ctx.config),
                featureName: ctx.stage,
                config: ctx.config,
                storyId: ctx.storyId,
                sessionRole: `debate-critique-${i}`,
                timeoutMs: ctx.timeoutMs,
              },
              modelTierFromDebater(debater),
            ),
      ),
      concurrencyLimit,
    );
    for (const r of critiqueSettled) {
      if (r.status === "fulfilled") {
        totalCostUsd += r.value.costUsd;
      }
    }
    critiqueOutputs = critiqueSettled
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof runComplete>>> => r.status === "fulfilled")
      .map((r) => r.value.output);
  }

  // Step 5: Resolve outcome
  const proposalOutputs = successful.map((p) => p.output);
  const fullResolverContext = ctx.resolverContextInput
    ? {
        ...ctx.resolverContextInput,
        labeledProposals: successful.map((p) => ({ debater: p.debater.agent, output: p.output })),
      }
    : undefined;
  const outcome: ResolveOutcome = await resolveOutcome(
    proposalOutputs,
    critiqueOutputs,
    ctx.stageConfig,
    ctx.config,
    ctx.storyId,
    ctx.timeoutMs,
    ctx.workdir,
    ctx.featureName,
    ctx.reviewerSession,
    fullResolverContext,
  );
  totalCostUsd += outcome.resolverCostUsd;

  const proposals = successful.map((p) => ({
    debater: p.debater,
    output: p.output,
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
    debaters: successful.map((p) => p.debater.agent),
    resolverType: config.resolver.type,
    proposals,
    totalCostUsd,
  };
}
