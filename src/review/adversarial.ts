/**
 * Adversarial Review Runner (REVIEW-003)
 *
 * Runs an LLM-based adversarial review against the story diff.
 * Distinct cognitive stance from semantic review:
 *   - Semantic asks: "Does this satisfy the acceptance criteria?"
 *   - Adversarial asks: "Where does this break? What is missing?"
 *
 * Key differences from semantic runner:
 *   - No debate path — adversarial review is always one-shot.
 *   - Own ACP session (reviewer-adversarial), NOT the implementer session.
 *   - Default diffMode is "ref" (no 50KB cap; reviewer self-serves via git tools).
 *   - Findings carry a `category` field (input, error-path, abandonment, etc.).
 *
 * Decomposed per code-review TYPE-0 (2026-08-17): the orchestrator below stays a
 * thin sequence of stages — skip checks, dispatch, finding classification,
 * telemetry, outcome — with each stage's logic and its audit-recording extracted
 * into named helpers in ./adversarial-outcomes.ts. Control-flow order and every
 * side effect (logging, `recordAdversarialAudit` calls) are preserved exactly;
 * only the grouping (and file) changed.
 */

import type { IAgentManager } from "../agents";
import type { ReviewConfig } from "../config/selectors";
import type { ContextBundle } from "../context/engine";
import { NaxError } from "../errors";
import type { Iteration } from "../findings";
import { getSafeLogger } from "../logger";
import type { AdversarialReviewOutput } from "../operations/adversarial-review";
import { adversarialReviewOp } from "../operations/adversarial-review";
import { callOp as _callOp } from "../operations/call";
import type { NaxRuntime } from "../runtime";
import type { ResolvedTestPatterns } from "../test-runners";
import type { NaxIgnoreIndex } from "../utils/path-filters";
import { buildCounterfactualTelemetry } from "./adversarial-counterfactual-telemetry";
import type { AdversarialOutcomeCtx } from "./adversarial-outcomes";
import {
  buildBlockingFailureResult,
  buildFeatureCtxBlock,
  buildHallucinatedAcQuoteResult,
  buildPassedResult,
  buildUngroundedFailClosedResult,
  catchDispatchFailure,
  classifyAdversarialFindings,
  handleRetryExhaustedFailOpen,
  handleTruncatedLooksLikeFail,
  resolveDiffFileSet,
  skipResult,
} from "./adversarial-outcomes";
import { collectDiffFileList as _collectDiffFileList } from "./diff-utils";
import { prepareAdversarialReviewInput } from "./prepare-inputs";
import { writeReviewAudit } from "./review-audit";
import type { AdversarialReviewConfig, ReviewCheckResult, SemanticStory } from "./types";

/** Injectable dependencies for adversarial.ts — allows tests to mock without mock.module() */
export const _adversarialDeps = {
  writeReviewAudit,
  callOp: _callOp,
  collectDiffFileList: _collectDiffFileList,
};

export interface RunAdversarialReviewOptions {
  workdir: string;
  storyGitRef: string | undefined;
  story: SemanticStory;
  adversarialConfig: AdversarialReviewConfig;
  agentManager: IAgentManager | undefined;
  config?: ReviewConfig;
  featureName?: string;
  priorFailures?: Array<{ stage: string; modelTier: string }>;
  blockingThreshold?: "error" | "warning" | "info";
  featureContextMarkdown?: string;
  contextBundle?: ContextBundle;
  projectDir?: string;
  naxIgnoreIndex?: NaxIgnoreIndex;
  runtime?: NaxRuntime;
  priorAdversarialIterations?: Iteration[];
  resolvedTestPatterns?: ResolvedTestPatterns;
}

/**
 * Run an adversarial review using an LLM against the story diff.
 * Ships off by default — enabled only when "adversarial" is in review.checks.
 */
export async function runAdversarialReview(opts: RunAdversarialReviewOptions): Promise<ReviewCheckResult> {
  const {
    workdir,
    storyGitRef,
    story,
    adversarialConfig,
    agentManager,
    config: naxConfig,
    featureName,
    blockingThreshold,
    featureContextMarkdown,
    contextBundle,
    projectDir,
    naxIgnoreIndex,
    runtime,
    priorAdversarialIterations,
    resolvedTestPatterns,
  } = opts;
  const startTime = Date.now();
  const logger = getSafeLogger();

  // @design: BUG-114 + issue #1120: collection logic lives in prepare-inputs.ts (SSOT).
  const prepared = await prepareAdversarialReviewInput({
    workdir,
    projectDir,
    storyId: story.id,
    storyGitRef,
    config: naxConfig,
    naxIgnoreIndex,
    adversarialConfig,
  });

  if (prepared.skipReason === "no git ref") {
    return skipResult("skipped: no git ref", startTime);
  }

  const diffMode = adversarialConfig.diffMode ?? "ref";
  logger?.info("review", "Running adversarial check", {
    storyId: story.id,
    model: adversarialConfig.model,
    diffMode,
  });

  if (prepared.skipReason === "no changes detected") {
    return skipResult("skipped: no changes detected", startTime);
  }
  if (prepared.skipReason === "no code changes") {
    return skipResult("skipped: no code changes", startTime);
  }

  // biome-ignore lint/style/noNonNullAssertion: skipReason undefined ⇒ effectiveRef present
  const effectiveRef = prepared.effectiveRef!;
  const stat = prepared.stat;
  const diff = prepared.diff;
  const testInventory = prepared.testInventory;
  const effectiveRefExcludePatterns = prepared.refExcludePatterns;
  const testGlobs = prepared.testGlobs;

  // ADR-019: runtime is the canonical source for agentManager. The parameter
  // is kept for backward compatibility but ignored — callers should pass
  // runtime.agentManager instead.
  const effectiveAgentManager = runtime?.agentManager ?? agentManager;
  if (!effectiveAgentManager) {
    logger?.warn("adversarial", "No agent available for adversarial review — skipping", {
      storyId: story.id,
      model: adversarialConfig.model,
    });
    return skipResult("skipped: no agent available for model tier", startTime);
  }

  // Build feature context block for the prompt.
  const featureCtxBlock = buildFeatureCtxBlock(contextBundle, featureContextMarkdown);

  // ADR-019 Pattern A: dispatch via callOp so the hop routes through
  // AgentManager.runWithFallback + buildHopCallback, firing the middleware chain
  // and managing session lifecycle explicitly. The adversarialReviewOp hopBody
  // handles the same-session JSON-parse retry.
  if (!runtime) {
    throw new NaxError(
      "runtime required — legacy agentManager.run path removed (ADR-019 Wave 3, issue #762)",
      "DISPATCH_NO_RUNTIME",
      { stage: "review-adversarial", storyId: story.id },
    );
  }

  const outcomeCtx: AdversarialOutcomeCtx = {
    runtime,
    workdir,
    projectDir,
    storyId: story.id,
    featureName,
    blockingThreshold: blockingThreshold ?? "error",
    startTime,
    logger,
  };

  const callCtx = {
    runtime,
    packageView: runtime.packages.resolve(workdir),
    packageDir: workdir,
    agentName: effectiveAgentManager.getDefault(),
    storyId: story.id,
    featureName,
    contextBundle,
  };

  // NOTE: llmCost stays 0 on the runtime path — buildHopCallback charges cost via
  // costAggregator. ReviewCheckResult.cost is 0 for pipeline-managed reviews.
  let opResult: AdversarialReviewOutput;
  try {
    opResult = await _adversarialDeps.callOp(callCtx, adversarialReviewOp, {
      workdir,
      repoRoot: projectDir ?? workdir,
      story,
      adversarialConfig,
      mode: diffMode,
      diff,
      storyGitRef: effectiveRef,
      stat,
      testInventory,
      excludePatterns: adversarialConfig.excludePatterns,
      testGlobs,
      featureCtxBlock,
      priorAdversarialIterations,
      blockingThreshold,
      refExcludePatterns: effectiveRefExcludePatterns,
      resolvedTestPatterns,
    });
  } catch (err) {
    return catchDispatchFailure(err, outcomeCtx);
  }
  if (opResult.failOpen) return handleRetryExhaustedFailOpen(outcomeCtx);
  if (opResult.looksLikeFail) return handleTruncatedLooksLikeFail(outcomeCtx);

  // Emit review-reprompt-on-drop telemetry if hopBody executed a reprompt.
  if (opResult.repromptEvent) {
    runtime.dispatchEvents.emitReviewReprompt({
      kind: "review-reprompt-on-drop",
      storyId: story.id,
      reviewer: "adversarial",
      dropCount: opResult.repromptEvent.dropCount,
      repromptOutcome: opResult.repromptEvent.outcome,
      costUsd: opResult.repromptEvent.costUsd,
    });
  }

  const classification = classifyAdversarialFindings(
    opResult,
    blockingThreshold,
    priorAdversarialIterations,
    adversarialConfig,
    resolvedTestPatterns,
  );
  const { threshold, blockingFindings, advisoryFindings, acDropped } = classification;

  // Issue #986 — build diff file set for structural counterfactual telemetry.
  const { diffFiles, diffAvailable } = await resolveDiffFileSet(
    diff,
    workdir,
    projectDir,
    effectiveRef,
    naxIgnoreIndex,
    _adversarialDeps.collectDiffFileList,
  );

  const { adversarialDropAnalysis, adversarialAcceptAnalysis } = buildCounterfactualTelemetry({
    acDropped,
    blockingFindings,
    acceptanceCriteria: story.acceptanceCriteria,
    diffFiles,
  });

  if (advisoryFindings.length > 0) {
    logger?.debug(
      "review",
      `Adversarial review: ${advisoryFindings.length} advisory findings (below threshold '${threshold}')`,
      {
        storyId: story.id,
        findings: advisoryFindings.map((f) => ({
          severity: f.severity,
          category: f.category,
          file: f.file,
          issue: f.issue,
        })),
      },
    );
  }

  const durationMs = Date.now() - startTime;
  const telemetry = { adversarialDropAnalysis, adversarialAcceptAnalysis };

  if (blockingFindings.length > 0) {
    return buildBlockingFailureResult(outcomeCtx, classification, telemetry, diffAvailable, durationMs);
  }

  // #1378 — MODEL verdict, not `opResult.passed`: the latter now honours blockingThreshold,
  // so a surviving sub-threshold finding would skip both branches — waving through blocking
  // concerns the model could not ground (Case B) and losing the demoted drops (Case A).
  if (!opResult.modelPassed && acDropped.length > 0) {
    if (acDropped.every((d) => d.code === "ac_quote_not_substring")) {
      return buildHallucinatedAcQuoteResult(outcomeCtx, classification, telemetry, diffAvailable, durationMs);
    }
    return buildUngroundedFailClosedResult(outcomeCtx, classification, telemetry, diffAvailable, durationMs);
  }

  // passed — either the model passed with no blocking findings, or only advisory
  // findings remained after filtering and there were no AC-grounding drops.
  return buildPassedResult(outcomeCtx, classification, telemetry, diffAvailable, durationMs);
}
