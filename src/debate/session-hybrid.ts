/**
 * session-hybrid.ts
 *
 * runHybrid() implementation for hybrid-mode debate sessions.
 * Proposal round runs all debaters in parallel via allSettledBounded.
 * The rebuttal loop is implemented in US-004-B.
 */

import type { NaxConfig } from "../config";
import { allSettledBounded } from "./concurrency";
import { buildDebaterLabel, resolvePersonas } from "./personas";
import { DebatePromptBuilder } from "./prompt-builder";
import {
  type ResolveOutcome,
  type ResolvedDebater,
  type ResolverContextInput,
  type SuccessfulProposal,
  _debateSessionDeps,
  buildFailedResult,
  resolveOutcome,
} from "./session-helpers";
import { closeStatefulSession, runStatefulTurn } from "./session-stateful";
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
  readonly reviewerSession?: import("../review/dialogue").ReviewerSession;
  readonly resolverContextInput?: ResolverContextInput;
}

/**
 * Run the sequential rebuttal loop across all debaters for N rounds,
 * then close all sessions in a finally block.
 *
 * SSOT for hybrid-mode rebuttal logic — called by runHybrid() and runPlan().
 *
 * @param ctx                - Session context (must include workdir/featureName/timeoutSeconds)
 * @param proposals          - Successful proposals with adapter references
 * @param builder            - Prompt builder (constructed by caller with successful debaters)
 * @param sessionRolePrefix  - Prefix for session roles (e.g. "debate-hybrid", "plan-hybrid")
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

  const proposalList = proposals.map((s) => ({ debater: s.debater, output: s.output }));

  try {
    for (let round = 1; round <= config.rounds; round++) {
      const priorRebuttals = rebuttals.filter((r) => r.round < round);

      for (let debaterIdx = 0; debaterIdx < proposals.length; debaterIdx++) {
        const proposal = proposals[debaterIdx];
        const sessionRole = `${sessionRolePrefix}-${debaterIdx}`;

        logger?.info("debate:rebuttal-start", "debate:rebuttal-start", {
          storyId: ctx.storyId,
          round,
          debaterIndex: debaterIdx,
        });

        const rebuttalPrompt = builder.buildRebuttalPrompt(debaterIdx, proposalList, priorRebuttals);

        try {
          const turnResult = await runStatefulTurn(
            ctx,
            proposal.adapter,
            proposal.debater,
            rebuttalPrompt,
            sessionRole,
            true,
          );
          costUsd += turnResult.cost;
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
    for (let debaterIdx = 0; debaterIdx < proposals.length; debaterIdx++) {
      const proposal = proposals[debaterIdx];
      const sessionRole = `${sessionRolePrefix}-${debaterIdx}`;
      try {
        const closeCost = await closeStatefulSession(ctx, proposal.adapter, proposal.debater, sessionRole);
        costUsd += closeCost;
      } catch {
        // Ignore close errors
      }
    }
  }

  return { rebuttals, costUsd };
}

/**
 * Run a hybrid-mode debate session.
 *
 * Proposal phase: all debaters run in parallel via allSettledBounded with
 * sessionRole 'debate-hybrid-{debaterIndex}' and keepSessionOpen: true.
 * If fewer than 2 proposals succeed, returns the single-agent fallback result.
 * Rebuttal loop delegates to runRebuttalLoop() (SSOT).
 *
 * @param ctx    - Hybrid session context
 * @param prompt - The debate prompt
 */
export async function runHybrid(ctx: HybridCtx, prompt: string): Promise<DebateResult> {
  const logger = _debateSessionDeps.getSafeLogger();
  const config = ctx.stageConfig;
  const personaStage: "plan" | "review" = ctx.stage === "plan" ? "plan" : "review";
  const rawDebaters = config.debaters ?? [];
  const debaters = resolvePersonas(rawDebaters, personaStage, config.autoPersona ?? false);
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

  // Rebuttal loop + session cleanup — delegated to SSOT
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
        labeledProposals: successfulProposals.map((s) => ({ debater: buildDebaterLabel(s.debater), output: s.output })),
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
