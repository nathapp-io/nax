/**
 * Semantic Review Runner
 *
 * Runs an LLM-based semantic review against the git diff for a story.
 * Validates behavior — checks that the implementation satisfies the
 * story's acceptance criteria. Code quality (lint, style, conventions)
 * is handled by lint/typecheck, not semantic review.
 *
 * Decomposed per code-review TYPE-1 (2026-08-17): the orchestrator below stays a
 * thin sequence of stages — skip checks, debate/dispatch, finding classification,
 * outcome — with each stage's logic and its audit-recording extracted into named
 * helpers in ./semantic-outcomes.ts. Control-flow order and every side effect
 * (logging, `recordSemanticAudit` calls) are preserved exactly; only the
 * grouping (and file) changed.
 */

import type { IAgentManager } from "../agents";
import type { ReviewConfig } from "../config/selectors";
import type { ContextBundle } from "../context/engine";
import type { DebateRunnerOptions } from "../debate";
import { DebateRunner } from "../debate";
import { NaxError } from "../errors";
import type { Iteration } from "../findings";
import { getSafeLogger } from "../logger";
import { callOp as _callOp } from "../operations/call";
import type { SemanticReviewInput, SemanticReviewOutput } from "../operations/semantic-review";
import { semanticReviewOp } from "../operations/semantic-review";
import type { CallContext } from "../operations/types";
import { ReviewPromptBuilder } from "../prompts";
import type { NaxRuntime } from "../runtime";
import type { ResolvedTestPatterns } from "../test-runners";
import type { NaxIgnoreIndex } from "../utils/path-filters";
import { prepareSemanticReviewInput } from "./prepare-inputs";
import { writeReviewAudit } from "./review-audit";
import { runSemanticDebate } from "./semantic-debate";
import type { SemanticOutcomeCtx } from "./semantic-outcomes";
import {
  buildAcIndexDroppedFailClosedResult,
  buildBlockingFailureResult,
  buildFeatureCtxBlock,
  buildPassedResult,
  catchDispatchFailure,
  classifySemanticFindings,
  handleRetryExhaustedFailOpen,
  handleTruncatedLooksLikeFail,
  skipResult,
} from "./semantic-outcomes";
import type { ReviewCheckResult, SemanticReviewConfig, SemanticStory } from "./types";

// Re-export so existing callers (`import type { SemanticStory } from "./semantic"`) keep working.
export type { SemanticStory };

/** Injectable dependencies for semantic.ts — allows tests to mock without mock.module() */
export const _semanticDeps: {
  createDebateRunner: (opts: DebateRunnerOptions) => DebateRunner;
  writeReviewAudit: typeof writeReviewAudit;
  /**
   * Monomorphic on purpose: this module dispatches exactly one op, so the
   * inferred generic signature over-stated the seam and no stub could satisfy
   * it without a cast (#1514 callop-seam).
   */
  callOp: (ctx: CallContext, op: typeof semanticReviewOp, input: SemanticReviewInput) => Promise<SemanticReviewOutput>;
} = {
  createDebateRunner: (opts: DebateRunnerOptions): DebateRunner => new DebateRunner(opts),
  writeReviewAudit,
  callOp: _callOp,
};

export interface RunSemanticReviewOptions {
  workdir: string;
  storyGitRef: string | undefined;
  story: SemanticStory;
  semanticConfig: SemanticReviewConfig;
  agentManager: IAgentManager | undefined;
  naxConfig?: ReviewConfig;
  featureName?: string;
  priorSemanticIterations?: Iteration[];
  blockingThreshold?: "error" | "warning" | "info";
  featureContextMarkdown?: string;
  contextBundle?: ContextBundle;
  projectDir?: string;
  naxIgnoreIndex?: NaxIgnoreIndex;
  runtime?: NaxRuntime;
  /**
   * Resolved test-file patterns (ADR-009 SSOT) — keeps a finding about a test
   * file in the test lane (#1368). Mirrors `runAdversarialReview`.
   */
  resolvedTestPatterns?: ResolvedTestPatterns;
}

/**
 * Run a semantic review using an LLM against the story diff.
 */
export async function runSemanticReview(opts: RunSemanticReviewOptions): Promise<ReviewCheckResult> {
  const {
    workdir,
    storyGitRef,
    story,
    semanticConfig,
    agentManager,
    naxConfig,
    featureName,
    priorSemanticIterations,
    blockingThreshold,
    featureContextMarkdown,
    contextBundle,
    projectDir,
    naxIgnoreIndex,
    runtime,
    resolvedTestPatterns,
  } = opts;
  const startTime = Date.now();
  const logger = getSafeLogger();
  // #1368 — a semantic finding about a test file stays in the test lane. Semantic
  // findings otherwise default to `fixTarget: "source"`, which hands them to an
  // implementer that may not edit test files. Matches nothing when patterns are
  // absent, preserving the pre-#1368 lane.
  const testFilePatterns = resolvedTestPatterns?.regex ?? [];
  const testFileMatch = (file: string): boolean => testFilePatterns.some((re) => re.test(file));

  if (featureName === undefined) {
    logger?.debug("semantic", "featureName missing — semantic session name will not include feature", {
      storyId: story.id,
    });
  }

  // @design: BUG-114 + issue #1120: collection logic lives in prepare-inputs.ts (SSOT).
  // Both this legacy/reconciliation path and the orchestrator path (plan-inputs.ts)
  // call prepareSemanticReviewInput so they cannot drift.
  const prepared = await prepareSemanticReviewInput({
    workdir,
    projectDir,
    storyId: story.id,
    storyGitRef,
    config: naxConfig,
    naxIgnoreIndex,
    semanticConfig,
  });

  if (prepared.skipReason === "no git ref") {
    return skipResult("skipped: no git ref", startTime);
  }

  const diffMode = semanticConfig.diffMode ?? "ref";
  logger?.info("review", "Running semantic check", {
    storyId: story.id,
    model: semanticConfig.model,
    diffMode,
    configProvided: !!naxConfig,
  });

  if (prepared.skipReason === "no changes detected") {
    return skipResult("skipped: no changes detected", startTime);
  }
  if (prepared.skipReason === "no production code changes") {
    return skipResult("skipped: no production code changes", startTime);
  }

  // biome-ignore lint/style/noNonNullAssertion: skipReason undefined ⇒ effectiveRef present
  const effectiveRef = prepared.effectiveRef!;
  const stat = prepared.stat;
  const diff = prepared.diff;
  const excludePatterns = prepared.excludePatterns;

  // ADR-019: runtime is the canonical source for agentManager. The parameter
  // is kept for backward compatibility but ignored — callers should pass
  // runtime.agentManager instead.
  const effectiveAgentManager = runtime?.agentManager ?? agentManager;
  if (!effectiveAgentManager) {
    logger?.warn("semantic", "No agent available for semantic review — skipping", {
      storyId: story.id,
      model: semanticConfig.model,
    });
    return skipResult("skipped: no agent available for model tier", startTime);
  }

  // Build feature context block for the prompt.
  const featureCtxBlock = buildFeatureCtxBlock(contextBundle, featureContextMarkdown);

  // Build prompt — mode determines whether diff is embedded or reviewer self-serves via tools.
  const basePrompt = new ReviewPromptBuilder().buildSemanticReviewPrompt(story, semanticConfig, {
    mode: diffMode,
    diff,
    storyGitRef: effectiveRef,
    stat,
    priorSemanticIterations,
    excludePatterns: semanticConfig.excludePatterns,
  });
  const prompt = featureCtxBlock ? `${featureCtxBlock}${basePrompt}` : basePrompt;

  // Debate path: when debate is enabled for review stage, use DebateRunner instead of agent.complete()
  const reviewDebateEnabled = naxConfig?.debate?.enabled && naxConfig?.debate?.stages?.review?.enabled;
  const requoteEnabled = semanticConfig.substantiation?.requote ?? true;
  const skipDebateForRequote = reviewDebateEnabled && diffMode === "ref" && requoteEnabled;
  if (skipDebateForRequote) {
    logger?.warn(
      "review",
      "Semantic debate skipped: ref-mode requote recovery requires the normal sessioned review path",
      {
        storyId: story.id,
        diffMode,
      },
    );
  }
  if (reviewDebateEnabled && !skipDebateForRequote) {
    if (!runtime) {
      throw new NaxError("runtime required for debate path — legacy standalone path removed", "DISPATCH_NO_RUNTIME", {
        stage: "review-semantic-debate",
        storyId: story.id,
      });
    }
    if (!naxConfig) {
      throw new NaxError(
        "naxConfig required for debate path — reviewDebateEnabled implies naxConfig is present",
        "CONFIG_MISSING",
        { stage: "review-semantic-debate", storyId: story.id },
      );
    }
    return runSemanticDebate({
      naxConfig,
      runtime,
      workdir,
      agentManager: effectiveAgentManager,
      featureName,
      story,
      diffMode,
      diff,
      stat,
      semanticConfig,
      effectiveRef,
      startTime,
      prompt,
      productionExcludePatterns: excludePatterns,
      blockingThreshold,
      isTestFile: testFileMatch,
      createDebateRunner: _semanticDeps.createDebateRunner,
    });
  }

  // ADR-019 Pattern A: dispatch via callOp so the hop routes through
  // AgentManager.runWithFallback + buildHopCallback, firing the middleware chain
  // (audit, cost, cancellation) and managing session lifecycle explicitly via
  // openSession + runAsSession × N + closeSession. The semanticReviewOp hopBody
  // handles the same-session JSON-parse retry.
  if (!runtime) {
    throw new NaxError(
      "runtime required — legacy agentManager.run path removed (ADR-019 Wave 3, issue #762)",
      "DISPATCH_NO_RUNTIME",
      { stage: "review-semantic", storyId: story.id },
    );
  }

  const outcomeCtx: SemanticOutcomeCtx = {
    runtime,
    workdir,
    projectDir,
    storyId: story.id,
    featureName,
    blockingThreshold,
    startTime,
    logger,
    testFileMatch,
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
  // costAggregator directly. ReviewCheckResult.cost is 0 for pipeline-managed
  // reviews; per-stage cost roll-up is the trade-off for ADR-019 session-lifecycle
  // ownership. Track in follow-up if per-check cost breakdown is needed.
  let opResult: SemanticReviewOutput;
  try {
    opResult = await _semanticDeps.callOp(callCtx, semanticReviewOp, {
      workdir,
      repoRoot: projectDir ?? workdir,
      story,
      semanticConfig,
      mode: diffMode,
      diff,
      storyGitRef: effectiveRef,
      stat,
      priorSemanticIterations,
      excludePatterns,
      featureCtxBlock,
      blockingThreshold,
    });
  } catch (err) {
    return catchDispatchFailure(err, outcomeCtx);
  }
  if (opResult.failOpen) return handleRetryExhaustedFailOpen(outcomeCtx);
  if (opResult.looksLikeFail) return handleTruncatedLooksLikeFail(outcomeCtx);
  if (opResult.repromptEvent) {
    runtime.dispatchEvents.emitReviewReprompt({
      kind: "review-reprompt-on-drop",
      storyId: story.id,
      reviewer: "semantic",
      dropCount: opResult.repromptEvent.dropCount,
      repromptOutcome: opResult.repromptEvent.outcome,
      costUsd: opResult.repromptEvent.costUsd,
    });
  }

  const classification = classifySemanticFindings(opResult, blockingThreshold);
  const { allFindings, blockingFindings, advisoryFindings } = classification;

  if (advisoryFindings.length > 0) {
    logger?.debug(
      "review",
      `Semantic review: ${advisoryFindings.length} advisory findings (below threshold '${classification.threshold}')`,
      {
        storyId: story.id,
        findings: advisoryFindings.map((f) => ({ severity: f.severity, file: f.file, issue: f.issue })),
      },
    );
  }

  const durationMs = Date.now() - startTime;

  if (blockingFindings.length > 0) {
    return buildBlockingFailureResult(outcomeCtx, classification, durationMs);
  }

  if (!opResult.passed && allFindings.length === 0) {
    return buildAcIndexDroppedFailClosedResult(outcomeCtx, classification, durationMs);
  }

  // passed — either the model passed with no blocking findings, or there were no findings at all
  return buildPassedResult(outcomeCtx, classification, durationMs);
}
