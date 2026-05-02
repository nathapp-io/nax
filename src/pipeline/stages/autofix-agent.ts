/**
 * Agent rectification for the autofix stage — extracted from autofix.ts.
 *
 * Contains runAgentRectification and its private helpers.
 * Imports _autofixDeps from autofix.ts (safe — autofix.ts lazily imports this module).
 */

import type { SessionHandle } from "../../agents/types";
import { resolveModelForAgent } from "../../config";
import { NaxError } from "../../errors";
import { getLogger } from "../../logger";
import { RectifierPromptBuilder } from "../../prompts";
import { LLM_REVIEW_CHECKS } from "../../review";
import type { ReviewCheckResult } from "../../review/types";
import { formatSessionName } from "../../session/naming";
import { buildProgressivePromptPreamble, runRetryLoop } from "../../verification/shared-rectification-loop";
import { pipelineEventBus } from "../event-bus";
import type { PipelineContext } from "../types";
import { _autofixDeps } from "./autofix";
import { splitFindingsByScope } from "./autofix-adversarial";

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

export async function runAgentRectification(
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
  if (!ctx.runtime) {
    throw new NaxError(
      "runtime required — legacy agentManager.run path removed (ADR-019 Wave 3, issue #762)",
      "DISPATCH_NO_RUNTIME",
      { stage: "rectification", storyId: ctx.story.id },
    );
  }
  const { agentManager } = ctx;
  const { runtime } = ctx;

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
  const lintOutputFormat = ctx.config.quality.lintOutput?.format ?? "auto";
  const typecheckOutputFormat = ctx.config.quality.typecheckOutput?.format ?? "auto";
  for (const check of failedChecks) {
    if (check.check === "adversarial" || check.check === "lint" || check.check === "typecheck") {
      const { testFindings, sourceFindings } = splitFindingsByScope(
        check,
        stageTestFilePatterns,
        lintOutputFormat,
        typecheckOutputFormat,
      );
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

  // ADR-008 §6 / ADR-018 §7 Pattern B: hold the implementer session open across
  // all attempts in this rectification cycle so the agent retains conversation
  // history between attempts. consumed === 0 means execution.ts is the upstream
  // owner; openSession is idempotent on a live handle (session/manager.ts:354)
  // so we attach to the existing session when present, otherwise open fresh.
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
  // Set true when recheckReview fails solely due to adversarial fail-open (timeout).
  // shouldAbort (below) reads this flag and exits before the next attempt is built,
  // preventing a wasted implementer call with stale initialFailure findings. Issue #832.
  let failOpenAborted = false;

  // Held-open implementer session for the duration of the loop. Opened lazily
  // on first execute() to avoid paying openSession cost when the agent fails
  // before any attempt runs (e.g. validation errors). Closed in finally below.
  let heldHandle: SessionHandle | undefined;

  const outcome = await runRetryLoop<AutofixFailure, AutofixAttemptResult>({
    stage: "rectification",
    storyId: ctx.story.id,
    packageDir: ctx.workdir,
    maxAttempts,
    failure: initialFailure,
    previousAttempts: [],
    shouldAbort: (_failure, _attempt) => failOpenAborted,
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
      let result: import("../../agents").AgentResult;
      try {
        // ADR-008 §6 / ADR-018 §7 Pattern B: open the implementer session
        // once and reuse across attempts so conversation history persists.
        // openSession is idempotent on a live handle (session/manager.ts:354)
        // so the first attempt of cycle 0 attaches to the execution-stage
        // session when one is still open, otherwise opens fresh.
        if (!heldHandle) {
          heldHandle = await runtime.sessionManager.openSession(implementerSession, {
            agentName: defaultAgent,
            role: "implementer",
            workdir: ctx.workdir,
            pipelineStage: "rectification",
            modelDef,
            timeoutSeconds: ctx.config.execution.sessionTimeoutSeconds,
            featureName: ctx.prd.feature,
            storyId: ctx.story.id,
            signal: runtime.signal,
          });
        }
        // ADR-020 single-emission invariant: each runAsSession emits one
        // session-turn event, regardless of handle reuse across attempts.
        const turn = await agentManager.runAsSession(defaultAgent, heldHandle, prompt, {
          storyId: ctx.story.id,
          featureName: ctx.prd.feature,
          workdir: ctx.workdir,
          projectDir: ctx.projectDir,
          pipelineStage: "rectification",
          sessionRole: "implementer",
          signal: runtime.signal,
          maxTurns: ctx.config.agent?.maxInteractionTurns,
        });
        // Synthesize AgentResult so the downstream UNRESOLVED/CLARIFY/no-op
        // detection paths keep working unchanged. runAsSession throws on
        // failure, so a returned TurnResult always means success=true.
        result = {
          success: true,
          exitCode: 0,
          output: turn.output,
          rateLimited: false,
          durationMs: 0,
          estimatedCostUsd: turn.estimatedCostUsd,
          ...(turn.exactCostUsd !== undefined && { exactCostUsd: turn.exactCostUsd }),
          ...(turn.tokenUsage && { tokenUsage: turn.tokenUsage }),
          ...(heldHandle.protocolIds && { protocolIds: heldHandle.protocolIds }),
        };
        sessionConfirmedOpen = true;
      } catch (err) {
        sessionConfirmedOpen = false;
        // Discard the held handle so the next attempt reopens — the previous
        // session may be in a terminal/cancelled state after the throw.
        if (heldHandle) {
          const stale = heldHandle;
          heldHandle = undefined;
          await runtime.sessionManager.closeSession(stale).catch(() => {});
        }
        throw err;
      }

      autofixCostAccum += result.estimatedCostUsd ?? 0;

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
        cost: result.estimatedCostUsd ?? 0,
        checkSignatureChanged,
        noOp,
        consecutiveNoOps: newConsecutiveNoOps,
      };
    },
    verify: async (result) => {
      // Re-run checks first — BEFORE any no-op branching.
      // #808: A "no-op" agent turn (no new commit) does not always mean the failure
      // is unresolved. Common cases where checks now pass without a new commit:
      //   - The initial diagnostic was transient (stale typecheck cache cleared on re-run)
      //   - A prior commit on this branch already covers the fix
      //   - Filesystem state from a previous pipeline stage took time to propagate
      // Reprompting in those cases burns full rectification attempts (~75s each)
      // on already-passing checks. The check is the source of truth, not the git ref.
      //
      // Cost optimization: on no-op the diff is unchanged, so LLM-driven checks
      // (semantic, adversarial) will return the same verdict on re-run. Skip the
      // recheck entirely when ALL failing checks are LLM-driven — there is nothing
      // a re-run can reveal. When at least one mechanical check (typecheck/lint/
      // test/build) is failing, run recheck — those CAN flip without a new commit.
      const failingChecks = (ctx.reviewResult?.checks ?? []).filter((c) => !c.success);
      const hasMechanicalFailure = failingChecks.some((c) => !LLM_REVIEW_CHECKS.has(c.check));
      const recheckWorthwhile = !result.noOp || hasMechanicalFailure;
      const passed = recheckWorthwhile ? await _autofixDeps.recheckReview(ctx) : false;
      if (passed) {
        if (result.noOp) {
          logger.info(
            "autofix",
            `[OK] Checks pass without new commit on attempt ${consumed + currentAttempt} (transient or already resolved)`,
            { storyId: ctx.story.id },
          );
        } else {
          logger.info("autofix", `[OK] Agent rectification succeeded on attempt ${consumed + currentAttempt}`, {
            storyId: ctx.story.id,
          });
        }
        return { passed: true };
      }

      // Checks still failing — handle no-op cases.
      // If too many consecutive no-ops, escalate by failing.
      if (result.consecutiveNoOps > MAX_CONSECUTIVE_NOOP_REPROMPTS) {
        logger.warn("autofix", "No source changes (no-op limit reached) — counting as consumed attempt", {
          storyId: ctx.story.id,
          attemptsRemaining: maxAttempts - currentAttempt,
        });
        // Skip LLM checks that already passed — they'll return the same result on the unchanged diff.
        const passedChecks = (ctx.reviewResult?.checks ?? [])
          .filter((c) => c.success && !c.skipped)
          .map((c) => c.check);
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

      // Checks still failing AND agent made no commit → no-op reprompt path.
      if (result.noOp) {
        logger.info(
          "autofix",
          "No source changes and checks still failing — re-prompting with stronger directive (counts as consumed attempt)",
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

      // recheckReview returned false but collectFailedChecks found nothing — this happens
      // exclusively when adversarial timed out (fail-open): ctx.reviewResult.success=false
      // but all checks carry success=true. Re-prompting with stale initialFailure would
      // send the implementer already-fixed findings. Set failOpenAborted so shouldAbort
      // exits before the next attempt is built. Issue #832.
      const isFailOpenOnly = (ctx.reviewResult?.checks ?? []).some((c) => c.failOpen);
      if (isFailOpenOnly) {
        failOpenAborted = true;
      }
      logger.warn(
        "autofix",
        isFailOpenOnly
          ? "Adversarial timed out during recheck (fail-open) — aborting retry to avoid stale re-prompt"
          : "Agent rectification exhausted — no failed checks detected after recheck",
        {
          storyId: ctx.story.id,
          attemptsUsed: currentAttempt,
          globalBudgetUsed: consumed + currentAttempt,
          maxTotalAttempts: maxTotal,
        },
      );
      return {
        passed: false,
        newFailure: initialFailure,
      };
    },
  })
    .catch((error: unknown) => {
      if (error instanceof Error && error.message === "AUTOFIX_AGENT_NOT_FOUND") {
        return { outcome: "exhausted", attempts: 0, finalFailure: initialFailure } as const;
      }
      if (error instanceof Error && error.message === "AUTOFIX_UNRESOLVED") {
        return { outcome: "exhausted", attempts: 0, finalFailure: initialFailure } as const;
      }
      throw error;
    })
    .finally(async () => {
      // ADR-008 §6: close the held implementer session at loop exit (success,
      // exhaustion, or unhandled error). Best-effort — failures here must not
      // mask the loop outcome.
      if (heldHandle) {
        const stale = heldHandle;
        heldHandle = undefined;
        await runtime.sessionManager.closeSession(stale).catch(() => {});
      }
    });

  const succeeded = outcome.outcome === "fixed";
  return { succeeded, cost: autofixCostAccum, unresolvedReason };
}
