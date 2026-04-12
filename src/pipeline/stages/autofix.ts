// RE-ARCH: keep
/**
 * Autofix Stage (ADR-005, Phase 2)
 *
 * Runs after a failed review stage. Attempts to fix quality issues
 * automatically before escalating:
 *
 * Phase 1 — Mechanical fix: runs lintFix / formatFix commands (if configured)
 * Phase 2 — Agent rectification: spawns an agent session with the review error
 *            output as context (reuses the pattern from rectification-loop.ts)
 *
 * Language-agnostic: uses quality.commands.lintFix / formatFix from config.
 * No hardcoded tool names.
 *
 * Enabled only when ctx.reviewResult?.passed === false AND autofix is enabled.
 *
 * Returns:
 * - `retry` fromStage:"review" — autofix resolved the failures
 * - `escalate`                 — max attempts exhausted or agent unavailable
 */

import { buildSessionName } from "../../agents/acp/adapter";
import { createAgentRegistry } from "../../agents/registry";
import { resolveModelForAgent } from "../../config";
import type { NaxConfig } from "../../config";
import { resolvePermissions } from "../../config/permissions";
import { getLogger } from "../../logger";
import { runQualityCommand } from "../../quality";
import type { ReviewCheckResult } from "../../review/types";
import {
  buildProgressivePromptPreamble,
  runSharedRectificationLoop,
} from "../../verification/shared-rectification-loop";
import { pipelineEventBus } from "../event-bus";
import type { PipelineContext, PipelineStage, StageResult } from "../types";
import { buildReviewRectificationContinuation } from "./autofix-continuation";
import { buildReviewRectificationPrompt } from "./autofix-prompts";
export { buildReviewRectificationPrompt };

const CLARIFY_REGEX = /^CLARIFY:\s*(.+)$/ms;
/** Matches the REVIEW-003 reviewer contradiction escape hatch emitted by the implementer. */
const UNRESOLVED_REGEX = /^UNRESOLVED:\s*(.+)$/ms;

export const autofixStage: PipelineStage = {
  name: "autofix",

  enabled(ctx: PipelineContext): boolean {
    if (!ctx.reviewResult) return false;
    if (ctx.reviewResult.success) return false;
    const autofixEnabled = ctx.config.quality.autofix?.enabled ?? true;
    return autofixEnabled;
  },

  skipReason(ctx: PipelineContext): string {
    if (!ctx.reviewResult || ctx.reviewResult.success) return "not needed (review passed)";
    return "disabled (autofix not enabled in config)";
  },

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();
    const { reviewResult } = ctx;

    if (!reviewResult || reviewResult.success) {
      return { action: "continue" };
    }

    // Check quality.commands first, then fall back to review.commands — users often define
    // lintFix/formatFix in review.commands alongside other review commands (lint, typecheck).
    const lintFixCmd = ctx.config.quality.commands.lintFix ?? ctx.config.review.commands.lintFix;
    const formatFixCmd = ctx.config.quality.commands.formatFix ?? ctx.config.review.commands.formatFix;

    // Effective workdir for running commands — workdir is already resolved at context creation

    // Identify which checks failed
    const failedCheckNames = new Set((reviewResult.checks ?? []).filter((c) => !c.success).map((c) => c.check));
    const hasLintFailure = failedCheckNames.has("lint");

    logger.info("autofix", "Starting autofix", {
      storyId: ctx.story.id,
      failedChecks: [...failedCheckNames],
      workdir: ctx.workdir,
    });

    // Phase 1: Mechanical fix — only for lint failures (lintFix/formatFix cannot fix typecheck errors)
    if (hasLintFailure && (lintFixCmd || formatFixCmd)) {
      if (lintFixCmd) {
        pipelineEventBus.emit({ type: "autofix:started", storyId: ctx.story.id, command: lintFixCmd });
        const lintResult = await _autofixDeps.runQualityCommand({
          commandName: "lintFix",
          command: lintFixCmd,
          workdir: ctx.workdir,
          storyId: ctx.story.id,
        });
        logger.debug("autofix", `lintFix exit=${lintResult.exitCode}`, { storyId: ctx.story.id, command: lintFixCmd });
        if (lintResult.exitCode !== 0) {
          logger.warn("autofix", "lintFix command failed — may not have fixed all issues", {
            storyId: ctx.story.id,
            exitCode: lintResult.exitCode,
          });
        }
      }

      if (formatFixCmd) {
        pipelineEventBus.emit({ type: "autofix:started", storyId: ctx.story.id, command: formatFixCmd });
        const fmtResult = await _autofixDeps.runQualityCommand({
          commandName: "formatFix",
          command: formatFixCmd,
          workdir: ctx.workdir,
          storyId: ctx.story.id,
        });
        logger.debug("autofix", `formatFix exit=${fmtResult.exitCode}`, {
          storyId: ctx.story.id,
          command: formatFixCmd,
        });
        if (fmtResult.exitCode !== 0) {
          logger.warn("autofix", "formatFix command failed — may not have fixed all issues", {
            storyId: ctx.story.id,
            exitCode: fmtResult.exitCode,
          });
        }
      }

      const recheckPassed = await _autofixDeps.recheckReview(ctx);
      pipelineEventBus.emit({ type: "autofix:completed", storyId: ctx.story.id, fixed: recheckPassed });

      if (recheckPassed) {
        // #136: Skip checks that already passed — mechanical fix only touched lint/format.
        // Semantic/debate review doesn't need to re-run after a lint-only fix.
        const passedChecks = (ctx.reviewResult?.checks ?? []).filter((c) => c.success).map((c) => c.check);
        if (passedChecks.length > 0) {
          ctx.retrySkipChecks = new Set(passedChecks);
          logger.debug("autofix", "Skipping already-passed checks on retry", {
            storyId: ctx.story.id,
            skippedChecks: passedChecks,
          });
        }
        logger.info("autofix", "Mechanical autofix succeeded — retrying review", { storyId: ctx.story.id });
        return { action: "retry", fromStage: "review" };
      }

      logger.info("autofix", "Mechanical autofix did not resolve all failures — proceeding to agent rectification", {
        storyId: ctx.story.id,
      });
    }

    // Phase 2: Agent rectification — spawn agent with review error context
    const {
      succeeded: agentFixed,
      cost: agentCost,
      unresolvedReason,
    } = await _autofixDeps.runAgentRectification(ctx, lintFixCmd, formatFixCmd, ctx.workdir);

    // REVIEW-003: Implementer signalled an unresolvable reviewer contradiction — escalate.
    if (unresolvedReason) {
      logger.warn("autofix", "Escalating due to reviewer contradiction", {
        storyId: ctx.story.id,
        unresolvedReason,
      });
      return { action: "escalate", reason: `Reviewer contradiction: ${unresolvedReason}`, cost: agentCost };
    }

    if (agentFixed) {
      if (ctx.reviewResult) ctx.reviewResult = { ...ctx.reviewResult, success: true };
      // #136: Skip checks that already passed — only re-run checks that originally failed.
      // Agent rectification fixes mechanical issues (lint/typecheck); passing checks like
      // semantic (~45s) don't need to re-run unless they were the failing check.
      const passedChecks = (ctx.reviewResult?.checks ?? []).filter((c) => c.success).map((c) => c.check);
      if (passedChecks.length > 0) {
        ctx.retrySkipChecks = new Set(passedChecks);
        logger.debug("autofix", "Skipping already-passed checks on retry", {
          storyId: ctx.story.id,
          skippedChecks: passedChecks,
        });
      }
      logger.info("autofix", "Agent rectification succeeded — retrying review", { storyId: ctx.story.id });
      return { action: "retry", fromStage: "review", cost: agentCost };
    }

    logger.warn("autofix", "Autofix exhausted — escalating", { storyId: ctx.story.id });
    return {
      action: "escalate",
      reason: "Autofix exhausted: review still failing after fix attempts",
      cost: agentCost,
    };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function recheckReview(ctx: PipelineContext): Promise<boolean> {
  // Import reviewStage lazily to avoid circular deps
  const { reviewStage } = await import("./review");
  if (!reviewStage.enabled(ctx)) return true;
  // reviewStage.execute updates ctx.reviewResult in place.
  // We cannot use result.action here because review returns "continue" for BOTH
  // pass and built-in-check-failure (to hand off to autofix). Check success directly.
  await reviewStage.execute(ctx);
  return ctx.reviewResult?.success === true;
}

function collectFailedChecks(ctx: PipelineContext): ReviewCheckResult[] {
  return (ctx.reviewResult?.checks ?? []).filter((c) => !c.success);
}

function buildAutofixEscalationPreamble(
  attempt: number,
  maxAttempts: number,
  rethinkAtAttempt?: number,
  urgencyAtAttempt?: number,
): string {
  return buildProgressivePromptPreamble({
    attempt,
    maxAttempts,
    rethinkAtAttempt,
    urgencyAtAttempt,
    stage: "autofix",
    logger: getLogger(),
    urgencySection: `## Final Autofix Attempt Before Escalation

This is attempt ${attempt}. If the review still fails after this, autofix will escalate instead of retrying.
A different approach is required. Do not repeat the same fix.

`,
    rethinkSection: `## Previous Attempt Did Not Fix the Failures

Your previous fix attempt (attempt ${attempt}) did not resolve the quality errors. Rethink your approach.

- Do not repeat the same edit pattern.
- Re-read the failing diagnostics carefully.
- Try a fundamentally different fix strategy if the earlier one did not work.

`,
  });
}

async function runAgentRectification(
  ctx: PipelineContext,
  lintFixCmd: string | undefined,
  formatFixCmd: string | undefined,
  effectiveWorkdir: string,
): Promise<{ succeeded: boolean; cost: number; unresolvedReason?: string }> {
  const logger = getLogger();
  const maxPerCycle = ctx.config.quality.autofix?.maxAttempts ?? 2;
  const maxTotal = ctx.config.quality.autofix?.maxTotalAttempts ?? 10;
  const rethinkAtAttempt = ctx.config.quality.autofix?.rethinkAtAttempt ?? 2;
  const urgencyAtAttempt = ctx.config.quality.autofix?.urgencyAtAttempt ?? 3;
  const consumed = ctx.autofixAttempt ?? 0;
  const failedChecks = collectFailedChecks(ctx);

  if (failedChecks.length === 0) {
    logger.debug("autofix", "No failed checks found — skipping agent rectification", { storyId: ctx.story.id });
    return { succeeded: false, cost: 0 };
  }

  // Global budget check — escalate if total attempts exhausted across all cycles
  if (consumed >= maxTotal) {
    logger.warn("autofix", "Global autofix budget exhausted — escalating", {
      storyId: ctx.story.id,
      totalAttempts: consumed,
      maxTotalAttempts: maxTotal,
    });
    return { succeeded: false, cost: 0 };
  }

  // Cap this cycle's attempts to not exceed global budget
  const remainingBudget = maxTotal - consumed;
  const maxAttempts = Math.min(maxPerCycle, remainingBudget);

  const agentGetFn = ctx.agentGetFn ?? ((name: string) => _autofixDeps.getAgent(name, ctx.rootConfig));
  const loopState = {
    attempt: 0,
    failedChecks,
  };
  let autofixCostAccum = 0;
  let unresolvedReason: string | undefined;

  // Session continuity: execution + review came before us, so the implementer session is open.
  const implementerSession = buildSessionName(ctx.workdir, ctx.prd.feature, ctx.story.id, "implementer");
  let sessionConfirmedOpen = true; // execution + review came before us

  const succeeded = await runSharedRectificationLoop({
    stage: "autofix",
    storyId: ctx.story.id,
    maxAttempts,
    state: loopState,
    logger,
    startMessage: "Starting agent rectification for review failures",
    startData: {
      storyId: ctx.story.id,
      failedChecks: failedChecks.map((check) => check.check),
      maxAttempts,
      totalUsed: consumed,
      maxTotalAttempts: maxTotal,
    },
    attemptMessage: (attempt) => `Agent rectification attempt ${consumed + attempt}/${maxTotal}`,
    attemptData: { storyId: ctx.story.id },
    canContinue: (state) => state.failedChecks.length > 0 && state.attempt < maxAttempts,
    buildPrompt: (attempt, state) => {
      // runSharedRectificationLoop increments attempt before calling buildPrompt,
      // so attempt=1 on the first call. Continuation mode starts from attempt=2.
      const isSessionContinuation = attempt > 1 && sessionConfirmedOpen;

      if (isSessionContinuation) {
        // Apply the same capping as buildProgressivePromptPreamble so the last attempt
        // always triggers urgency even when urgencyAtAttempt > maxAttempts.
        return buildReviewRectificationContinuation(
          state.failedChecks,
          attempt,
          Math.min(rethinkAtAttempt, maxAttempts),
          Math.min(urgencyAtAttempt, maxAttempts),
        );
      }

      let prompt = buildReviewRectificationPrompt(state.failedChecks, ctx.story);
      const escalationPreamble = buildAutofixEscalationPreamble(
        attempt,
        maxAttempts,
        rethinkAtAttempt,
        urgencyAtAttempt,
      );
      if (escalationPreamble) {
        prompt = `${escalationPreamble}${prompt}`;
      }
      return prompt;
    },
    runAttempt: async (attempt, prompt) => {
      ctx.autofixAttempt = consumed + attempt;
      const agent = agentGetFn(ctx.rootConfig.autoMode.defaultAgent);
      if (!agent) {
        logger.error("autofix", "Agent not found — cannot run agent rectification", { storyId: ctx.story.id });
        throw new Error("AUTOFIX_AGENT_NOT_FOUND");
      }

      const modelTier =
        ctx.story.routing?.modelTier ?? ctx.rootConfig.autoMode.escalation.tierOrder[0]?.tier ?? "balanced";
      const modelDef = resolveModelForAgent(
        ctx.rootConfig.models,
        ctx.routing.agent ?? ctx.rootConfig.autoMode.defaultAgent,
        modelTier,
        ctx.rootConfig.autoMode.defaultAgent,
      );
      const isLastAttempt = attempt >= maxAttempts;
      let result: Awaited<ReturnType<typeof agent.run>>;
      try {
        result = await agent.run({
          prompt,
          workdir: ctx.workdir,
          modelTier,
          modelDef,
          timeoutSeconds: ctx.config.execution.sessionTimeoutSeconds,
          dangerouslySkipPermissions: resolvePermissions(ctx.config, "rectification").skipPermissions,
          pipelineStage: "rectification",
          config: ctx.config,
          projectDir: ctx.projectDir,
          maxInteractionTurns: ctx.config.agent?.maxInteractionTurns,
          featureName: ctx.prd.feature,
          storyId: ctx.story.id,
          sessionRole: "implementer",
          acpSessionName: implementerSession,
          keepSessionOpen: !isLastAttempt,
        });
        sessionConfirmedOpen = true;
      } catch (err) {
        sessionConfirmedOpen = false; // Session state unknown — next attempt uses full prompt
        throw err;
      }

      autofixCostAccum += result.estimatedCost ?? 0;

      // REVIEW-003: Detect UNRESOLVED signal — reviewer findings contradict each other.
      // Escalate immediately rather than retrying an unresolvable conflict.
      if (result.output) {
        const unresolvedMatch = UNRESOLVED_REGEX.exec(result.output);
        if (unresolvedMatch) {
          unresolvedReason = (unresolvedMatch[1] ?? "reviewer findings contradicted each other").trim();
          logger.warn("autofix", "Implementer signalled reviewer contradiction — escalating", {
            storyId: ctx.story.id,
            unresolvedReason,
          });
          throw new Error("AUTOFIX_UNRESOLVED");
        }
      }

      // AC5/AC6/AC10: Detect CLARIFY blocks and relay to reviewerSession
      if (ctx.reviewerSession && result.output) {
        const maxClarifications = ctx.config.review?.dialogue?.maxClarificationsPerAttempt ?? 3;
        let clarifyCount = 0;
        const clarifyRegex = new RegExp(CLARIFY_REGEX.source, `${CLARIFY_REGEX.flags}g`);
        let match: RegExpExecArray | null;
        // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
        while ((match = clarifyRegex.exec(result.output)) !== null) {
          if (clarifyCount >= maxClarifications) break;
          const question = match[1]?.trim() ?? "";
          if (!question) continue;
          try {
            await ctx.reviewerSession.clarify(question);
            clarifyCount++;
          } catch (err) {
            logger.debug("autofix", "reviewerSession.clarify() failed — proceeding without clarification", {
              storyId: ctx.story.id,
            });
          }
        }
      }
    },
    checkResult: async (attempt, state) => {
      const passed = await _autofixDeps.recheckReview(ctx);
      if (passed) {
        logger.info("autofix", `[OK] Agent rectification succeeded on attempt ${attempt}`, {
          storyId: ctx.story.id,
        });
        return true;
      }

      const updatedFailed = collectFailedChecks(ctx);

      // If the agent introduced new lint/format issues, run mechanical fix before next agent attempt.
      // This avoids spending a full agent session (~45s) on errors that lintFix (~77ms) can resolve.
      const hasNewLintFailure = updatedFailed.some((c) => c.check === "lint");
      if (hasNewLintFailure && (lintFixCmd || formatFixCmd)) {
        if (lintFixCmd) {
          logger.debug("autofix", "Agent introduced lint errors — running lintFix before next attempt", {
            storyId: ctx.story.id,
          });
          pipelineEventBus.emit({ type: "autofix:started", storyId: ctx.story.id, command: lintFixCmd });
          await _autofixDeps.runQualityCommand({
            commandName: "lintFix",
            command: lintFixCmd,
            workdir: effectiveWorkdir,
            storyId: ctx.story.id,
          });
        }
        if (formatFixCmd) {
          pipelineEventBus.emit({ type: "autofix:started", storyId: ctx.story.id, command: formatFixCmd });
          await _autofixDeps.runQualityCommand({
            commandName: "formatFix",
            command: formatFixCmd,
            workdir: effectiveWorkdir,
            storyId: ctx.story.id,
          });
        }
        // Re-check after mechanical fix; if it passes, no need for another agent attempt
        const mechPassed = await _autofixDeps.recheckReview(ctx);
        pipelineEventBus.emit({ type: "autofix:completed", storyId: ctx.story.id, fixed: mechPassed });
        if (mechPassed) {
          logger.info("autofix", `[OK] Mechanical fix resolved agent-introduced lint errors on attempt ${attempt}`, {
            storyId: ctx.story.id,
          });
          return true;
        }
      }

      if (updatedFailed.length > 0) {
        state.failedChecks.splice(0, state.failedChecks.length, ...collectFailedChecks(ctx));
      }
      return false;
    },
    onAttemptFailure: (attempt) => {
      logger.warn("autofix", `Agent rectification still failing after attempt ${attempt}`, {
        storyId: ctx.story.id,
      });
    },
    onLoopEnd: (state) => {
      if (state.attempt >= maxAttempts) {
        logger.warn("autofix", "Agent rectification exhausted", { storyId: ctx.story.id });
      }
    },
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === "AUTOFIX_AGENT_NOT_FOUND") {
      return false;
    }
    if (error instanceof Error && error.message === "AUTOFIX_UNRESOLVED") {
      return false;
    }
    throw error;
  });

  return { succeeded, cost: autofixCostAccum, unresolvedReason };
}

/**
 * Injectable deps for testing.
 */
export const _autofixDeps = {
  /** Protocol-aware agent factory. Override in tests to inject a mock agent. */
  getAgent: (name: string, config: NaxConfig) => createAgentRegistry(config).getAgent(name),
  runQualityCommand,
  recheckReview,
  runAgentRectification: (
    ctx: PipelineContext,
    lintFixCmd: string | undefined,
    formatFixCmd: string | undefined,
    effectiveWorkdir: string,
  ): Promise<{ succeeded: boolean; cost: number; unresolvedReason?: string }> =>
    runAgentRectification(ctx, lintFixCmd, formatFixCmd, effectiveWorkdir),
};
