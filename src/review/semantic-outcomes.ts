/**
 * Outcome-building helpers for the semantic review runner.
 *
 * Split out of semantic.ts (TYPE-1, code review 2026-08-17) to keep the
 * runner under the 600-line file-size limit after decomposing the former
 * 461-line `runSemanticReview` monolith. Each function here reproduces,
 * unchanged, one stage of that original function — logging, audit
 * recording, and the exact `ReviewCheckResult` shape it used to build inline.
 */

import { filterContextByRole } from "../context";
import type { ContextBundle } from "../context/engine";
import type { Logger } from "../logger";
import type { SemanticReviewOutput } from "../operations/semantic-review";
import type { NaxRuntime } from "../runtime";
import { llmFindingsToReviewFindings } from "./finding-projection";
import { type LLMFinding, formatFindings, isBlockingSeverity, toReviewFindings } from "./semantic-helpers";
import type { ReviewAck, ReviewCheckResult } from "./types";

/** Fields every audit-recording outcome helper needs — a slice of RunSemanticReviewOptions plus derived run state. */
export interface SemanticOutcomeCtx {
  runtime: NaxRuntime;
  workdir: string;
  projectDir: string | undefined;
  storyId: string;
  featureName: string | undefined;
  /**
   * Raw, possibly-undefined caller option — deliberately NOT defaulted here.
   * Only the three pre-classification helpers below (catchDispatchFailure,
   * handleRetryExhaustedFailOpen, handleTruncatedLooksLikeFail) read this field,
   * and they must record the same `undefined` the caller passed (matching the
   * pre-decomposition behavior) rather than a defaulted "error" that would
   * change what's recorded in the audit event. Post-classification outcome
   * builders read the defaulted `classification.threshold` instead.
   */
  blockingThreshold: "error" | "warning" | "info" | undefined;
  startTime: number;
  logger: Logger | null;
  testFileMatch: (file: string) => boolean;
}

export function skipResult(output: string, startTime: number): ReviewCheckResult {
  return {
    check: "semantic",
    success: true,
    command: "",
    exitCode: 0,
    output,
    durationMs: Date.now() - startTime,
  };
}

export function buildFeatureCtxBlock(
  contextBundle: ContextBundle | undefined,
  featureContextMarkdown: string | undefined,
): string {
  // When a v2 ContextBundle is provided, use its pushMarkdown directly — the orchestrator
  // already applied role filtering and dedup, so the v1 filterContextByRole() pass is
  // skipped (it would silently drop ##-section content from v2's rendered output).
  if (contextBundle) {
    const md = contextBundle.pushMarkdown.trim();
    return md ? `${md}\n\n---\n\n` : "";
  }
  if (featureContextMarkdown) {
    const filtered = filterContextByRole(featureContextMarkdown, "reviewer-semantic");
    if (filtered.trim()) return `${filtered}\n\n---\n\n`;
  }
  return "";
}

export function recordSemanticAudit(opts: {
  runtime?: NaxRuntime;
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

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch — the three non-continuing outcomes (error, fail-open, truncated-fail)
// ─────────────────────────────────────────────────────────────────────────────

export function catchDispatchFailure(err: unknown, ctx: SemanticOutcomeCtx): ReviewCheckResult {
  const { runtime, workdir, projectDir, storyId, featureName, blockingThreshold, startTime, logger } = ctx;
  logger?.warn("semantic", "LLM call failed — fail-open", { storyId, cause: String(err) });
  recordSemanticAudit({
    runtime,
    workdir,
    projectDir,
    storyId,
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

export function handleRetryExhaustedFailOpen(ctx: SemanticOutcomeCtx): ReviewCheckResult {
  const { runtime, workdir, projectDir, storyId, featureName, blockingThreshold, startTime, logger } = ctx;
  logger?.warn("semantic", "Retry exhausted — fail-open", { storyId });
  recordSemanticAudit({
    runtime,
    workdir,
    projectDir,
    storyId,
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

export function handleTruncatedLooksLikeFail(ctx: SemanticOutcomeCtx): ReviewCheckResult {
  const { runtime, workdir, projectDir, storyId, featureName, blockingThreshold, startTime, logger } = ctx;
  logger?.warn("semantic", "LLM returned truncated JSON with passed:false — treating as failure", { storyId });
  recordSemanticAudit({
    runtime,
    workdir,
    projectDir,
    storyId,
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

// ─────────────────────────────────────────────────────────────────────────────
// Finding classification
// ─────────────────────────────────────────────────────────────────────────────

export interface SemanticClassification {
  threshold: "error" | "warning" | "info";
  allFindings: LLMFinding[];
  acks: SemanticReviewOutput["acks"];
  blockingFindings: LLMFinding[];
  advisoryFindings: LLMFinding[];
}

export function classifySemanticFindings(
  opResult: SemanticReviewOutput,
  blockingThreshold: "error" | "warning" | "info" | undefined,
): SemanticClassification {
  // verify() has already run the full filter pipeline (sanitize → substantiate → AC-ground → split).
  // opResult.findings = accepted findings (blocking + advisory); opResult.normalizedFindings = blocking only.
  // opResult.passed preserves the model verdict after filtering so wrappers can
  // still fail-closed when passed:false survives without remaining blockers.
  const threshold = blockingThreshold ?? "error";
  const allFindings = opResult.findings as LLMFinding[];
  const blockingFindings = allFindings.filter((f) => isBlockingSeverity(f.severity, threshold));
  const advisoryFindings = allFindings.filter((f) => !isBlockingSeverity(f.severity, threshold));
  return {
    threshold,
    allFindings,
    acks: opResult.acks, // #1423 — carry-forward bookkeeping, recorded alongside findings but never as one.
    blockingFindings,
    advisoryFindings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Outcome builders — blocking failure / AC-dropped fail-closed / passed
// ─────────────────────────────────────────────────────────────────────────────

export function buildBlockingFailureResult(
  ctx: SemanticOutcomeCtx,
  classification: SemanticClassification,
  durationMs: number,
): ReviewCheckResult {
  const { runtime, workdir, projectDir, storyId, featureName, logger, testFileMatch } = ctx;
  const { threshold, allFindings, acks, blockingFindings, advisoryFindings } = classification;

  logger?.warn("review", `Semantic review failed: ${blockingFindings.length} blocking findings`, {
    storyId,
    durationMs,
  });
  logger?.debug("review", "Semantic review findings", {
    storyId,
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
    storyId,
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
    cost: 0,
  };
}

export function buildAcIndexDroppedFailClosedResult(
  ctx: SemanticOutcomeCtx,
  classification: SemanticClassification,
  durationMs: number,
): ReviewCheckResult {
  const { runtime, workdir, projectDir, storyId, featureName, logger, testFileMatch } = ctx;
  const { threshold, acks, advisoryFindings } = classification;

  logger?.warn("review", "Semantic review fail-closed: blocking findings dropped (acIndex invalid)", {
    storyId,
    durationMs,
  });
  recordSemanticAudit({
    runtime,
    workdir,
    projectDir,
    storyId,
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
    cost: 0,
  };
}

/** Model passed with no blocking findings, or there were no findings at all. */
export function buildPassedResult(
  ctx: SemanticOutcomeCtx,
  classification: SemanticClassification,
  durationMs: number,
): ReviewCheckResult {
  const { runtime, workdir, projectDir, storyId, featureName, logger, testFileMatch } = ctx;
  const { threshold, allFindings, acks, advisoryFindings } = classification;

  logger?.info("review", "Semantic review passed", { storyId, durationMs });
  recordSemanticAudit({
    runtime,
    workdir,
    projectDir,
    storyId,
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
    cost: 0,
  };
}
