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

import { getLogger } from "../../logger";
import type { UserStory } from "../../prd";
import { runQualityCommand } from "../../quality";
import type { ReviewCheckName, ReviewCheckResult } from "../../review/types";
import { pipelineEventBus } from "../event-bus";
import type { PipelineContext, PipelineStage, StageResult } from "../types";
import { runAgentRectification } from "./autofix-agent";
import { autofixCapacityExhausted } from "./autofix-cycle";
import { splitFindingsByScope } from "./autofix-scope-split";
import { runTestWriterRectification } from "./autofix-test-writer";

// Checks that cannot be resolved by agent rectification. Mechanical pre-checks that
// require human intervention (e.g. commit the dirty files). New mechanical pre-checks
// must opt in explicitly — the set is intentionally closed.
const NON_FIXABLE_BY_RECTIFICATION = new Set<ReviewCheckName>(["git-clean"]);
type FixCommandName = "lintFix" | "formatFix";

interface ResolvedFixCommand {
  commandName: FixCommandName;
  command: string;
  scoped: boolean;
  skipped?: boolean;
}

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

    // Counts real entries to autofix this pipeline. Read by the partial-progress
    // budget gate below and the fail-closed-on-fail-open guard in review.ts. Must
    // increment before any work so subsequent reads on the same call see N >= 1.
    ctx.autofixAttempt = (ctx.autofixAttempt ?? 0) + 1;

    // Effective workdir for running commands — workdir is already resolved at context creation

    // Identify which checks failed
    const failedCheckNames = new Set((reviewResult.checks ?? []).filter((c) => !c.success).map((c) => c.check));
    const hasLintFailure = failedCheckNames.has("lint");

    const totalFindingCount = (reviewResult.checks ?? []).reduce((n, c) => n + (c.findings?.length ?? 0), 0);
    const allFailuresNonFixable =
      failedCheckNames.size > 0 && [...failedCheckNames].every((c) => NON_FIXABLE_BY_RECTIFICATION.has(c));
    if (failedCheckNames.size === 0 || (allFailuresNonFixable && totalFindingCount === 0)) {
      logger.error("autofix", "Cannot autofix: review failed with no actionable signal", {
        storyId: ctx.story.id,
        failedChecks: [...failedCheckNames],
        failureReason: reviewResult.failureReason,
      });
      return {
        action: "escalate",
        reason: `Review failed without actionable signal: ${reviewResult.failureReason ?? "(no reason given)"}`,
      };
    }

    logger.info("autofix", "Starting autofix", {
      storyId: ctx.story.id,
      failedChecks: [...failedCheckNames],
      workdir: ctx.workdir,
    });

    // Phase 1: Mechanical fix — only for lint failures (lintFix/formatFix cannot fix typecheck errors)
    if (hasLintFailure && hasMechanicalFixCommand(ctx)) {
      await runMechanicalFixes(ctx, failedCheckNames);

      const recheckPassed = await _autofixDeps.recheckReview(ctx);
      pipelineEventBus.emit({ type: "autofix:completed", storyId: ctx.story.id, fixed: recheckPassed });

      if (recheckPassed) {
        // #136: Skip checks that already passed — mechanical fix only touched lint/format.
        // Semantic/debate review doesn't need to re-run after a lint-only fix.
        const passedChecks = (ctx.reviewResult?.checks ?? [])
          .filter((c) => c.success && !c.skipped)
          .map((c) => c.check);
        if (passedChecks.length > 0) {
          ctx.retrySkipChecks = new Set(passedChecks);
          logger.debug("autofix", "Skipping already-passed checks on retry", {
            storyId: ctx.story.id,
            skippedChecks: passedChecks,
          });
        }
        logger.info("autofix", "Mechanical autofix succeeded — retrying review", { storyId: ctx.story.id });
        return { action: "retry", fromStage: "review", resetRetryCount: true };
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
    const lintOutputFormat = ctx.config.quality.lintOutput?.format ?? "auto";
    const typecheckOutputFormat = ctx.config.quality.typecheckOutput?.format ?? "auto";
    if (ctx.routing.testStrategy === "no-test") {
      const failedChecks = (reviewResult.checks ?? []).filter((c) => !c.success);
      if (
        failedChecks.length > 0 &&
        failedChecks.every((c) => {
          const { testFindings, sourceFindings } = splitFindingsByScope(
            c,
            testFilePatterns,
            lintOutputFormat,
            typecheckOutputFormat,
            { workdir: ctx.workdir },
          );
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
      escalationDigest,
    } = await _autofixDeps.runAgentRectification(
      ctx,
      resolveBroadFixCommand(ctx, "lintFix"),
      resolveBroadFixCommand(ctx, "formatFix"),
      ctx.workdir,
    );

    // REVIEW-003: Implementer signalled an unresolvable reviewer contradiction.
    // Only act on unresolvedReason when the fix actually failed — if agentFixed is true,
    // all findings were resolved and the UNRESOLVED note is informational (one finding
    // was abandoned but the validate step confirmed nothing is left blocking).
    if (!agentFixed && unresolvedReason) {
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
      const passedChecks = (ctx.reviewResult?.checks ?? []).filter((c) => c.success && !c.skipped).map((c) => c.check);
      if (passedChecks.length > 0) {
        ctx.retrySkipChecks = new Set(passedChecks);
        logger.debug("autofix", "Skipping already-passed checks on retry", {
          storyId: ctx.story.id,
          skippedChecks: passedChecks,
        });
      }
      logger.info("autofix", "Agent rectification succeeded — retrying review", { storyId: ctx.story.id });
      return { action: "retry", fromStage: "review", resetRetryCount: true, cost: agentCost };
    }

    // Partial-progress retry: if the agent cleared at least one check this cycle but not all,
    // and the global budget has not been exhausted, retry from review with cleared checks
    // added to the skip list. The next cycle then targets only the remaining failures.
    // Zero-progress → escalate immediately (stuck rule: no point burning more budget).
    const maxTotal = ctx.config.quality.autofix?.maxTotalAttempts ?? 10;
    const totalUsed = ctx.autofixAttempt ?? 0;
    // Treat fail-open checks as still-failing so they are not added to retrySkipChecks.
    // An adversarial timeout is not a genuine pass — skipping it next cycle would let
    // the story complete without a real adversarial review. Issue #832.
    const currentlyFailing = new Set(
      (ctx.reviewResult?.checks ?? []).filter((c) => !c.success || c.failOpen).map((c) => c.check),
    );
    const nowPassing = [...failedCheckNames].filter((c) => !currentlyFailing.has(c));

    // Avoid burning LLM tokens on a review pass that the next autofix cycle would
    // immediately bail on at its cap precheckers. After cycle V2 lands, prior
    // iterations persist across pipeline retries via ctx.autofixPriorIterations,
    // so a "partial progress" exit can leave every relevant strategy at cap even
    // when the global budget still has room. See issue #951.
    const capacityExhausted = autofixCapacityExhausted(ctx);
    if (nowPassing.length > 0 && totalUsed < maxTotal && !capacityExhausted) {
      ctx.retrySkipChecks = new Set([...(ctx.retrySkipChecks ?? []), ...nowPassing]);
      logger.info("autofix", "Partial progress — retrying review with updated skip list", {
        storyId: ctx.story.id,
        nowPassing,
        remaining: [...currentlyFailing],
        budgetUsed: `${totalUsed}/${maxTotal}`,
      });
      return { action: "retry", fromStage: "review", cost: agentCost };
    }
    if (nowPassing.length > 0 && capacityExhausted) {
      logger.info(
        "autofix",
        "Partial progress — but autofix capacity exhausted; escalating instead of retrying review",
        {
          storyId: ctx.story.id,
          nowPassing,
          remaining: [...currentlyFailing],
        },
      );
    }

    logger.warn("autofix", "Autofix exhausted — escalating", { storyId: ctx.story.id });
    return {
      action: "escalate",
      reason: escalationDigest ?? "Autofix exhausted: review still failing after fix attempts",
      cost: agentCost,
    };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function recheckReview(ctx: PipelineContext, opts?: { lite?: boolean }): Promise<boolean> {
  const lite = opts?.lite === true;

  if (lite) {
    const origSkipChecks = ctx.retrySkipChecks;
    const origSkipLLMReviewers = ctx.skipLLMReviewers;
    ctx.retrySkipChecks = new Set([...(ctx.retrySkipChecks ?? []), "adversarial", "semantic"]);
    ctx.skipLLMReviewers = true;
    try {
      await _autofixDeps.runReviewStage(ctx);
    } finally {
      ctx.retrySkipChecks = origSkipChecks;
      ctx.skipLLMReviewers = origSkipLLMReviewers;
    }
    // In lite mode: success=true is always a genuine pass; failOpen is skipped (LLM not involved).
    return ctx.reviewResult?.success === true;
  }

  // Standard (non-lite) path — import lazily to avoid circular deps.
  // Disabled stage is treated as a pass (no review needed).
  const { reviewStage } = await import("./review");
  if (!reviewStage.enabled(ctx)) return true;
  // reviewStage.execute updates ctx.reviewResult in place.
  // We cannot use result.action here because review returns "continue" for BOTH
  // pass and built-in-check-failure (to hand off to autofix). Check success directly.
  await _autofixDeps.runReviewStage(ctx);
  // A fail-open result (LLM could not parse its response) is not a genuine pass in a
  // recheck context — we already know the review was failing before this call.
  const hasFailOpen = (ctx.reviewResult?.checks ?? []).some((c) => c.failOpen);
  if (hasFailOpen) return false;
  return ctx.reviewResult?.success === true;
}

async function runReviewStage(ctx: PipelineContext): Promise<void> {
  const { reviewStage } = await import("./review");
  if (!reviewStage.enabled(ctx)) return;
  await reviewStage.execute(ctx);
}

async function runMechanicalFixes(ctx: PipelineContext, failedCheckNames: Set<ReviewCheckName>): Promise<void> {
  const commands = resolveMechanicalFixCommands(ctx, failedCheckNames);
  for (const resolved of commands) {
    if (resolved.skipped) continue;
    pipelineEventBus.emit({ type: "autofix:started", storyId: ctx.story.id, command: resolved.command });
    const result = await _autofixDeps.runQualityCommand({
      commandName: resolved.commandName,
      command: resolved.command,
      workdir: ctx.workdir,
      storyId: ctx.story.id,
    });
    logMechanicalFixResult(ctx, resolved, result.exitCode);
  }
}

function resolveMechanicalFixCommands(
  ctx: PipelineContext,
  failedCheckNames: Set<ReviewCheckName>,
): ResolvedFixCommand[] {
  if (!failedCheckNames.has("lint")) return [];
  const scopeFiles = collectLintScopeFiles(ctx.reviewResult?.checks ?? []);
  return [resolveFixCommand(ctx, "lintFix", scopeFiles), resolveFixCommand(ctx, "formatFix", scopeFiles)].filter(
    (cmd): cmd is ResolvedFixCommand => cmd !== undefined,
  );
}

function resolveFixCommand(
  ctx: PipelineContext,
  commandName: FixCommandName,
  scopeFiles: string[] | undefined,
): ResolvedFixCommand | undefined {
  const broad = resolveBroadFixCommand(ctx, commandName);
  const template = resolveScopedFixTemplate(ctx, commandName);
  if (!broad && !template) return undefined;
  if (!scopeFiles) return warnAndUseFullFix(ctx, commandName, broad, "missing_lint_scope");
  if (scopeFiles.length === 0) return logEmptyFixScope(ctx, commandName, broad ?? template ?? "");
  if (template) {
    return {
      commandName,
      command: template.replaceAll("{{files}}", scopeFiles.map(shellQuotePath).join(" ")),
      scoped: true,
    };
  }
  if (!broad) return undefined;
  const derived = deriveScopedFixCommand(broad, scopeFiles);
  if (derived) return { commandName, command: derived, scoped: true };
  return warnAndUseFullFix(ctx, commandName, broad, "unsupported_scoped_command_shape");
}

function collectLintScopeFiles(checks: readonly ReviewCheckResult[]): string[] | undefined {
  const lintChecks = checks.filter((check) => check.check === "lint" && !check.success);
  if (lintChecks.length === 0) return undefined;
  if (lintChecks.some((check) => !check.lintScope)) return undefined;
  if (lintChecks.some((check) => check.lintScope?.status === "degraded")) return undefined;
  const files = lintChecks.flatMap((check) => check.lintScope?.packageGroups.flatMap((group) => group.files) ?? []);
  return [...new Set(files)];
}

function resolveBroadFixCommand(ctx: PipelineContext, commandName: FixCommandName): string | undefined {
  return commandName === "lintFix"
    ? (ctx.config.quality.commands.lintFix ?? ctx.config.review.commands.lintFix)
    : (ctx.config.quality.commands.formatFix ?? ctx.config.review.commands.formatFix);
}

function hasMechanicalFixCommand(ctx: PipelineContext): boolean {
  return (["lintFix", "formatFix"] as const).some(
    (name) => resolveBroadFixCommand(ctx, name) ?? resolveScopedFixTemplate(ctx, name),
  );
}

function resolveScopedFixTemplate(ctx: PipelineContext, commandName: FixCommandName): string | undefined {
  return commandName === "lintFix"
    ? (ctx.config.review.commands.lintFixScoped ?? ctx.config.quality.commands.lintFixScoped)
    : (ctx.config.review.commands.formatFixScoped ?? ctx.config.quality.commands.formatFixScoped);
}

function deriveScopedFixCommand(command: string, files: readonly string[]): string | undefined {
  const trimmed = command.trim();
  const supportedTools = ["eslint", "biome", "ruff", "flake8", "prettier"];
  const isSupported =
    supportedTools.some((tool) => trimmed === tool || trimmed.startsWith(`${tool} `)) ||
    supportedTools.some((tool) => trimmed.startsWith(`bunx ${tool}`));
  if (!isSupported) return undefined;
  return `${command} ${files.map(shellQuotePath).join(" ")}`;
}

function shellQuotePath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function logEmptyFixScope(ctx: PipelineContext, commandName: FixCommandName, command: string): ResolvedFixCommand {
  getLogger().info("autofix", `${toScopeLogPrefix(commandName)}_scope_empty`, { storyId: ctx.story.id });
  return { commandName, command, scoped: true, skipped: true };
}

function warnAndUseFullFix(
  ctx: PipelineContext,
  commandName: FixCommandName,
  command: string | undefined,
  reason: string,
): ResolvedFixCommand {
  getLogger().warn("autofix", `${toScopeLogPrefix(commandName)}_scope_degraded`, { storyId: ctx.story.id, reason });
  if (!command) return { commandName, command: "", scoped: false, skipped: true };
  return { commandName, command, scoped: false };
}

function toScopeLogPrefix(commandName: FixCommandName): "lint_fix" | "format_fix" {
  return commandName === "lintFix" ? "lint_fix" : "format_fix";
}

function logMechanicalFixResult(ctx: PipelineContext, resolved: ResolvedFixCommand, exitCode: number): void {
  const logger = getLogger();
  logger.debug("autofix", `${resolved.commandName} exit=${exitCode}`, {
    storyId: ctx.story.id,
    command: resolved.command,
    scoped: resolved.scoped,
  });
  if (exitCode !== 0) {
    logger.warn("autofix", `${resolved.commandName} command failed — may not have fixed all issues`, {
      storyId: ctx.story.id,
      exitCode,
    });
  }
}

/**
 * Injectable deps for testing.
 */
export const _autofixDeps = {
  runQualityCommand,
  recheckReview,
  runAgentRectification,
  runReviewStage,
  runTestWriterRectification: (
    ctx: PipelineContext,
    testWriterChecks: ReviewCheckResult[],
    story: UserStory,
    agentManager: import("../../agents").IAgentManager,
  ): Promise<number> => runTestWriterRectification(ctx, testWriterChecks, story, agentManager),
};
