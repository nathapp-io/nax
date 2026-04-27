/**
 * ThreeSessionRunner — TDD three-session strategy (test-writer → implementer
 * → verifier). Thin adapter over runThreeSessionTddFromCtx, returning
 * StoryRunOutcome that execution.ts reads for branch decisions.
 *
 * Every TDD session goes through SessionManager.runInSession (via
 * runTddSession's sessionBinding path), so state transitions (#589) and
 * tokenUsage propagation (#590) happen automatically for each role.
 */

import type { AgentAdapter } from "../agents";
import type { AgentResult } from "../agents/types";
import type { PipelineContext } from "../pipeline/types";
import type { SessionRunnerContext, StoryRunOutcome } from "../session/session-runner";
import { runThreeSessionTddFromCtx } from "./orchestrator-ctx";
import type { FailureCategory, ThreeSessionTddResult } from "./types";

export interface ThreeSessionRunnerContext extends SessionRunnerContext {
  /** Full PipelineContext — the TDD orchestrator assembles per-role context bundles from it. */
  pipelineContext: PipelineContext;
  /** Primary agent adapter — used across all three roles. */
  agent: AgentAdapter;
  /** Dry-run mode skips actual agent invocations. */
  dryRun?: boolean;
  /** Lite mode skips test-writer isolation. */
  lite?: boolean;
}

/**
 * Extended StoryRunOutcome for TDD — surfaces fields that the pipeline needs
 * for branch decisions (human review, failure category, full-suite gate,
 * lite flag).
 */
export interface ThreeSessionStoryRunOutcome extends StoryRunOutcome {
  needsHumanReview: boolean;
  reviewReason?: string;
  failureCategory?: FailureCategory;
  fullSuiteGatePassed?: boolean;
  lite: boolean;
}

export class ThreeSessionRunner {
  readonly name = "three-session-tdd";

  async run(context: ThreeSessionRunnerContext): Promise<ThreeSessionStoryRunOutcome> {
    const { pipelineContext, agent, dryRun = false, lite = false } = context;

    const tddResult: ThreeSessionTddResult = await runThreeSessionTddFromCtx(pipelineContext, {
      agent,
      dryRun,
      lite,
    });

    // Synthesize a primaryResult so downstream pipeline stages (auto-commit,
    // merge-conflict detection, escalation) can treat the TDD outcome like
    // a single AgentResult. Output and stderr are left empty — TDD decisions
    // flow through tddResult fields (needsHumanReview, failureCategory).
    const primaryResult: AgentResult = {
      success: tddResult.success,
      estimatedCost: tddResult.totalCost,
      rateLimited: false,
      output: "",
      exitCode: tddResult.success ? 0 : 1,
      durationMs: tddResult.totalDurationMs ?? 0,
      ...(tddResult.totalTokenUsage && { tokenUsage: tddResult.totalTokenUsage }),
    };

    return {
      success: tddResult.success,
      primaryResult,
      totalCost: tddResult.totalCost,
      totalTokenUsage: tddResult.totalTokenUsage
        ? {
            inputTokens: tddResult.totalTokenUsage.inputTokens,
            outputTokens: tddResult.totalTokenUsage.outputTokens,
            ...(tddResult.totalTokenUsage.cacheReadInputTokens !== undefined && {
              cacheReadInputTokens: tddResult.totalTokenUsage.cacheReadInputTokens,
            }),
            ...(tddResult.totalTokenUsage.cacheCreationInputTokens !== undefined && {
              cacheCreationInputTokens: tddResult.totalTokenUsage.cacheCreationInputTokens,
            }),
          }
        : undefined,
      // TDD does not go through cross-agent fallback.
      fallbacks: [],
      needsHumanReview: tddResult.needsHumanReview,
      reviewReason: tddResult.reviewReason,
      failureCategory: tddResult.failureCategory,
      fullSuiteGatePassed: tddResult.fullSuiteGatePassed,
      lite: tddResult.lite,
    };
  }
}
