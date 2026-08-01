/**
 * Semantic Review Runner
 *
 * Runs an LLM-based semantic review against the git diff for a story.
 * Validates behavior — checks that the implementation satisfies the
 * story's acceptance criteria. Code quality (lint, style, conventions)
 * is handled by lint/typecheck, not semantic review.
 */

import type { IAgentManager } from "../agents";
import type { ReviewConfig } from "../config/selectors";
import { filterContextByRole } from "../context";
import { DebateRunner } from "../debate";
import type { DebateRunnerOptions } from "../debate";
import { NaxError } from "../errors";
import type { Iteration } from "../findings";
import { getSafeLogger } from "../logger";
import { callOp as _callOp } from "../operations/call";
import { semanticReviewOp } from "../operations/semantic-review";
import { ReviewPromptBuilder } from "../prompts";
import type { NaxIgnoreIndex } from "../utils/path-filters";
import { llmFindingsToReviewFindings } from "./finding-projection";
import { prepareSemanticReviewInput } from "./prepare-inputs";
import { writeReviewAudit } from "./review-audit";
import { runSemanticDebate } from "./semantic-debate";
import { type LLMFinding, formatFindings, isBlockingSeverity, toReviewFindings } from "./semantic-helpers";
import type { ReviewAck, ReviewCheckResult, SemanticReviewConfig, SemanticStory } from "./types";

// Re-export so existing callers (`import type { SemanticStory } from "./semantic"`) keep working.
export type { SemanticStory };

/** Injectable dependencies for semantic.ts — allows tests to mock without mock.module() */
export const _semanticDeps = {
  createDebateRunner: (opts: DebateRunnerOptions): DebateRunner => new DebateRunner(opts),
  writeReviewAudit,
  callOp: _callOp,
};

function recordSemanticAudit(opts: {
  runtime?: import("../runtime").NaxRuntime;
  workdir: string;
  projectDir?: string;
  storyId: string;
  featureName?: string;
  parsed: boolean;
  looksLikeFail?: boolean;
  failOpen?: boolean;
  passed?: boolean;
  blockingThreshold?: "error" | "warning" | "info";
  result: { passed: boolean; findings: unknown[] } | null;
  advisoryFindings?: unknown[];
  /** #1423 — prior findings resolved or withdrawn, recorded outside `result.findings`. */
  acks?: ReviewAck[];
}): void {
  opts.runtime?.dispatchEvents.emitReviewDecision({
    kind: "review-decision",
    reviewer: "semantic",
    workdir: opts.workdir,
    projectDir: opts.projectDir,
    storyId: opts.storyId,
    featureName: opts.featureName,
    timestamp: Date.now(),
    parsed: opts.parsed,
    looksLikeFail: opts.looksLikeFail,
    failOpen: opts.failOpen,
    passed: opts.passed,
    blockingThreshold: opts.blockingThreshold,
    result: opts.result,
    advisoryFindings: opts.advisoryFindings,
    acks: opts.acks,
  });
}

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
  contextBundle?: import("../context/engine").ContextBundle;
  projectDir?: string;
  naxIgnoreIndex?: NaxIgnoreIndex;
  runtime?: import("../runtime").NaxRuntime;
  /**
   * Resolved test-file patterns (ADR-009 SSOT) — keeps a finding about a test
   * file in the test lane (#1368). Mirrors `runAdversarialReview`.
   */
  resolvedTestPatterns?: import("../test-runners").ResolvedTestPatterns;
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
    return {
      check: "semantic",
      success: true,
      command: "",
      exitCode: 0,
      output: "skipped: no git ref",
      durationMs: Date.now() - startTime,
    };
  }

  const diffMode = semanticConfig.diffMode ?? "ref";
  logger?.info("review", "Running semantic check", {
    storyId: story.id,
    model: semanticConfig.model,
    diffMode,
    configProvided: !!naxConfig,
  });

  if (prepared.skipReason === "no changes detected") {
    return {
      check: "semantic",
      success: true,
      command: "",
      exitCode: 0,
      output: "skipped: no changes detected",
      durationMs: Date.now() - startTime,
    };
  }
  if (prepared.skipReason === "no production code changes") {
    return {
      check: "semantic",
      success: true,
      command: "",
      exitCode: 0,
      output: "skipped: no production code changes",
      durationMs: Date.now() - startTime,
    };
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
    return {
      check: "semantic",
      success: true,
      command: "",
      exitCode: 0,
      output: "skipped: no agent available for model tier",
      durationMs: Date.now() - startTime,
    };
  }

  // Build feature context block for the prompt.
  // When a v2 ContextBundle is provided, use its pushMarkdown directly — the orchestrator
  // already applied role filtering and dedup, so the v1 filterContextByRole() pass is
  // skipped (it would silently drop ##-section content from v2's rendered output).
  let featureCtxBlock = "";
  if (contextBundle) {
    const md = contextBundle.pushMarkdown.trim();
    if (md) featureCtxBlock = `${md}\n\n---\n\n`;
  } else if (featureContextMarkdown) {
    const filtered = filterContextByRole(featureContextMarkdown, "reviewer-semantic");
    if (filtered.trim()) featureCtxBlock = `${filtered}\n\n---\n\n`;
  }

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

  // NOTE: llmCost stays 0 on the runtime path — buildHopCallback charges cost via
  // costAggregator directly. ReviewCheckResult.cost is 0 for pipeline-managed
  // reviews; per-stage cost roll-up is the trade-off for ADR-019 session-lifecycle
  // ownership. Track in follow-up if per-check cost breakdown is needed.
  const llmCost = 0;

  const callCtx = {
    runtime,
    packageView: runtime.packages.resolve(workdir),
    packageDir: workdir,
    agentName: effectiveAgentManager.getDefault(),
    storyId: story.id,
    featureName,
    contextBundle,
  };
  let opResult: import("../operations/semantic-review").SemanticReviewOutput;
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
    logger?.warn("semantic", "LLM call failed — fail-open", { storyId: story.id, cause: String(err) });
    recordSemanticAudit({
      runtime,
      workdir,
      projectDir,
      storyId: story.id,
      featureName,
      parsed: false,
      looksLikeFail: false,
      failOpen: true,
      passed: true,
      blockingThreshold,
      result: null,
    });
    return {
      check: "semantic",
      success: true,
      failOpen: true,
      command: "",
      exitCode: 0,
      output: `skipped: LLM call failed — ${String(err)}`,
      durationMs: Date.now() - startTime,
    };
  }
  if (opResult.failOpen) {
    logger?.warn("semantic", "Retry exhausted — fail-open", { storyId: story.id });
    recordSemanticAudit({
      runtime,
      workdir,
      projectDir,
      storyId: story.id,
      featureName,
      parsed: false,
      looksLikeFail: false,
      failOpen: true,
      passed: true,
      blockingThreshold,
      result: null,
    });
    return {
      check: "semantic",
      success: true,
      failOpen: true,
      command: "",
      exitCode: 0,
      output: "semantic review: could not parse LLM response (fail-open)",
      durationMs: Date.now() - startTime,
    };
  }
  if (opResult.looksLikeFail) {
    logger?.warn("semantic", "LLM returned truncated JSON with passed:false — treating as failure", {
      storyId: story.id,
    });
    recordSemanticAudit({
      runtime,
      workdir,
      projectDir,
      storyId: story.id,
      featureName,
      parsed: false,
      looksLikeFail: true,
      failOpen: false,
      passed: false,
      blockingThreshold,
      result: null,
    });
    return {
      check: "semantic",
      success: false,
      command: "",
      exitCode: 1,
      output: "semantic review: LLM response truncated but indicated failure (passed:false found in partial response)",
      durationMs: Date.now() - startTime,
    };
  }
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
  // verify() has already run the full filter pipeline (sanitize → substantiate → AC-ground → split).
  // opResult.findings = accepted findings (blocking + advisory); opResult.normalizedFindings = blocking only.
  // opResult.passed preserves the model verdict after filtering so wrappers can
  // still fail-closed when passed:false survives without remaining blockers.
  const threshold = blockingThreshold ?? "error";
  const allFindings = opResult.findings as LLMFinding[];
  // #1423 — carry-forward bookkeeping, recorded alongside findings but never as one.
  const acks = opResult.acks;
  const blockingFindings = allFindings.filter((f) => isBlockingSeverity(f.severity, threshold));
  const advisoryFindings = allFindings.filter((f) => !isBlockingSeverity(f.severity, threshold));

  if (advisoryFindings.length > 0) {
    logger?.debug(
      "review",
      `Semantic review: ${advisoryFindings.length} advisory findings (below threshold '${threshold}')`,
      {
        storyId: story.id,
        findings: advisoryFindings.map((f) => ({ severity: f.severity, file: f.file, issue: f.issue })),
      },
    );
  }

  const durationMs = Date.now() - startTime;

  if (blockingFindings.length > 0) {
    logger?.warn("review", `Semantic review failed: ${blockingFindings.length} blocking findings`, {
      storyId: story.id,
      durationMs,
    });
    logger?.debug("review", "Semantic review findings", {
      storyId: story.id,
      findings: blockingFindings.map((f) => ({
        severity: f.severity,
        file: f.file,
        line: f.line,
        issue: f.issue,
        suggestion: f.suggestion,
      })),
    });
    const output = `Semantic review failed:\n\n${formatFindings(blockingFindings)}`;
    recordSemanticAudit({
      runtime,
      workdir,
      projectDir,
      storyId: story.id,
      featureName,
      parsed: true,
      failOpen: false,
      passed: false,
      blockingThreshold: threshold,
      acks,
      result: {
        passed: false,
        findings: llmFindingsToReviewFindings(allFindings, { source: "semantic-review", isTestFile: testFileMatch }),
      },
      advisoryFindings:
        advisoryFindings.length > 0
          ? llmFindingsToReviewFindings(advisoryFindings, { source: "semantic-review", isTestFile: testFileMatch })
          : undefined,
    });
    return {
      check: "semantic",
      success: false,
      command: "",
      exitCode: 1,
      output,
      durationMs,
      findings: toReviewFindings(blockingFindings, { isTestFile: testFileMatch }),
      advisoryFindings:
        advisoryFindings.length > 0 ? toReviewFindings(advisoryFindings, { isTestFile: testFileMatch }) : undefined,
      cost: llmCost,
    };
  }

  if (!opResult.passed && allFindings.length === 0) {
    logger?.warn("review", "Semantic review fail-closed: blocking findings dropped (acIndex invalid)", {
      storyId: story.id,
      durationMs,
    });
    recordSemanticAudit({
      runtime,
      workdir,
      projectDir,
      storyId: story.id,
      featureName,
      parsed: true,
      acks,
      failOpen: false,
      passed: false,
      blockingThreshold: threshold,
      result: { passed: false, findings: [] },
      advisoryFindings:
        advisoryFindings.length > 0
          ? llmFindingsToReviewFindings(advisoryFindings, { source: "semantic-review", isTestFile: testFileMatch })
          : undefined,
    });
    return {
      check: "semantic",
      success: false,
      command: "",
      exitCode: 1,
      output:
        'Semantic review failed: blocking finding(s) were dropped — acIndex was missing or out of range. The model emitted "passed: false" without valid AC attribution.',
      durationMs,
      advisoryFindings:
        advisoryFindings.length > 0 ? toReviewFindings(advisoryFindings, { isTestFile: testFileMatch }) : undefined,
      cost: llmCost,
    };
  }

  // passed — either the model passed with no blocking findings, or there were no findings at all
  logger?.info("review", "Semantic review passed", { storyId: story.id, durationMs });
  recordSemanticAudit({
    runtime,
    workdir,
    projectDir,
    storyId: story.id,
    featureName,
    parsed: true,
    acks,
    failOpen: false,
    passed: true,
    blockingThreshold: threshold,
    result: {
      passed: true,
      findings: llmFindingsToReviewFindings(allFindings, { source: "semantic-review", isTestFile: testFileMatch }),
    },
    advisoryFindings:
      advisoryFindings.length > 0
        ? llmFindingsToReviewFindings(advisoryFindings, { source: "semantic-review", isTestFile: testFileMatch })
        : undefined,
  });
  return {
    check: "semantic",
    success: true,
    command: "",
    exitCode: 0,
    output:
      allFindings.length === 0
        ? "Semantic review passed"
        : "Semantic review passed (all findings were advisory — below blocking threshold)",
    durationMs,
    advisoryFindings:
      advisoryFindings.length > 0 ? toReviewFindings(advisoryFindings, { isTestFile: testFileMatch }) : undefined,
    cost: llmCost,
  };
}
