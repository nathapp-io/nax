/**
 * decideStageAction — branch handlers (cognitive-complexity drain B1).
 *
 * `decideStageAction` in `./post-run` is the SEQUENCER: it evaluates the
 * policy decision tree's branch predicates in the original order and
 * delegates each branch to one handler here. BRANCH ORDER IS BEHAVIOUR —
 * the sequencer must consult these branches exactly in the order the
 * original monolith did:
 *
 *   1. rectification-exhausted (three exits + TDD-rollback fall-through)
 *   2. self-verification failure → escalate
 *   3. pauseReason → pause (with notify)
 *   4. TDD failure → rollback + human-review pause / routeTddFailure
 *   5. merge-conflict trigger → operator check, may fail the story
 *   6. generic session failure → escalate with derived reason
 *   7. success → auto-commit (non-TDD only) + roll-forward + continue
 *
 * The `_postRunDeps` test-injection seam STAYS defined in `./post-run`
 * (`src/execution/index.ts` re-exports it by reference for tests to
 * mutate). Every handler receives it BY REFERENCE on its frame and reads
 * `deps.X` at call time, so a test's property reassignment before
 * `decideStageAction` runs still lands. This module imports `./post-run`
 * TYPE-ONLY — a runtime import would cycle straight back to the seam.
 */

import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Finding } from "../findings/types";
import { isTriggerEnabled } from "../interaction/triggers";
import { getLogger } from "../logger";
import { fullSuiteGateOp } from "../operations";
import { routeTddFailure } from "../pipeline/stages/execution-helpers";
import type { PipelineContext, StageResult } from "../pipeline/types";
import { isBlockingSeverity } from "../review/severity";
import { cleanupSessionOnFailure as cleanupSessionOnFailureImpl } from "./lifecycle/post-run-session-cleanup";
import type { CaptureParsedSummary } from "./lifecycle/test-baseline-capture";
import { invokeRollForwardFromContext } from "./lifecycle/test-baseline-capture";
import { inspectOscillationBreaker } from "./oscillation-breaker";
import type { _postRunDeps, InspectionOptions, PostRunInspectionResult, TddMode } from "./post-run";
import { sendPostRunNotification } from "./post-run-notifications";
import { maybeHandleRecurrenceBreaker } from "./recurrence-pause";
import type { StoryOrchestratorResult } from "./story-orchestrator";
import type { FailureCategory } from "./types";

/** The `_postRunDeps` shape — the live object is passed by reference. */
type PostRunDeps = typeof _postRunDeps;

/** Everything a branch handler needs, fixed for one decideStageAction call. */
export interface DecideFrame {
  readonly ctx: PipelineContext;
  readonly planResult: StoryOrchestratorResult;
  readonly inspection: PostRunInspectionResult;
  readonly opts: InspectionOptions;
  readonly deps: PostRunDeps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch predicates (named — the decision table's left column)
// ─────────────────────────────────────────────────────────────────────────────

/** Rectification ran to exhaustion and left findings behind. */
export function hasRectificationExhaustion(
  planResult: StoryOrchestratorResult,
): planResult is StoryOrchestratorResult & {
  unfixedFindings: NonNullable<StoryOrchestratorResult["unfixedFindings"]>;
} {
  return !!(planResult.rectificationExhausted && planResult.unfixedFindings && planResult.unfixedFindings.length > 0);
}

/** This is a TDD-strategy story whose plan run failed. */
export function isTddFailure(opts: InspectionOptions, planResult: StoryOrchestratorResult): boolean {
  return opts.tddMode !== null && !planResult.success;
}

/** TDD rollbackEnabled + an isolation violation — the only rollback-on-failure pair. */
export function shouldRollbackTddFailure(
  tddMode: TddMode | null,
  failureCategory: FailureCategory | undefined,
): boolean {
  return tddMode?.rollbackEnabled === true && failureCategory === "isolation-violation";
}

/**
 * Leftover findings at or above the run's blocking threshold. Missing
 * severity is treated as "error" (blocking) so a real defect is never
 * silently swallowed.
 */
function blockingUnfixedFindings(
  findings: readonly Finding[],
  blockingThreshold: "error" | "warning" | "info",
): readonly Finding[] {
  return findings.filter((f) =>
    isBlockingSeverity((f as { severity?: string }).severity ?? "error", blockingThreshold),
  );
}

/** Distinct finding sources — undefined (untyped source) entries preserved as-is. */
function collectFindingSources(findings: readonly Finding[]): Set<string | undefined> {
  return new Set(findings.map((f) => (f as { source?: string }).source));
}

/** Every leftover came from lint/typecheck — style-only errors, not real defects. */
function isAllMechanical(sources: Set<string | undefined>): boolean {
  return [...sources].every((s) => s === "lint" || s === "typecheck");
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared failure-side helper
// ─────────────────────────────────────────────────────────────────────────────

// `cleanupSessionOnFailure` body lives in `./lifecycle/post-run-session-cleanup`
// (US-002 — same split post-run.ts uses). The shim binds the frame's
// `deps.failAndClose` — the same `_postRunDeps.failAndClose` binding the
// sequencer's own shim bound before this extraction.
async function cleanupSessionOnFailure(deps: PostRunDeps, ctx: PipelineContext): Promise<void> {
  await cleanupSessionOnFailureImpl(ctx, deps.failAndClose);
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch 1 — rectification exhausted
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Route an exhausted rectification cycle. Returns a StageResult when the
 * story exits here (advisory-only continue, mechanical-only continue, or
 * the blocking-leftover escalate/breaker-pause path); returns `null` when
 * the original fell through to the TDD-rollback routing below.
 */
export async function routeRectificationExhaustion(frame: DecideFrame): Promise<StageResult | null> {
  const { ctx, planResult, inspection, opts, deps } = frame;
  const logger = getLogger();
  const shouldRollback = shouldRollbackTddFailure(opts.tddMode, inspection.failureCategory);

  // Mechanical-only failure: if rectification exhausted but all unfixed findings are from
  // mechanical sources (lint/typecheck), and any configured LLM reviews ran and passed
  // (the resume block in the orchestrator runs reviews even when mechanical findings are
  // unfixed — see story-orchestrator.ts mechanicalOnlyExhausted), proceed rather than
  // escalating. Reviews absent from phaseOutputs means they were not configured (OK).
  if (hasRectificationExhaustion(planResult)) {
    // Advisory-only escape: if NONE of the remaining unfixed findings meet the
    // run's blocking threshold, the story is functionally green — do not fail it
    // on sub-blocking leftovers. This covers findings that no fix strategy can
    // claim (e.g. `source:"plugin"`, which no `appliesTo` matches) which would
    // otherwise force a `no-strategy` cycle exit into a hard story failure even
    // though every gate (tests/lint/typecheck/semantic/adversarial) passed.
    // Note this escape is threshold-relative: it does not fire when a project
    // sets `review.blockingThreshold` at or below the leftover's severity, so it
    // is a backstop — not a licence to mint findings no strategy can claim.
    // Missing severity is treated as "error" (blocking) so a real defect is
    // never silently swallowed. Mirrors the severity-based blocking/advisory
    // partition used by the review layer (isBlockingSeverity).
    const blockingThreshold = ctx.config?.review?.blockingThreshold ?? "error";
    const blockingUnfixed = blockingUnfixedFindings(planResult.unfixedFindings, blockingThreshold);
    if (blockingUnfixed.length === 0) {
      logger.warn(
        "execution",
        "Rectification exhausted but all unfixed findings are advisory (below blocking threshold) — proceeding",
        {
          storyId: ctx.story.id,
          blockingThreshold,
          unfixedCount: planResult.unfixedFindings.length,
          unfixedSources: [...collectFindingSources(planResult.unfixedFindings)],
        },
      );
      return { action: "continue" };
    }

    const sources = collectFindingSources(planResult.unfixedFindings);
    const allMechanical = isAllMechanical(sources);
    if (allMechanical) {
      logger.warn("execution", "Mechanical-only failure unfixable — proceeding (style-only errors remain)", {
        storyId: ctx.story.id,
      });
      return { action: "continue" };
    }

    if (!(opts.tddMode !== null && shouldRollback)) {
      const findingSourceNames = [...sources].filter((source): source is string => typeof source === "string");
      logger.error("execution", "Rectification exhausted with unfixed findings", {
        storyId: ctx.story.id,
        findingsCount: planResult.unfixedFindings.length,
        findingSources: findingSourceNames,
        ...(planResult.unresolvedDetail ? { unresolvedDetail: planResult.unresolvedDetail } : {}),
      });
      await cleanupSessionOnFailure(deps, ctx);
      // US-002 rectification oscillation circuit-breaker. When the same story
      // re-runs the orchestration and a resolved finding source keeps
      // reappearing across attempts, the operator
      // would otherwise see only a silent money-drain as the breaker-less
      // escalator re-runs the same story tier-after-tier. The runtime Map is
      // accumulated by the increment site in runRectification; reading it
      // here is fail-open — if the runtime or config is missing, we escalate
      // exactly as before.
      const breaker = inspectOscillationBreaker(ctx);
      if (breaker.trip) {
        return oscillationPause(ctx, breaker);
      }
      // Cross-attempt review-recurrence circuit-breaker (#1666 Part C). Distinct from
      // the oscillation breaker above: that one catches within-cycle ping-pong, this one
      // catches a reviewer (semantic or adversarial) raising the SAME finding again on a
      // LATER escalation attempt — the shape #1666 Part B enables by letting
      // adversarial-review run even when semantic-review fails.
      const recurrencePause = await maybeHandleRecurrenceBreaker(ctx, logger);
      if (recurrencePause) return recurrencePause;
      return { action: "escalate", reason: exhaustedEscalationReason(planResult.unresolvedDetail) };
    }
  }

  return null;
}

/** The escalate reason for an exhausted cycle — carries the agent's own diagnosis when it gave one. */
function exhaustedEscalationReason(unresolvedDetail: string | undefined): string {
  return unresolvedDetail
    ? `Rectification exhausted: ${unresolvedDetail}`
    : "Rectification exhausted with unfixed findings";
}

/** Notify (best-effort) that the oscillation breaker paused the story, then return its pause. */
async function oscillationPause(
  ctx: PipelineContext,
  breaker: ReturnType<typeof inspectOscillationBreaker>,
): Promise<StageResult> {
  const logger = getLogger();
  logger.warn("execution", "Rectification oscillation circuit-breaker paused story", {
    storyId: ctx.story.id,
    oscillationCount: breaker.count,
    maxOscillations: breaker.maxOscillations,
  });
  if (ctx.interaction) {
    try {
      await ctx.interaction.send({
        id: `oscillation-${ctx.story.id}-${Date.now()}`,
        type: "notify",
        featureName: ctx.featureDir ? (ctx.featureDir.split("/").pop() ?? "unknown") : "unknown",
        storyId: ctx.story.id,
        stage: "execution",
        summary: `Oscillation paused: ${ctx.story.id}`,
        detail: `Story: ${ctx.story.title}\nReason: ${breaker.reason}`,
        fallback: "continue",
        createdAt: Date.now(),
      });
    } catch (notifyErr) {
      logger.warn("execution", "Failed to send oscillation pause notification", {
        storyId: ctx.story.id,
        error: errorMessage(notifyErr),
      });
    }
  }
  return { action: "pause", reason: breaker.reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch 2 — self-verification failure
// ─────────────────────────────────────────────────────────────────────────────

/** Self-verification failure → escalate. */
export function selfVerificationEscalation(frame: DecideFrame): StageResult {
  const { ctx } = frame;
  const logger = getLogger();
  logger.warn("execution", "Self-verification reported explicit failure", {
    storyId: ctx.story.id,
    lint: ctx.selfVerification?.lint,
    typecheck: ctx.selfVerification?.typecheck,
  });
  return { action: "escalate", reason: "Self-verification reported lint/typecheck failure" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch 3 — pauseReason
// ─────────────────────────────────────────────────────────────────────────────

/** pauseReason → pause (with optional notify). */
export async function pauseForReason(frame: DecideFrame, pauseReason: string): Promise<StageResult> {
  const { ctx } = frame;
  const logger = getLogger();
  logger.warn("execution", "Plan run produced pauseReason", { storyId: ctx.story.id, pauseReason });
  await sendPostRunNotification(ctx, {
    idPrefix: "pause",
    summary: `Execution paused: ${ctx.story.id}`,
    detail: `Story: ${ctx.story.title}\nReason: ${pauseReason}`,
    failureMessage: "Failed to send pause notification",
  });
  return { action: "pause", reason: pauseReason };
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch 4 — TDD failure routing
// ─────────────────────────────────────────────────────────────────────────────

/** TDD failure → isolation rollback (only) + route. */
export async function routeTddFailureBranch(frame: DecideFrame): Promise<StageResult> {
  const { ctx, inspection, opts, deps } = frame;
  const logger = getLogger();
  const failureCategory = inspection.failureCategory;
  const isLiteMode = opts.tddMode?.isLite ?? false;
  const shouldRollback = shouldRollbackTddFailure(opts.tddMode, failureCategory);

  if (shouldRollback && opts.initialRef) {
    try {
      await deps.rollbackToRef(ctx.workdir, opts.initialRef, opts.untrackedBefore);
      logger.info("execution", "Rolled back git changes due to TDD failure", {
        storyId: ctx.story.id,
        failureCategory,
      });
    } catch (rollbackErr) {
      logger.error("execution", "Failed to rollback git changes after TDD failure", {
        storyId: ctx.story.id,
        error: errorMessage(rollbackErr),
      });
    }
  }

  if (inspection.needsHumanReview && !inspection.providerUnavailable) {
    logger.warn("execution", "Human review needed", { storyId: ctx.story.id, failureCategory });
    await sendPostRunNotification(ctx, {
      idPrefix: "human-review",
      summary: `Human review needed: ${ctx.story.id}`,
      detail: `Story: ${ctx.story.title}\nReason: Human review needed\nCategory: ${failureCategory ?? "unknown"}`,
      failureMessage: "Failed to send human review notification",
    });
    return { action: "pause", reason: `Human review needed: ${failureCategory ?? "unknown"}` };
  }

  return routeTddFailure(failureCategory, isLiteMode, ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch 5 — merge-conflict trigger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge-conflict trigger: detect in the output, then let the operator elect
 * to proceed or stop. Returns the fail result when the story aborts, `null`
 * to fall through. Guard order is behaviour: detect → interaction present →
 * trigger enabled.
 */
export async function failOnMergeConflict(frame: DecideFrame): Promise<StageResult | null> {
  const { ctx, inspection, deps } = frame;
  const logger = getLogger();
  if (!deps.detectMergeConflict(inspection.combinedOutput)) return null;
  if (!ctx.interaction) return null;
  if (!isTriggerEnabled("merge-conflict", ctx.config)) return null;

  const shouldProceed = await deps.checkMergeConflict(
    { featureName: ctx.prd.feature, storyId: ctx.story.id },
    ctx.config,
    ctx.interaction,
  );
  if (!shouldProceed) {
    logger.error("execution", "Merge conflict detected — aborting story", { storyId: ctx.story.id });
    await cleanupSessionOnFailure(deps, ctx);
    return { action: "fail", reason: "Merge conflict detected" };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch 6 — generic session failure
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phases that reported an explicit `passed: false` / `success: false` — the
 * failure log's per-phase attribution (absent keys mean no explicit signal).
 */
function collectFailedPhases(
  planResult: StoryOrchestratorResult,
): Record<string, { passed?: boolean; success?: boolean; findingsCount?: number }> {
  const failedPhases: Record<string, { passed?: boolean; success?: boolean; findingsCount?: number }> = {};
  for (const [name, output] of Object.entries(planResult.phaseOutputs)) {
    if (!output || typeof output !== "object") continue;
    const r = output as Record<string, unknown>;
    const passed = typeof r.passed === "boolean" ? r.passed : undefined;
    const success = typeof r.success === "boolean" ? r.success : undefined;
    const explicitFail = passed === false || success === false;
    if (!explicitFail) continue;
    const findings = Array.isArray(r.findings) ? r.findings.length : undefined;
    failedPhases[name] = { passed, success, findingsCount: findings };
  }
  return failedPhases;
}

/** The escalate reason: exit code, category, rate-limit flag, and failed phase names. */
function buildFailureReason(
  agentResult: PostRunInspectionResult["agentResult"],
  failureCategory: FailureCategory | undefined,
  failedPhases: Record<string, { passed?: boolean; success?: boolean; findingsCount?: number }>,
): string {
  const failedPhaseNames = Object.keys(failedPhases);
  const reasonParts: string[] = [];
  reasonParts.push(`agent session failed (exit ${agentResult.exitCode ?? "?"})`);
  if (failureCategory) reasonParts.push(`category=${failureCategory}`);
  if (agentResult.rateLimited) reasonParts.push("rate-limited");
  if (failedPhaseNames.length > 0) reasonParts.push(`phases=${failedPhaseNames.join(",")}`);
  return reasonParts.join("; ");
}

/** Generic (non-TDD-routed) session failure → log attribution + escalate. */
export async function escalateFailedSession(frame: DecideFrame): Promise<StageResult> {
  const { ctx, planResult, inspection, deps } = frame;
  const logger = getLogger();
  const { agentResult, failureCategory } = inspection;
  const failedPhases = collectFailedPhases(planResult);
  const stderrTail = ((agentResult as { stderr?: string }).stderr ?? "").slice(-500);
  const outputTail = (agentResult.output ?? "").slice(-500);
  logger.error("execution", "Agent session failed", {
    storyId: ctx.story.id,
    exitCode: agentResult.exitCode,
    rateLimited: agentResult.rateLimited,
    failureCategory: failureCategory ?? "unknown",
    failedPhases: Object.keys(failedPhases).length > 0 ? failedPhases : undefined,
    stderrTail: stderrTail || undefined,
    outputTail: outputTail || undefined,
  });
  await cleanupSessionOnFailure(deps, ctx);
  return { action: "escalate", reason: buildFailureReason(agentResult, failureCategory, failedPhases) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch 7 — success tail
// ─────────────────────────────────────────────────────────────────────────────

/** Non-TDD success → auto-commit. */
export async function autoCommitIfNeeded(frame: DecideFrame): Promise<void> {
  if (frame.opts.tddMode !== null) return;
  const { workdir, story, runtime } = frame.ctx;
  await frame.deps.autoCommitIfDirty(workdir, "execution", "single-session", story.id, runtime?.dirtyWorktrees);
}

// US-002 — sequential story completion persists the next story's roll-forward baseline.
// Single delegated call (600-line gate); the helper resolves next-story-id and gate summary.
// The helper swallows disk / permission throws internally so a passing
// story's success path is never aborted by a baseline write failure.
export async function persistRollForward(frame: DecideFrame): Promise<void> {
  const { ctx, planResult } = frame;
  await invokeRollForwardFromContext({
    root: ctx.projectDir,
    featureId: ctx.featureDir ? (ctx.featureDir.split("/").pop() ?? ctx.prd.feature) : ctx.prd.feature,
    userStories: ctx.prd.userStories,
    currentStoryId: ctx.story.id,
    isParallelMode: ctx.skipPrdPersistence === true,
    gateSummary: (planResult.phaseOutputs[fullSuiteGateOp.name] as { parsedSummary?: CaptureParsedSummary } | undefined)
      ?.parsedSummary,
  });
}
