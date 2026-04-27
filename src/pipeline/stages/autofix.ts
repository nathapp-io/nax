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

import { resolveModelForAgent } from "../../config";
import { getLogger } from "../../logger";
import type { UserStory } from "../../prd";
import { RectifierPromptBuilder } from "../../prompts";
import { runQualityCommand } from "../../quality";
import type { ReviewCheckResult } from "../../review/types";
import { formatSessionName } from "../../session/naming";
import { captureGitRef } from "../../utils/git";
import { buildProgressivePromptPreamble, runRetryLoop } from "../../verification/shared-rectification-loop";
import { pipelineEventBus } from "../event-bus";
import type { PipelineContext, PipelineStage, StageResult } from "../types";
import { runTestWriterRectification, splitFindingsByScope } from "./autofix-adversarial";

/** Failure snapshot for the autofix retry loop. */
interface AutofixFailure {
  checks: ReviewCheckResult[];
  checkSignature: string;
}

/** Result from one autofix attempt. */
interface AutofixAttemptResult {
  agentSuccess: boolean;
  cost: number;
  checkSignatureChanged: boolean;
  /** True when the agent produced zero file changes. */
  noOp: boolean;
  consecutiveNoOps: number;
}

const CLARIFY_REGEX = /^CLARIFY:\s*(.+)$/ms;
/** Matches the REVIEW-003 reviewer contradiction escape hatch emitted by the implementer. */
const UNRESOLVED_REGEX = /^UNRESOLVED:\s*(.+)$/ms;
/**
 * Maximum number of consecutive no-op reprompts (agent produced zero file changes)
 * before the attempt is counted against the rectification budget.
 *
 * Set to 1: one free reprompt per no-op streak. If the agent still produces no
 * changes after the stronger directive, the second no-op counts as a real attempt.
 */
const MAX_CONSECUTIVE_NOOP_REPROMPTS = 1;

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

    // STRAT-001: no-test stories never write tests, so adversarial findings scoped to test
    // files are irrelevant and unresolvable within the story's scope.  When every failing
    // check is an adversarial check whose findings are all test-file scoped, treat the
    // review as passed (with a warning) rather than launching any agent session.
    const testFilePatterns =
      typeof ctx.rootConfig.execution?.smartTestRunner === "object"
        ? ctx.rootConfig.execution.smartTestRunner?.testFilePatterns
        : undefined;
    if (ctx.routing.testStrategy === "no-test") {
      const failedChecks = (reviewResult.checks ?? []).filter((c) => !c.success);
      if (
        failedChecks.length > 0 &&
        failedChecks.every((c) => {
          const { testFindings, sourceFindings } = splitFindingsByScope(c, testFilePatterns);
          return testFindings !== null && sourceFindings === null;
        })
      ) {
        const skippedFindingCount = failedChecks.flatMap((c) => c.findings ?? []).length;
        logger.warn("autofix", "Review found test-file issues only — skipped (no-test strategy)", {
          storyId: ctx.story.id,
          skippedFindingCount,
        });
        if (ctx.reviewResult) ctx.reviewResult = { ...ctx.reviewResult, success: true };
        return { action: "continue" };
      }
    }

    // Phase 2: Agent rectification — spawn agent with review error context
    const {
      succeeded: agentFixed,
      cost: agentCost,
      unresolvedReason,
    } = await _autofixDeps.runAgentRectification(ctx, lintFixCmd, formatFixCmd, ctx.workdir);

    // REVIEW-003: Implementer signalled an unresolvable reviewer contradiction.
    if (unresolvedReason) {
      // When only mechanical checks failed (LLM/semantic passed), the code is functionally
      // correct — the agent cannot fix lint/typecheck errors in test files per its constraints.
      // Suppress tier escalation and proceed; log a warning so the issue remains visible.
      if (ctx.mechanicalFailedOnly) {
        logger.warn("autofix", "Mechanical-only failure unfixable — proceeding (LLM review passed)", {
          storyId: ctx.story.id,
          unresolvedReason,
        });
        if (ctx.reviewResult) ctx.reviewResult = { ...ctx.reviewResult, success: true };
        return { action: "continue", cost: agentCost };
      }
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

    // Partial-progress retry: if the agent cleared at least one check this cycle but not all,
    // and the global budget has not been exhausted, retry from review with cleared checks
    // added to the skip list. The next cycle then targets only the remaining failures.
    // Zero-progress → escalate immediately (stuck rule: no point burning more budget).
    const maxTotal = ctx.config.quality.autofix?.maxTotalAttempts ?? 10;
    const totalUsed = ctx.autofixAttempt ?? 0;
    const currentlyFailing = new Set((ctx.reviewResult?.checks ?? []).filter((c) => !c.success).map((c) => c.check));
    const nowPassing = [...failedCheckNames].filter((c) => !currentlyFailing.has(c));

    if (nowPassing.length > 0 && totalUsed < maxTotal) {
      ctx.retrySkipChecks = new Set([...(ctx.retrySkipChecks ?? []), ...nowPassing]);
      logger.info("autofix", "Partial progress — retrying review with updated skip list", {
        storyId: ctx.story.id,
        nowPassing,
        remaining: [...currentlyFailing],
        budgetUsed: `${totalUsed}/${maxTotal}`,
      });
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
  // A fail-open result (LLM could not parse its response) is not a genuine pass in a
  // recheck context — we already know the review was failing before this call.
  const hasFailOpen = (ctx.reviewResult?.checks ?? []).some((c) => c.failOpen);
  if (hasFailOpen) return false;
  return ctx.reviewResult?.success === true;
}

function collectFailedChecks(ctx: PipelineContext): ReviewCheckResult[] {
  return (ctx.reviewResult?.checks ?? []).filter((c) => !c.success);
}

function getCheckSignature(checks: ReviewCheckResult[]): string {
  return [...new Set(checks.map((check) => check.check))].sort().join("|");
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

  if (!ctx.agentManager) {
    logger.error("autofix", "Agent manager unavailable — cannot run agent rectification", { storyId: ctx.story.id });
    return { succeeded: false, cost: 0 };
  }
  const { agentManager } = ctx;

  // #409 #669: Split findings by file scope.
  // Test-file findings cannot be fixed by the implementer (isolation constraint) —
  // route them to a separate test-writer rectification call before the implementer loop.
  // Handles both adversarial checks (structured findings[]) and lint checks (raw output).
  let implementerChecks = failedChecks;
  let testWriterChecks: ReviewCheckResult[] = [];

  const stageTestFilePatterns =
    typeof ctx.rootConfig.execution?.smartTestRunner === "object"
      ? ctx.rootConfig.execution.smartTestRunner?.testFilePatterns
      : undefined;
  for (const check of failedChecks) {
    if (check.check === "adversarial" || check.check === "lint") {
      const { testFindings, sourceFindings } = splitFindingsByScope(check, stageTestFilePatterns);
      // null/null means the check has no classifiable findings — leave implementerChecks unchanged.
      if (testFindings || sourceFindings) {
        if (testFindings) testWriterChecks = [...testWriterChecks, testFindings];
        if (sourceFindings) {
          // Use reference equality (c === check) rather than type matching so that multiple
          // entries don't all get replaced with the last iteration's sourceFindings.
          implementerChecks = implementerChecks.map((c) => (c === check ? sourceFindings : c));
        } else {
          // All findings are in test files — remove only this check from implementer checks.
          implementerChecks = implementerChecks.filter((c) => c !== check);
        }
      }
    }
  }

  let autofixCostAccum = 0;

  if (testWriterChecks.length > 0) {
    if (ctx.routing.testStrategy === "no-test") {
      // STRAT-001: no-test stories must not modify test files — skip test-writer session.
      // The execute()-level early exit handles the common case; this guard is a safety net
      // for mixed failures (test-file checks + other checks) that bypass the early exit.
      logger.warn("autofix", "Skipping test-writer rectification (no-test strategy)", {
        storyId: ctx.story.id,
        checks: testWriterChecks.map((c) => c.check),
      });
    } else {
      logger.info("autofix", "Routing test-file findings to test-writer session", {
        storyId: ctx.story.id,
        checks: testWriterChecks.map((c) => c.check),
      });
      autofixCostAccum += await _autofixDeps.runTestWriterRectification(ctx, testWriterChecks, ctx.story, agentManager);
    }
  }

  // If all findings were test-file scoped and no other checks failed,
  // skip the implementer loop — return for recheck after test-writer fixed the issues.
  if (implementerChecks.length === 0) {
    logger.info("autofix", "All findings routed to test-writer — skipping implementer loop", {
      storyId: ctx.story.id,
    });
    return { succeeded: false, cost: autofixCostAccum };
  }

  let unresolvedReason: string | undefined;
  // #411: Track git HEAD before each agent attempt so verify can detect
  // whether the agent actually modified source files. When no files changed
  // (e.g. UNRESOLVED signal, lint-only fix), passed LLM checks are skipped.
  let autofixBeforeRef: string | undefined;

  // Session continuity: the implementer session is open only on the very first autofix call
  // (consumed === 0). On subsequent cycles (after a review retry), the previous loop's last
  // execute used keepOpen: false, so the session was closed before we re-enter.
  const implementerSession = formatSessionName({
    workdir: ctx.workdir,
    featureName: ctx.prd.feature,
    storyId: ctx.story.id,
    role: "implementer",
  });
  let sessionConfirmedOpen = consumed === 0;

  logger.info("autofix", "Starting agent rectification for review failures", {
    storyId: ctx.story.id,
    failedChecks: implementerChecks.map((check) => check.check),
    maxAttempts,
    totalUsed: consumed,
    maxTotalAttempts: maxTotal,
  });

  const initialFailure: AutofixFailure = {
    checks: implementerChecks,
    checkSignature: getCheckSignature(implementerChecks),
  };

  // Track state across buildPrompt/execute/verify callbacks
  let currentAttempt = 0;
  let currentConsecutiveNoOps = 0;
  let currentCheckSignatureChanged = false;

  const outcome = await runRetryLoop<AutofixFailure, AutofixAttemptResult>({
    stage: "rectification",
    storyId: ctx.story.id,
    packageDir: ctx.workdir,
    maxAttempts,
    failure: initialFailure,
    previousAttempts: [],
    buildPrompt: (failure, previous) => {
      currentAttempt = previous.length + 1;
      const lastResult = previous[previous.length - 1]?.result;
      const lastWasNoOp = lastResult?.noOp ?? false;
      currentConsecutiveNoOps = lastResult?.consecutiveNoOps ?? 0;
      currentCheckSignatureChanged = failure.checkSignature !== initialFailure.checkSignature;

      logger.debug("autofix", `Building prompt for attempt ${consumed + currentAttempt}/${maxTotal}`, {
        storyId: ctx.story.id,
        lastWasNoOp,
        consecutiveNoOps: currentConsecutiveNoOps,
      });

      // No-op reprompt: agent produced zero file changes on the previous turn.
      // Send a focused directive before falling back to the normal prompt hierarchy.
      if (lastWasNoOp) {
        return RectifierPromptBuilder.noOpReprompt(
          failure.checks,
          currentConsecutiveNoOps,
          MAX_CONSECUTIVE_NOOP_REPROMPTS,
        );
      }

      // #412: First attempt uses a lean delta prompt when the implementer session is
      // already open — the agent has full story context from execution, so we only
      // need to send the review findings, not re-state the full prompt.
      if (currentAttempt === 1 && sessionConfirmedOpen) {
        return RectifierPromptBuilder.firstAttemptDelta(failure.checks, maxAttempts);
      }

      const isSessionContinuation = currentAttempt > 1 && sessionConfirmedOpen;

      if (isSessionContinuation) {
        // If failing check categories changed since the previous attempt, this is the
        // first attempt for a new failure class (e.g. semantic -> adversarial). Reset
        // to first-attempt framing instead of continuation wording.
        if (currentCheckSignatureChanged) {
          const attemptsRemaining = Math.max(1, maxAttempts - currentAttempt + 1);
          return RectifierPromptBuilder.firstAttemptDelta(failure.checks, attemptsRemaining);
        }
        // Apply the same capping as buildProgressivePromptPreamble so the last attempt
        // always triggers urgency even when urgencyAtAttempt > maxAttempts.
        return RectifierPromptBuilder.continuation(
          failure.checks,
          currentAttempt,
          Math.min(rethinkAtAttempt, maxAttempts),
          Math.min(urgencyAtAttempt, maxAttempts),
        );
      }

      let prompt = RectifierPromptBuilder.reviewRectification(failure.checks, ctx.story);
      const escalationPreamble = buildAutofixEscalationPreamble(
        currentAttempt,
        maxAttempts,
        rethinkAtAttempt,
        urgencyAtAttempt,
      );
      if (escalationPreamble) {
        prompt = `${escalationPreamble}${prompt}`;
      }
      return prompt;
    },
    execute: async (prompt) => {
      logger.info("autofix", `Agent rectification attempt ${consumed + currentAttempt}/${maxTotal}`, {
        storyId: ctx.story.id,
      });

      // #411: Capture HEAD before agent runs so verify can detect file changes.
      autofixBeforeRef = await _autofixDeps.captureGitRef(ctx.workdir);
      ctx.autofixAttempt = consumed + currentAttempt;
      const modelTier =
        ctx.story.routing?.modelTier ?? ctx.rootConfig.autoMode.escalation.tierOrder[0]?.tier ?? "balanced";
      const defaultAgent = agentManager.getDefault();
      const modelDef = resolveModelForAgent(
        ctx.rootConfig.models,
        ctx.routing.agent ?? defaultAgent,
        modelTier,
        defaultAgent,
      );
      const isLastAttempt = currentAttempt >= maxAttempts;
      let result: import("../../agents").AgentResult;
      try {
        result = await agentManager.run({
          runOptions: {
            prompt,
            workdir: ctx.workdir,
            modelTier,
            modelDef,
            timeoutSeconds: ctx.config.execution.sessionTimeoutSeconds,
            pipelineStage: "rectification",
            config: ctx.config,
            projectDir: ctx.projectDir,
            maxInteractionTurns: ctx.config.agent?.maxInteractionTurns,
            featureName: ctx.prd.feature,
            storyId: ctx.story.id,
            sessionRole: "implementer",
            keepOpen: !isLastAttempt,
          },
        });
        sessionConfirmedOpen = true;
      } catch (err) {
        sessionConfirmedOpen = false; // Session state unknown — next attempt uses full prompt
        throw err;
      }

      autofixCostAccum += result.estimatedCost ?? 0;

      // G5: bind updated protocolIds after each autofix attempt so the session descriptor
      // reflects the session that actually ran (may change after internal session retries).
      if (ctx.sessionManager && ctx.sessionId && result.protocolIds) {
        try {
          const desc = ctx.sessionManager.get(ctx.sessionId);
          if (desc) {
            ctx.sessionManager.bindHandle(ctx.sessionId, implementerSession, result.protocolIds);
          }
        } catch {
          // Best-effort — never block the autofix loop.
        }
      }

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

      // Detect no-op (zero changes)
      const refAfterAttempt = await _autofixDeps.captureGitRef(ctx.workdir);
      const sourceFilesChanged =
        autofixBeforeRef === undefined || refAfterAttempt === undefined || autofixBeforeRef !== refAfterAttempt;
      const noOp = !sourceFilesChanged;

      // Detect check signature change — will be computed during verify phase
      const checkSignatureChanged = false;

      // Track consecutive no-ops
      const newConsecutiveNoOps = noOp ? currentConsecutiveNoOps + 1 : 0;

      return {
        agentSuccess: result.success,
        cost: result.estimatedCost ?? 0,
        checkSignatureChanged,
        noOp,
        consecutiveNoOps: newConsecutiveNoOps,
      };
    },
    verify: async (result) => {
      // If too many consecutive no-ops, escalate by failing
      if (result.consecutiveNoOps > MAX_CONSECUTIVE_NOOP_REPROMPTS) {
        logger.warn("autofix", "No source changes (no-op limit reached) — counting as consumed attempt", {
          storyId: ctx.story.id,
          attemptsRemaining: maxAttempts - currentAttempt,
        });
        // Skip LLM checks that already passed — they'll return the same result on the unchanged diff.
        const passedChecks = (ctx.reviewResult?.checks ?? []).filter((c) => c.success).map((c) => c.check);
        if (passedChecks.length > 0) {
          ctx.retrySkipChecks = new Set(passedChecks);
          logger.debug("autofix", "No source changes — skipping already-passed checks on recheck", {
            storyId: ctx.story.id,
            skippedChecks: passedChecks,
          });
        }
        return {
          passed: false,
          newFailure: initialFailure,
        };
      }

      // Check if this attempt was a no-op and we should continue
      if (result.noOp) {
        logger.info(
          "autofix",
          "No source changes — re-prompting with stronger directive (counts as consumed attempt)",
          {
            storyId: ctx.story.id,
            noOpCount: `${result.consecutiveNoOps}/${MAX_CONSECUTIVE_NOOP_REPROMPTS}`,
            attemptsRemaining: maxAttempts - currentAttempt,
          },
        );
        // Return failure to trigger the no-op reprompt logic in buildPrompt
        return {
          passed: false,
          newFailure: initialFailure,
        };
      }

      // Re-run checks to see if they pass
      const passed = await _autofixDeps.recheckReview(ctx);
      if (passed) {
        logger.info("autofix", `[OK] Agent rectification succeeded on attempt ${consumed + currentAttempt}`, {
          storyId: ctx.story.id,
        });
        return { passed: true };
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
          logger.info(
            "autofix",
            `[OK] Mechanical fix resolved agent-introduced lint errors on attempt ${consumed + currentAttempt}`,
            {
              storyId: ctx.story.id,
            },
          );
          return { passed: true };
        }
      }

      if (updatedFailed.length > 0) {
        const updatedCheckSignature = getCheckSignature(updatedFailed);
        currentCheckSignatureChanged = updatedCheckSignature !== initialFailure.checkSignature;
        logger.warn("autofix", `Agent rectification still failing after attempt ${consumed + currentAttempt}`, {
          storyId: ctx.story.id,
          attemptsRemaining: maxAttempts - currentAttempt,
          globalBudgetRemaining: maxTotal - (consumed + currentAttempt),
        });
        return {
          passed: false,
          newFailure: {
            checks: updatedFailed,
            checkSignature: updatedCheckSignature,
          },
        };
      }

      logger.warn("autofix", "Agent rectification exhausted", {
        storyId: ctx.story.id,
        attemptsUsed: currentAttempt,
        globalBudgetUsed: consumed + currentAttempt,
        maxTotalAttempts: maxTotal,
      });
      return {
        passed: false,
        newFailure: initialFailure,
      };
    },
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === "AUTOFIX_AGENT_NOT_FOUND") {
      return { outcome: "exhausted", attempts: 0 } as const;
    }
    if (error instanceof Error && error.message === "AUTOFIX_UNRESOLVED") {
      return { outcome: "exhausted", attempts: 0 } as const;
    }
    throw error;
  });

  const succeeded = outcome.outcome === "fixed";
  return { succeeded, cost: autofixCostAccum, unresolvedReason };
}

/**
 * Injectable deps for testing.
 */
export const _autofixDeps = {
  runQualityCommand,
  recheckReview,
  captureGitRef,
  runAgentRectification: (
    ctx: PipelineContext,
    lintFixCmd: string | undefined,
    formatFixCmd: string | undefined,
    effectiveWorkdir: string,
  ): Promise<{ succeeded: boolean; cost: number; unresolvedReason?: string }> =>
    runAgentRectification(ctx, lintFixCmd, formatFixCmd, effectiveWorkdir),
  runTestWriterRectification: (
    ctx: PipelineContext,
    testWriterChecks: ReviewCheckResult[],
    story: UserStory,
    agentManager: import("../../agents").IAgentManager,
  ): Promise<number> => runTestWriterRectification(ctx, testWriterChecks, story, agentManager),
};
