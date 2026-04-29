/**
 * Semantic Review Runner
 *
 * Runs an LLM-based semantic review against the git diff for a story.
 * Validates behavior — checks that the implementation satisfies the
 * story's acceptance criteria. Code quality (lint, style, conventions)
 * is handled by lint/typecheck, not semantic review.
 */

import type { IAgentManager } from "../agents";
import { DEFAULT_CONFIG } from "../config";
import type { NaxConfig } from "../config";
import { filterContextByRole } from "../context";
import { DebateRunner } from "../debate";
import type { DebateRunnerOptions } from "../debate";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import { callOp } from "../operations/call";
import { semanticReviewOp } from "../operations/semantic-review";
import { ReviewPromptBuilder } from "../prompts";
import { resolveReviewExcludePatterns, resolveTestFilePatterns } from "../test-runners";
import type { NaxIgnoreIndex } from "../utils/path-filters";
import { DIFF_CAP_BYTES, collectDiff, collectDiffStat, resolveEffectiveRef, truncateDiff } from "./diff-utils";
import { writeReviewAudit } from "./review-audit";
import { runSemanticDebate } from "./semantic-debate";
import { substantiateSemanticEvidence } from "./semantic-evidence";
import {
  type LLMFinding,
  type LLMResponse,
  formatFindings,
  isBlockingSeverity,
  sanitizeRefModeFindings,
  toReviewFindings,
} from "./semantic-helpers";
import type { ReviewCheckResult, SemanticReviewConfig, SemanticStory } from "./types";

// Re-export so existing callers (`import type { SemanticStory } from "./semantic"`) keep working.
export type { SemanticStory };

/** Injectable dependencies for semantic.ts — allows tests to mock without mock.module() */
export const _semanticDeps = {
  createDebateRunner: (opts: DebateRunnerOptions): DebateRunner => new DebateRunner(opts),
  writeReviewAudit,
};

/**
 * Run a semantic review using an LLM against the story diff.
 */
export async function runSemanticReview(
  workdir: string,
  storyGitRef: string | undefined,
  story: SemanticStory,
  semanticConfig: SemanticReviewConfig,
  agentManager: IAgentManager | undefined,
  naxConfig?: NaxConfig,
  featureName?: string,
  resolverSession?: import("./dialogue").ReviewerSession,
  priorFailures?: Array<{ stage: string; modelTier: string }>,
  blockingThreshold?: "error" | "warning" | "info",
  featureContextMarkdown?: string,
  contextBundle?: import("../context/engine").ContextBundle,
  projectDir?: string,
  naxIgnoreIndex?: NaxIgnoreIndex,
  runtime?: import("../runtime").NaxRuntime,
): Promise<ReviewCheckResult> {
  const startTime = Date.now();
  const logger = getSafeLogger();

  if (featureName === undefined) {
    logger?.debug("semantic", "featureName missing — semantic session name will not include feature", {
      storyId: story.id,
    });
  }

  // @design: BUG-114: Resolve effective git ref via shared fallback chain (diff-utils.ts).
  const effectiveRef = await resolveEffectiveRef(workdir, storyGitRef, story.id);

  if (!effectiveRef) {
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
    modelTier: semanticConfig.modelTier,
    diffMode,
    configProvided: !!naxConfig,
  });

  // Collect stat summary (used by both modes).
  // In embedded mode: also collect full diff, truncate if needed.
  // In ref mode: pass stat + ref to reviewer; reviewer self-serves the full diff via tools.
  const repoRoot = projectDir ?? workdir;
  const packageDir = workdir !== repoRoot ? workdir : undefined;
  const stat = await collectDiffStat(workdir, effectiveRef, { naxIgnoreIndex, packageDir });

  // ADR-009: resolve effective exclude patterns from config (falls back to DEFAULT_TEST_FILE_PATTERNS
  // when semanticConfig.excludePatterns is undefined — no behaviour change for default config).
  const resolved = await resolveTestFilePatterns(naxConfig ?? DEFAULT_CONFIG, workdir);
  const excludePatterns = [...resolveReviewExcludePatterns(semanticConfig.excludePatterns, resolved)];

  let diff: string | undefined;
  if (diffMode === "embedded") {
    const rawDiff = await collectDiff(workdir, effectiveRef, excludePatterns, { naxIgnoreIndex, packageDir });
    diff = truncateDiff(rawDiff, rawDiff.length > DIFF_CAP_BYTES ? stat : undefined);
    if (!diff) {
      return {
        check: "semantic",
        success: true,
        command: "",
        exitCode: 0,
        output: "skipped: no production code changes",
        durationMs: Date.now() - startTime,
      };
    }
  } else {
    // ref mode: if stat is empty there are no changes at all
    if (!stat) {
      return {
        check: "semantic",
        success: true,
        command: "",
        exitCode: 0,
        output: "skipped: no changes detected",
        durationMs: Date.now() - startTime,
      };
    }
  }

  if (!agentManager) {
    logger?.warn("semantic", "No agent available for semantic review — skipping", {
      storyId: story.id,
      modelTier: semanticConfig.modelTier,
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
    priorFailures,
    excludePatterns: semanticConfig.excludePatterns,
  });
  const prompt = featureCtxBlock ? `${featureCtxBlock}${basePrompt}` : basePrompt;

  // Debate path: when debate is enabled for review stage, use DebateRunner instead of agent.complete()
  const reviewDebateEnabled = naxConfig?.debate?.enabled && naxConfig?.debate?.stages?.review?.enabled;
  if (reviewDebateEnabled) {
    return runSemanticDebate({
      naxConfig,
      runtime,
      workdir,
      agentManager,
      featureName,
      story,
      resolverSession,
      diffMode,
      diff,
      stat,
      semanticConfig,
      effectiveRef,
      startTime,
      prompt,
      blockingThreshold,
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
    agentName: agentManager.getDefault(),
    storyId: story.id,
    featureName,
    contextBundle,
  };
  let opResult: import("../operations/semantic-review").SemanticReviewOutput;
  try {
    opResult = await callOp(callCtx, semanticReviewOp, {
      story,
      semanticConfig,
      mode: diffMode,
      diff,
      storyGitRef: effectiveRef,
      stat,
      priorFailures,
      excludePatterns,
      featureCtxBlock,
      blockingThreshold,
    });
  } catch (err) {
    logger?.warn("semantic", "LLM call failed — fail-open", { storyId: story.id, cause: String(err) });
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
    if (naxConfig?.review?.audit?.enabled) {
      void _semanticDeps.writeReviewAudit({
        reviewer: "semantic",
        sessionName: "",
        workdir,
        storyId: story.id,
        featureName,
        parsed: false,
        looksLikeFail: false,
        result: null,
      });
    }
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
    if (naxConfig?.review?.audit?.enabled) {
      void _semanticDeps.writeReviewAudit({
        reviewer: "semantic",
        sessionName: "",
        workdir,
        storyId: story.id,
        featureName,
        parsed: false,
        looksLikeFail: true,
        result: null,
      });
    }
    return {
      check: "semantic",
      success: false,
      command: "",
      exitCode: 1,
      output: "semantic review: LLM response truncated but indicated failure (passed:false found in partial response)",
      durationMs: Date.now() - startTime,
    };
  }
  const parsed: LLMResponse = { passed: opResult.passed, findings: opResult.findings as LLMFinding[] };

  const sanitizedFindings = await substantiateSemanticEvidence(
    sanitizeRefModeFindings(parsed.findings, diffMode),
    diffMode,
    workdir,
    story.id,
  );
  const sanitizedParsed: LLMResponse = { ...parsed, findings: sanitizedFindings };

  // Split findings by blocking threshold
  const threshold = blockingThreshold ?? "error";
  const blockingFindings = sanitizedParsed.findings.filter((f) => isBlockingSeverity(f.severity, threshold));
  const advisoryFindings = sanitizedParsed.findings.filter((f) => !isBlockingSeverity(f.severity, threshold));

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

  // Format findings and populate structured ReviewFinding[]
  if (!sanitizedParsed.passed && blockingFindings.length > 0) {
    const durationMs = Date.now() - startTime;
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
    return {
      check: "semantic",
      success: false,
      command: "",
      exitCode: 1,
      output,
      durationMs,
      findings: toReviewFindings(blockingFindings),
      advisoryFindings: advisoryFindings.length > 0 ? toReviewFindings(advisoryFindings) : undefined,
      cost: llmCost,
    };
  }

  // If LLM said failed but all findings are advisory (below threshold), override to pass
  if (!sanitizedParsed.passed && blockingFindings.length === 0) {
    const durationMs = Date.now() - startTime;
    logger?.info("review", "Semantic review passed (all findings below blocking threshold)", {
      storyId: story.id,
      durationMs,
    });
    return {
      check: "semantic",
      success: true,
      command: "",
      exitCode: 0,
      output: "Semantic review passed (all findings were advisory — below blocking threshold)",
      durationMs,
      advisoryFindings: advisoryFindings.length > 0 ? toReviewFindings(advisoryFindings) : undefined,
      cost: llmCost,
    };
  }

  const durationMs = Date.now() - startTime;
  if (sanitizedParsed.passed) {
    logger?.info("review", "Semantic review passed", { storyId: story.id, durationMs });
  }
  return {
    check: "semantic",
    success: sanitizedParsed.passed,
    command: "",
    exitCode: sanitizedParsed.passed ? 0 : 1,
    output: sanitizedParsed.passed ? "Semantic review passed" : "Semantic review failed (no findings)",
    durationMs,
    advisoryFindings: advisoryFindings.length > 0 ? toReviewFindings(advisoryFindings) : undefined,
    cost: llmCost,
  };
}
