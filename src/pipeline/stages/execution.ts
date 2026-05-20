/**
 * Execution Stage
 *
 * Assembles plan inputs, builds exactly one plan for the strategy, executes
 * plan.run() once, then performs read-only post-run inspection for verdict
 * extraction, failure categorization, rollback trigger, isolation surfacing,
 * and pauseReason handling.
 */

import { validateAgentForTier } from "../../agents";
import type { AgentAdapter, AgentResult } from "../../agents/types";
import { buildPlanForStrategy } from "../../execution/build-plan-for-strategy";
import type { PlanInputs } from "../../execution/plan-inputs";
import { failAndClose } from "../../execution/session-manager-runtime";
import type { StoryOrchestratorResult } from "../../execution/story-orchestrator";
import { buildInteractionBridge } from "../../interaction/bridge-builder";
import { checkMergeConflict, checkStoryAmbiguity, isTriggerEnabled } from "../../interaction/triggers";
import { getLogger } from "../../logger";
import { fullSuiteGateOp, greenfieldGateOp, implementerOp, testWriterOp, verifierOp } from "../../operations";
import type { CallContext } from "../../operations/types";
import { parseSelfVerificationMarker } from "../../quality";
import { appendScratchEntry } from "../../session/scratch-writer";
import { rollbackToRef } from "../../tdd/session-runner";
import type { FailureCategory } from "../../tdd/types";
import { resolveTestFilePatterns } from "../../test-runners/resolver";
import { errorMessage } from "../../utils/errors";
import { autoCommitIfDirty, captureGitRef, detectMergeConflict } from "../../utils/git";
import type { PipelineContext, PipelineStage, StageResult } from "../types";
import { isAmbiguousOutput, routeTddFailure } from "./execution-helpers";

// Re-export helpers so existing importers continue to work.
export { isAmbiguousOutput, resolveStoryWorkdir, routeTddFailure } from "./execution-helpers";

const TDD_STRATEGIES = new Set(["tdd-simple", "three-session-tdd", "three-session-tdd-lite"]);

function isTddStrategy(strategy: string): boolean {
  return TDD_STRATEGIES.has(strategy);
}

function hasReviewEscalation(story: import("../../prd").UserStory): boolean {
  return (story.priorFailures ?? []).some((f: { stage?: string }) => f.stage === "review");
}

/** Extract the first pauseReason from any phase output. */
function extractPauseReason(phaseOutputs: Record<string, unknown>): string | undefined {
  for (const output of Object.values(phaseOutputs)) {
    if (output !== null && typeof output === "object") {
      const record = output as Record<string, unknown>;
      if (typeof record.pauseReason === "string" && record.pauseReason) {
        return record.pauseReason;
      }
    }
  }
  return undefined;
}

/** Derive TDD failure category from phase outputs after plan.run(). */
function deriveTddFailureCategory(phaseOutputs: Record<string, unknown>): FailureCategory | undefined {
  // Test-writer failure → session-failure
  const testWriterOutput = phaseOutputs[testWriterOp.name] as { success?: boolean } | undefined;
  if (testWriterOutput?.success === false) {
    return "session-failure";
  }

  // Greenfield gate detected → greenfield-no-tests
  const greenfieldOutput = phaseOutputs[greenfieldGateOp.name] as { isGreenfield?: boolean } | undefined;
  if (greenfieldOutput?.isGreenfield === true) {
    return "greenfield-no-tests";
  }

  // Verifier failure → derive from verifier output
  const verifierOutput = phaseOutputs[verifierOp.name] as
    | {
        success?: boolean;
        failureCategory?: string;
      }
    | undefined;
  if (verifierOutput?.success === false) {
    if (verifierOutput.failureCategory) {
      return verifierOutput.failureCategory as FailureCategory;
    }
    return "tests-failing";
  }

  // Implementer failure → session-failure
  const implOutput = phaseOutputs[implementerOp.name] as { success?: boolean } | undefined;
  if (implOutput?.success === false) {
    return "session-failure";
  }

  return undefined;
}

export const executionStage: PipelineStage = {
  name: "execution",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // HARD FAILURE: No agent available — cannot proceed without an agent
    const defaultAgent = ctx.agentManager?.getDefault() ?? "claude";
    const agent = (ctx.agentGetFn ?? _executionDeps.getAgent)(defaultAgent);
    if (!agent) {
      return {
        action: "fail",
        reason: `Agent "${defaultAgent}" not found`,
      };
    }

    // HARD FAILURE: Missing prompt indicates pipeline misconfiguration
    if (!ctx.prompt) {
      return { action: "fail", reason: "Prompt not built (prompt stage skipped?)" };
    }

    // Validate agent supports the requested tier; clamp to first supported if not (issue #369)
    let effectiveTier = ctx.routing.modelTier;
    if (!_executionDeps.validateAgentForTier(agent, ctx.routing.modelTier)) {
      effectiveTier =
        (agent.capabilities.supportedTiers[0] as typeof ctx.routing.modelTier | undefined) ?? ctx.routing.modelTier;
      logger.debug("execution", "Agent tier mismatch — clamping to supported tier", {
        storyId: ctx.story.id,
        agentName: agent.name,
        requestedTier: ctx.routing.modelTier,
        effectiveTier,
        supportedTiers: agent.capabilities.supportedTiers,
      });
    }

    if (!ctx.packageView) {
      return { action: "fail", reason: "Package view unavailable for execution dispatch" };
    }

    const interactionBridge = buildInteractionBridge(ctx.interaction, {
      featureName: ctx.prd.feature,
      storyId: ctx.story.id,
      stage: "execution",
    });

    const callCtx: CallContext = {
      runtime: ctx.runtime,
      packageView: ctx.packageView,
      packageDir: ctx.workdir,
      agentName: ctx.routing.agent ?? defaultAgent,
      storyId: ctx.story.id,
      featureName: ctx.prd.feature,
      story: ctx.story,
      ...(interactionBridge ? { interactionBridge } : {}),
    };

    // Cost precedence: the orchestrator scopes phaseCosts authoritatively via
    // costAggregator.openScope(). This dispatchEvents subscription captures
    // response/tokenUsage for self-verification + metrics.
    let capturedTokenUsage: import("../../agents/cost").TokenUsage | undefined;
    let capturedResponse = "";
    let capturedCostUsd = 0;
    const unsubscribe =
      ctx.runtime.dispatchEvents?.onDispatch((event) => {
        if (event.tokenUsage) capturedTokenUsage = event.tokenUsage;
        if (event.response) capturedResponse = event.response;
        if (event.exactCostUsd !== undefined) capturedCostUsd += event.exactCostUsd;
        else if (event.estimatedCostUsd !== undefined) capturedCostUsd += event.estimatedCostUsd;
      }) ?? (() => {});

    const isTdd = isTddStrategy(ctx.routing.testStrategy);
    const isLiteMode = ctx.routing.testStrategy === "three-session-tdd-lite";
    const isFreshRun = (ctx.story.attempts ?? 0) === 0 && !hasReviewEscalation(ctx.story);

    if (isTdd) {
      logger.info("execution", `Starting TDD execution${isLiteMode ? " (lite)" : ""}`, {
        storyId: ctx.story.id,
        testStrategy: ctx.routing.testStrategy,
        isFreshRun,
      });
    }

    // Assemble typed plan inputs and build the execution plan
    const planInputs = await _executionDeps.buildPlanInputsFromPipelineCtx(ctx, isFreshRun, isTdd);
    const plan = buildPlanForStrategy(callCtx, ctx.story, ctx.config, ctx.routing.testStrategy, planInputs);

    // Capture initial git ref for TDD rollback before any writes
    const initialRef = isTdd ? ((await _executionDeps.captureGitRef(ctx.workdir)) ?? "HEAD") : null;
    const shouldRollbackOnFailure = isTdd && (ctx.config.tdd?.rollbackOnFailure ?? true);

    let planResult: StoryOrchestratorResult;
    try {
      planResult = await plan.run();
    } finally {
      unsubscribe();
    }

    // ── Post-run inspection ────────────────────────────────────────────────────
    return inspectPlanResult(ctx, planResult, {
      capturedTokenUsage,
      capturedResponse,
      capturedCostUsd,
      isTdd,
      isLiteMode,
      initialRef,
      shouldRollbackOnFailure,
    });
  },
};

interface InspectionOptions {
  capturedTokenUsage?: import("../../agents/cost").TokenUsage;
  capturedResponse: string;
  capturedCostUsd: number;
  isTdd: boolean;
  isLiteMode: boolean;
  initialRef: string | null;
  shouldRollbackOnFailure: boolean;
}

async function inspectPlanResult(
  ctx: PipelineContext,
  planResult: StoryOrchestratorResult,
  opts: InspectionOptions,
): Promise<StageResult> {
  const logger = getLogger();
  const { capturedTokenUsage, capturedResponse, capturedCostUsd, isTdd, isLiteMode } = opts;

  // Extract implementer output → ctx.agentResult
  const implementerOutput = planResult.phaseOutputs[implementerOp.name] as
    | {
        success: boolean;
        filesChanged?: string[];
        estimatedCostUsd?: number;
        durationMs?: number;
      }
    | undefined;

  const result: AgentResult = {
    success: implementerOutput?.success ?? false,
    estimatedCostUsd: capturedCostUsd || planResult.phaseCosts[implementerOp.name] || 0,
    rateLimited: false,
    output: capturedResponse,
    exitCode: implementerOutput?.success ? 0 : 1,
    durationMs: implementerOutput?.durationMs ?? planResult.durationMs,
    ...(capturedTokenUsage ? { tokenUsage: capturedTokenUsage } : {}),
  };
  ctx.agentResult = result;
  ctx.agentSwapCount = 0;

  // Propagate full-suite gate result so verify stage can skip redundant run (BUG-054)
  const fullSuiteGateOutput = planResult.phaseOutputs[fullSuiteGateOp.name] as { passed?: boolean } | undefined;
  if (fullSuiteGateOutput?.passed) {
    ctx.fullSuiteGatePassed = true;
  }

  // Self-verification from implementer output
  ctx.selfVerification = parseSelfVerificationMarker(result.output ?? "", ctx.workdir);
  const selfVerificationFailed = ctx.selfVerification.lint === "fail" || ctx.selfVerification.typecheck === "fail";

  // Write self-verification scratch entry
  if (ctx.config.context?.v2?.enabled && ctx.sessionScratchDir) {
    try {
      await appendScratchEntry(ctx.sessionScratchDir, {
        kind: "self-verification",
        timestamp: new Date().toISOString(),
        storyId: ctx.story.id,
        stage: "execution",
        role: "implementer",
        selfVerification: ctx.selfVerification,
        writtenByAgent: ctx.routing?.agent ?? ctx.agentManager?.getDefault() ?? "claude",
      });
    } catch (scratchErr) {
      logger.warn("execution", "Failed to write self-verification scratch entry — continuing", {
        storyId: ctx.story.id,
        error: errorMessage(scratchErr),
      });
    }
  }

  if (selfVerificationFailed) {
    logger.warn("execution", "Self-verification reported explicit failure", {
      storyId: ctx.story.id,
      lint: ctx.selfVerification.lint,
      typecheck: ctx.selfVerification.typecheck,
    });
    return { action: "escalate", reason: "Self-verification reported lint/typecheck failure" };
  }

  // Check for pauseReason from any phase output (AC3/AC4)
  const pauseReason = extractPauseReason(planResult.phaseOutputs);
  if (pauseReason) {
    logger.warn("execution", "Plan run produced pauseReason", { storyId: ctx.story.id, pauseReason });
    if (ctx.interaction) {
      try {
        await ctx.interaction.send({
          id: `pause-${ctx.story.id}-${Date.now()}`,
          type: "notify",
          featureName: ctx.featureDir ? (ctx.featureDir.split("/").pop() ?? "unknown") : "unknown",
          storyId: ctx.story.id,
          stage: "execution",
          summary: `Execution paused: ${ctx.story.id}`,
          detail: `Story: ${ctx.story.title}\nReason: ${pauseReason}`,
          fallback: "continue",
          createdAt: Date.now(),
        });
      } catch (notifyErr) {
        logger.warn("execution", "Failed to send pause notification", {
          storyId: ctx.story.id,
          error: String(notifyErr),
        });
      }
    }
    return { action: "pause", reason: pauseReason };
  }

  // TDD failure handling: categorize, rollback, route
  if (isTdd && !planResult.success) {
    const failureCategory = deriveTddFailureCategory(planResult.phaseOutputs);
    ctx.tddFailureCategory = failureCategory;

    // Rollback on TDD failure
    if (opts.shouldRollbackOnFailure && opts.initialRef) {
      try {
        await _executionDeps.rollbackToRef(ctx.workdir, opts.initialRef);
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

    // Session-level failure → human review needed
    const needsHumanReview = failureCategory === "session-failure";
    if (needsHumanReview) {
      logger.warn("execution", "Human review needed", {
        storyId: ctx.story.id,
        failureCategory,
      });
      if (ctx.interaction) {
        try {
          await ctx.interaction.send({
            id: `human-review-${ctx.story.id}-${Date.now()}`,
            type: "notify",
            featureName: ctx.featureDir ? (ctx.featureDir.split("/").pop() ?? "unknown") : "unknown",
            storyId: ctx.story.id,
            stage: "execution",
            summary: `Human review needed: ${ctx.story.id}`,
            detail: `Story: ${ctx.story.title}\nReason: Human review needed\nCategory: ${failureCategory ?? "unknown"}`,
            fallback: "continue",
            createdAt: Date.now(),
          });
        } catch (notifyErr) {
          logger.warn("execution", "Failed to send human review notification", {
            storyId: ctx.story.id,
            error: String(notifyErr),
          });
        }
      }
      return {
        action: "pause",
        reason: `Human review needed: ${failureCategory ?? "unknown"}`,
      };
    }

    return routeTddFailure(failureCategory, isLiteMode, ctx);
  }

  const combinedOutput = (result.output ?? "") + ((result as { stderr?: string }).stderr ?? "");

  // merge-conflict trigger: detect CONFLICT markers in agent output
  if (
    _executionDeps.detectMergeConflict(combinedOutput) &&
    ctx.interaction &&
    isTriggerEnabled("merge-conflict", ctx.config)
  ) {
    const shouldProceed = await _executionDeps.checkMergeConflict(
      { featureName: ctx.prd.feature, storyId: ctx.story.id },
      ctx.config,
      ctx.interaction,
    );
    if (!shouldProceed) {
      logger.error("execution", "Merge conflict detected — aborting story", { storyId: ctx.story.id });
      if (ctx.sessionManager && ctx.sessionId) {
        await _executionDeps.failAndClose(ctx.sessionManager, ctx.sessionId, ctx.agentGetFn);
      }
      return { action: "fail", reason: "Merge conflict detected" };
    }
  }

  if (!planResult.success) {
    logger.error("execution", "Agent session failed", {
      storyId: ctx.story.id,
      exitCode: result.exitCode,
      rateLimited: result.rateLimited,
    });
    if (result.rateLimited) {
      logger.warn("execution", "Rate limited — will retry", { storyId: ctx.story.id });
    }
    if (ctx.sessionManager && ctx.sessionId) {
      await _executionDeps.failAndClose(ctx.sessionManager, ctx.sessionId, ctx.agentGetFn);
    }
    return { action: "escalate" };
  }

  // story-ambiguity trigger: detect ambiguity signals in agent output
  if (
    result.success &&
    _executionDeps.isAmbiguousOutput(combinedOutput) &&
    ctx.interaction &&
    isTriggerEnabled("story-ambiguity", ctx.config)
  ) {
    const shouldContinue = await _executionDeps.checkStoryAmbiguity(
      { featureName: ctx.prd.feature, storyId: ctx.story.id, reason: "Agent output suggests ambiguity" },
      ctx.config,
      ctx.interaction,
    );
    if (!shouldContinue) {
      logger.warn("execution", "Story ambiguity detected — escalating story", { storyId: ctx.story.id });
      return { action: "escalate", reason: "Story ambiguity detected — needs clarification" };
    }
  }

  // @design: BUG-058: Auto-commit if agent left uncommitted changes (non-TDD)
  if (!isTdd) {
    await autoCommitIfDirty(ctx.workdir, "execution", "single-session", ctx.story.id);
  }

  logger.info("execution", "Agent session complete", {
    storyId: ctx.story.id,
    cost: result.estimatedCostUsd,
  });
  return { action: "continue" };
}

/**
 * Assemble typed PlanInputs from the current pipeline context.
 * Populates all slots that are eligible for the given strategy + run phase.
 * Separated for testability via _executionDeps injection.
 *
 * Note: Full extraction of this assembly into assemblePlanInputs() is Task 2.
 * For now this is an inline helper that replaces buildAndRunPlan's slot assembly.
 */
async function buildPlanInputsFromPipelineCtx(
  ctx: PipelineContext,
  isFreshRun: boolean,
  isTdd: boolean,
): Promise<PlanInputs> {
  const story = ctx.story;
  const config = ctx.config;

  const testWriterInput =
    isTdd && isFreshRun
      ? {
          story,
          contextMarkdown: ctx.prompt,
          featureContextMarkdown: ctx.featureContextMarkdown,
          constitution: ctx.constitution?.content,
        }
      : undefined;

  let greenfieldGateInput: import("../../execution/plan-inputs").PlanInputs["greenfieldGate"] = undefined;
  if (isTdd && isFreshRun) {
    const resolvedTestPatterns = await resolveTestFilePatterns(config, ctx.workdir);
    greenfieldGateInput = {
      story,
      workdir: ctx.workdir,
      resolvedTestPatterns,
    };
  }

  const implementerInput = {
    story,
    contextMarkdown: ctx.prompt,
    featureContextMarkdown: ctx.featureContextMarkdown,
    constitution: ctx.constitution?.content,
  };

  const fullSuiteGateInput = isTdd
    ? {
        story,
        workdir: ctx.workdir,
        featureName: ctx.prd.feature,
        projectDir: ctx.projectDir,
      }
    : undefined;

  const verifierInput = isTdd ? { story } : undefined;

  return {
    story,
    config,
    testWriter: testWriterInput,
    greenfieldGate: greenfieldGateInput,
    implementer: implementerInput,
    fullSuiteGate: fullSuiteGateInput,
    verifier: verifierInput,
  };
}

/** Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x). */
export const _executionDeps = {
  getAgent: (_name: string): AgentAdapter | undefined => undefined,
  validateAgentForTier,
  detectMergeConflict,
  checkMergeConflict,
  isAmbiguousOutput,
  checkStoryAmbiguity,
  failAndClose,
  captureGitRef,
  rollbackToRef,
  buildPlanInputsFromPipelineCtx,
};
