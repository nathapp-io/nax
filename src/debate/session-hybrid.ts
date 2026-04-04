/**
 * session-hybrid.ts
 *
 * runHybrid() implementation for hybrid-mode debate sessions.
 * Proposal round runs all debaters in parallel via allSettledBounded.
 * The rebuttal loop is implemented in US-004-B.
 */

import type { NaxConfig } from "../config";
import { allSettledBounded } from "./concurrency";
import { buildRebuttalContext } from "./prompts";
import {
  type ResolveOutcome,
  type ResolvedDebater,
  type SuccessfulProposal,
  _debateSessionDeps,
  buildFailedResult,
  resolveOutcome,
} from "./session-helpers";
import { closeStatefulSession, runStatefulTurn } from "./session-stateful";
import type { DebateResult, DebateStageConfig, Rebuttal } from "./types";

export interface HybridCtx {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: NaxConfig | undefined;
  readonly workdir: string;
  readonly featureName: string;
  readonly timeoutSeconds: number;
}

/**
 * Run a hybrid-mode debate session.
 *
 * Proposal phase: all debaters run in parallel via allSettledBounded with
 * sessionRole 'debate-hybrid-{debaterIndex}' and keepSessionOpen: true.
 * If fewer than 2 proposals succeed, returns the single-agent fallback result.
 * The rebuttal loop is a stub (TODO: implement in US-004-B).
 *
 * @param ctx    - Hybrid session context
 * @param prompt - The debate prompt
 */
export async function runHybrid(ctx: HybridCtx, prompt: string): Promise<DebateResult> {
  const logger = _debateSessionDeps.getSafeLogger();
  const config = ctx.stageConfig;
  const debaters = config.debaters ?? [];
  let totalCostUsd = 0;

  // Resolve adapters via shared helper — skip unavailable agents
  const resolved: ResolvedDebater[] = [];
  for (const debater of debaters) {
    const adapter = _debateSessionDeps.getAgent(debater.agent, ctx.config);
    if (!adapter) {
      logger?.warn("debate", `Agent '${debater.agent}' not found — skipping debater`);
      continue;
    }
    resolved.push({ debater, adapter });
  }

  // Proposal round — bounded parallel, sessionRole 'debate-hybrid-{debaterIndex}'
  const debate = ctx.config?.debate;
  const concurrencyLimit = debate?.maxConcurrentDebaters ?? 2;

  const proposalSettled = await allSettledBounded(
    resolved.map(
      ({ debater, adapter }, debaterIdx) =>
        () =>
          runStatefulTurn(ctx, adapter, debater, prompt, `debate-hybrid-${debaterIdx}`, true),
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

  // Fewer than 2 succeeded — single-agent fallback for resiliency
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

    // 0 succeeded — retry with first resolved adapter
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
          "debate-hybrid-fallback",
          false,
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
      } catch {
        // Retry also failed — fall through to failed result
      }
    }

    return buildFailedResult(ctx.storyId, ctx.stage, config, totalCostUsd);
  }

  // Collect proposal outputs ready for resolve()
  const proposalOutputs = successfulProposals.map((s) => s.output);
  const proposalList = successfulProposals.map((s) => ({ debater: s.debater, output: s.output }));

  // Rebuttal loop — sequential per round, per debater
  const rebuttals: Rebuttal[] = [];
  try {
    for (let round = 1; round <= config.rounds; round++) {
      const priorRebuttals = rebuttals.filter((r) => r.round < round).map((r) => r.output);

      for (let debaterIdx = 0; debaterIdx < successfulProposals.length; debaterIdx++) {
        const proposal = successfulProposals[debaterIdx];
        const sessionRole = `debate-hybrid-${debaterIdx}`;

        logger?.info("debate:rebuttal-start", "debate:rebuttal-start", {
          storyId: ctx.storyId,
          round,
          debaterIndex: debaterIdx,
        });

        const rebuttalPrompt = buildRebuttalContext(prompt, proposalList, priorRebuttals, debaterIdx);

        try {
          const turnResult = await runStatefulTurn(
            ctx,
            proposal.adapter,
            proposal.debater,
            rebuttalPrompt,
            sessionRole,
            true,
          );
          totalCostUsd += turnResult.cost;
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
    for (let debaterIdx = 0; debaterIdx < successfulProposals.length; debaterIdx++) {
      const proposal = successfulProposals[debaterIdx];
      const sessionRole = `debate-hybrid-${debaterIdx}`;
      try {
        const closeCost = await closeStatefulSession(ctx, proposal.adapter, proposal.debater, sessionRole);
        totalCostUsd += closeCost;
      } catch {
        // Ignore close errors
      }
    }
  }

  const critiqueOutputs = rebuttals.map((r) => r.output);

  const resolveResult: ResolveOutcome = await resolveOutcome(
    proposalOutputs,
    critiqueOutputs,
    ctx.stageConfig,
    ctx.config,
    ctx.storyId,
    ctx.timeoutSeconds * 1000,
  );
  totalCostUsd += resolveResult.resolverCostUsd;

  return {
    storyId: ctx.storyId,
    stage: ctx.stage,
    // In hybrid mode, 2+ proposals succeeded — the debate ran successfully.
    // Resolver provides cost; pass/fail is determined by proposal success.
    outcome: "passed",
    rounds: config.rounds,
    debaters: successfulProposals.map((s) => s.debater.agent),
    resolverType: config.resolver.type,
    proposals: proposalList,
    rebuttals,
    totalCostUsd,
  };
}
