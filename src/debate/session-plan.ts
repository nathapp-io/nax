/**
 * session-plan.ts
 *
 * Extracted runPlan() implementation for DebateSession.
 */

import { join } from "node:path";
import type { NaxConfig } from "../config";
import type { ModelTier } from "../config/schema-types";
import { allSettledBounded } from "./concurrency";
import {
  type ResolveOutcome,
  type ResolvedDebater,
  type SuccessfulProposal,
  _debateSessionDeps,
  buildFailedResult,
  resolveOutcome,
} from "./session-helpers";
import type { DebateResult, DebateStageConfig } from "./types";

interface PlanCtx {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: NaxConfig;
}

export async function runPlan(
  ctx: PlanCtx,
  basePrompt: string,
  opts: {
    workdir: string;
    feature: string;
    outputDir: string;
    timeoutSeconds?: number;
    dangerouslySkipPermissions?: boolean;
    maxInteractionTurns?: number;
  },
): Promise<DebateResult> {
  const logger = _debateSessionDeps.getSafeLogger();
  const config = ctx.stageConfig;
  const debaters = config.debaters ?? [];
  const totalCostUsd = 0;

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

  // Run plan() bounded parallel
  const debate = ctx.config?.debate;
  const concurrencyLimit = debate?.maxConcurrentDebaters ?? 2;
  const settled = await allSettledBounded(
    resolved.map(({ debater, adapter }, i) => async () => {
      const tempOutputPath = join(opts.outputDir, `prd-debate-${i}.json`);
      const debaterPrompt = `${basePrompt}\n\nWrite the PRD JSON directly to this file path: ${tempOutputPath}\nDo NOT output the JSON to the conversation. Write the file, then reply with a brief confirmation.`;

      await adapter.plan({
        prompt: debaterPrompt,
        workdir: opts.workdir,
        interactive: false,
        timeoutSeconds: opts.timeoutSeconds,
        config: ctx.config,
        modelTier: (debater.model ?? "balanced") as ModelTier,
        dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
        maxInteractionTurns: opts.maxInteractionTurns,
        featureName: opts.feature,
        storyId: ctx.storyId,
        sessionRole: `plan-${i}`,
      });

      const output = await _debateSessionDeps.readFile(tempOutputPath);
      return { debater, adapter, output, cost: 0 };
    }),
    concurrencyLimit,
  );

  const successful: SuccessfulProposal[] = [];
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    if (res.status === "fulfilled") {
      successful.push(res.value);
    } else {
      const { debater } = resolved[i];
      logger?.warn("debate", "debate:debater-failed", {
        storyId: ctx.storyId,
        stage: ctx.stage,
        debaterIndex: i,
        agent: debater.agent,
        error: res.reason instanceof Error ? res.reason.message : String(res.reason),
      });
    }
  }

  for (let i = 0; i < successful.length; i++) {
    logger?.info("debate", "debate:proposal", {
      storyId: ctx.storyId,
      stage: ctx.stage,
      debaterIndex: i,
      agent: successful[i].debater.agent,
    });
  }

  if (successful.length === 0) {
    logger?.warn("debate", "debate:fallback", {
      storyId: ctx.storyId,
      stage: ctx.stage,
      reason: "all plan debaters failed",
    });
    return buildFailedResult(ctx.storyId, ctx.stage, config, totalCostUsd);
  }

  // Single success — use directly (no resolver needed)
  if (successful.length === 1) {
    logger?.warn("debate", "debate:fallback", {
      storyId: ctx.storyId,
      stage: ctx.stage,
      reason: "only 1 plan debater succeeded — using as solo",
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
      debaters: [successful[0].debater.agent],
      resolverType: config.resolver.type,
      proposals: [{ debater: successful[0].debater, output: successful[0].output }],
      output: successful[0].output,
      totalCostUsd,
    };
  }

  // Multiple proposals — resolve to pick the winning PRD
  const proposalOutputs = successful.map((p) => p.output);
  // timeoutMs not tracked per-plan — use 0 as sentinel for resolver calls
  const outcome: ResolveOutcome = await resolveOutcome(
    proposalOutputs,
    [],
    ctx.stageConfig,
    ctx.config,
    ctx.storyId,
    0,
  );

  // Winning output: synthesis resolver returns combined PRD via synthesisResolver output;
  // for majority/custom, use the first proposal as the baseline winner.
  const winningOutput = successful[0].output;

  const proposals = successful.map((p) => ({ debater: p.debater, output: p.output }));

  logger?.info("debate", "debate:result", {
    storyId: ctx.storyId,
    stage: ctx.stage,
    outcome,
  });
  return {
    storyId: ctx.storyId,
    stage: ctx.stage,
    outcome: outcome.outcome,
    rounds: 1,
    debaters: successful.map((p) => p.debater.agent),
    resolverType: config.resolver.type,
    proposals,
    output: winningOutput,
    totalCostUsd,
  };
}
