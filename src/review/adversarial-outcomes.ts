/**
 * Outcome-building helpers for the adversarial review runner (REVIEW-003).
 *
 * Split out of adversarial.ts (TYPE-0, code review 2026-08-17) to keep both
 * files under the 600-line file-size limit after decomposing the former
 * 507-line `runAdversarialReview` monolith. Each function here reproduces,
 * unchanged, one stage of that original function — logging, audit recording,
 * and the exact `ReviewCheckResult` shape it used to build inline.
 */

import { filterContextByRole } from "../context";
import type { ContextBundle } from "../context/engine";
import type { Iteration } from "../findings";
import type { Logger } from "../logger";
import type { AdversarialReviewOutput } from "../operations/adversarial-review";
import type { NaxRuntime } from "../runtime";
import type { ResolvedTestPatterns } from "../test-runners";
import { extractDiffFiles } from "../utils/diff-files";
import type { NaxIgnoreIndex } from "../utils/path-filters";
import type { AdversarialAcceptAnalysis, AdversarialDropAnalysis } from "./ac-structural-counterfactual";
import { recordAdversarialAudit } from "./adversarial-audit-event";
import { type AdversarialLLMFinding, formatFindings, toAdversarialReviewFindings } from "./adversarial-helpers";
import type { collectDiffFileList } from "./diff-utils";
import { llmFindingsToReviewFindings } from "./finding-projection";
import { classifyRecurrence, tagCoverageGap } from "./recurrence-demotion";
import type { AdversarialReviewConfig, ReviewCheckResult } from "./types";

/** Fields every audit-recording outcome helper needs — a slice of RunAdversarialReviewOptions plus derived run state. */
export interface AdversarialOutcomeCtx {
  runtime: NaxRuntime;
  workdir: string;
  projectDir: string | undefined;
  storyId: string;
  featureName: string | undefined;
  blockingThreshold: "error" | "warning" | "info";
  startTime: number;
  logger: Logger | null;
}

export function skipResult(output: string, startTime: number): ReviewCheckResult {
  return {
    check: "adversarial",
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
    const filtered = filterContextByRole(featureContextMarkdown, "reviewer-adversarial");
    if (filtered.trim()) return `${filtered}\n\n---\n\n`;
  }
  return "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch — the three non-continuing outcomes (error, fail-open, truncated-fail)
// ─────────────────────────────────────────────────────────────────────────────

export function catchDispatchFailure(err: unknown, ctx: AdversarialOutcomeCtx): ReviewCheckResult {
  const { runtime, workdir, projectDir, storyId, featureName, blockingThreshold, startTime, logger } = ctx;
  logger?.warn("adversarial", "LLM call failed — fail-open", { storyId, cause: String(err) });
  recordAdversarialAudit({
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
    check: "adversarial",
    success: true,
    failOpen: true,
    command: "",
    exitCode: 0,
    output: `skipped: LLM call failed — ${String(err)}`,
    durationMs: Date.now() - startTime,
  };
}

export function handleRetryExhaustedFailOpen(ctx: AdversarialOutcomeCtx): ReviewCheckResult {
  const { runtime, workdir, projectDir, storyId, featureName, blockingThreshold, startTime, logger } = ctx;
  logger?.warn("adversarial", "Retry exhausted — fail-open", { storyId });
  recordAdversarialAudit({
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
    check: "adversarial",
    success: true,
    failOpen: true,
    command: "",
    exitCode: 0,
    output: "adversarial review: could not parse LLM response (fail-open)",
    durationMs: Date.now() - startTime,
  };
}

export function handleTruncatedLooksLikeFail(ctx: AdversarialOutcomeCtx): ReviewCheckResult {
  const { runtime, workdir, projectDir, storyId, featureName, blockingThreshold, startTime, logger } = ctx;
  logger?.warn("adversarial", "LLM returned truncated JSON with passed:false — treating as failure", { storyId });
  recordAdversarialAudit({
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
    check: "adversarial",
    success: false,
    command: "",
    exitCode: 1,
    output: "adversarial review: LLM response truncated but indicated failure (passed:false found in partial response)",
    durationMs: Date.now() - startTime,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Finding classification — recurrence demotion + projections for audit/pipeline
// ─────────────────────────────────────────────────────────────────────────────

export interface AdversarialClassification {
  threshold: "error" | "warning" | "info";
  allFindings: AdversarialLLMFinding[];
  testFileMatch: (file: string) => boolean;
  blockingFindings: AdversarialLLMFinding[];
  advisoryFindings: AdversarialLLMFinding[];
  advisoryReviewFindings: unknown[];
  advisoryFindingsAsFindings: ReturnType<typeof toAdversarialReviewFindings>;
  acDropped: AdversarialReviewOutput["acDropped"];
  acks: AdversarialReviewOutput["acks"];
}

export function classifyAdversarialFindings(
  opResult: AdversarialReviewOutput,
  blockingThreshold: "error" | "warning" | "info" | undefined,
  priorAdversarialIterations: Iteration[] | undefined,
  adversarialConfig: AdversarialReviewConfig,
  resolvedTestPatterns: ResolvedTestPatterns | undefined,
): AdversarialClassification {
  // verify() has already run the full filter pipeline (substantiate → AC-ground → split).
  // opResult.findings = accepted findings (blocking + advisory); opResult.acDropped = drops for telemetry.
  // opResult.passed preserves the model verdict after filtering so wrappers can
  // still fail-closed when passed:false survives without remaining blockers.
  const threshold = blockingThreshold ?? "error";
  const allFindings = opResult.findings as AdversarialLLMFinding[];
  const patterns = resolvedTestPatterns?.regex ?? [];
  const testFileMatch = (file: string): boolean => patterns.some((re) => re.test(file));
  const recurrenceCfg = adversarialConfig.recurrenceDemotion ?? { enabled: true, maxBlockingRounds: 2 };
  const {
    blocking: blockingFindings,
    advisory: advisoryOnly,
    demoted,
  } = classifyRecurrence(allFindings, priorAdversarialIterations ?? [], recurrenceCfg, testFileMatch, threshold);
  const advisoryFindings = [...advisoryOnly, ...demoted];
  // Precomputed conversions so every downstream `advisoryFindings` projection
  // (ReviewFinding for review-audit persistence, Finding for the pipeline
  // result) tags the recurrence-demoted subset with `meta.coverageGap: true`
  // (Fix design §7) without re-deriving the split at each call site.
  // #1368 — `testFileMatch` also decides the fix lane: a finding located in a test
  // file goes to the test-writer whatever its category says, because the implementer
  // may not edit test files and would answer UNRESOLVED.
  const advisoryReviewFindings = [
    ...llmFindingsToReviewFindings(advisoryOnly, { source: "adversarial-review", isTestFile: testFileMatch }),
    ...tagCoverageGap(
      llmFindingsToReviewFindings(demoted, { source: "adversarial-review", isTestFile: testFileMatch }),
    ),
  ];
  const advisoryFindingsAsFindings = [
    ...toAdversarialReviewFindings(advisoryOnly, { isTestFile: testFileMatch }),
    ...tagCoverageGap(toAdversarialReviewFindings(demoted, { isTestFile: testFileMatch })),
  ];

  return {
    threshold,
    allFindings,
    testFileMatch,
    blockingFindings,
    advisoryFindings,
    advisoryReviewFindings,
    advisoryFindingsAsFindings,
    acDropped: opResult.acDropped ?? [],
    acks: opResult.acks, // #1423 — recorded alongside findings, never as one.
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff file set — for structural counterfactual telemetry (issue #986)
// ─────────────────────────────────────────────────────────────────────────────

export async function resolveDiffFileSet(
  diff: string | undefined,
  workdir: string,
  projectDir: string | undefined,
  effectiveRef: string,
  naxIgnoreIndex: NaxIgnoreIndex | undefined,
  collectDiffFileListFn: typeof collectDiffFileList,
): Promise<{ diffFiles: ReadonlySet<string>; diffAvailable: boolean }> {
  // Embedded mode: parse `diff` (already in memory). Ref mode: shell git diff
  // --name-only via collectDiffFileList. diffAvailable=false signals "exclude
  // this entry from percentage calculations" to the aggregation script.
  if (diff && diff.length > 0) {
    return { diffFiles: extractDiffFiles(diff), diffAvailable: true };
  }
  const repoRoot = projectDir ?? workdir;
  const packageDir = workdir !== repoRoot ? workdir : undefined;
  const list = await collectDiffFileListFn(workdir, effectiveRef, { naxIgnoreIndex, packageDir });
  if (list === undefined) return { diffFiles: new Set(), diffAvailable: false };
  return { diffFiles: new Set(list), diffAvailable: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Outcome builders — blocking failure / AC-dropped (hallucinated vs ungrounded) / passed
// ─────────────────────────────────────────────────────────────────────────────

export function buildBlockingFailureResult(
  ctx: AdversarialOutcomeCtx,
  classification: AdversarialClassification,
  telemetry: {
    adversarialDropAnalysis: AdversarialDropAnalysis[];
    adversarialAcceptAnalysis: AdversarialAcceptAnalysis[];
  },
  diffAvailable: boolean,
  durationMs: number,
): ReviewCheckResult {
  const { runtime, workdir, projectDir, storyId, featureName, logger } = ctx;
  const { threshold, allFindings, testFileMatch, blockingFindings, advisoryFindings, advisoryReviewFindings, acks } =
    classification;
  logger?.warn("review", `Adversarial review failed: ${blockingFindings.length} blocking findings`, {
    storyId,
    durationMs,
    findings: blockingFindings.map((f) => ({
      severity: f.severity,
      category: f.category,
      file: f.file,
      line: f.line,
      issue: f.issue,
    })),
  });
  recordAdversarialAudit({
    runtime,
    workdir,
    projectDir,
    storyId,
    featureName,
    parsed: true,
    failOpen: false,
    passed: false,
    blockingThreshold: threshold,
    result: {
      passed: false,
      findings: llmFindingsToReviewFindings(allFindings, { source: "adversarial-review", isTestFile: testFileMatch }),
    },
    advisoryFindings: advisoryFindings.length > 0 ? advisoryReviewFindings : undefined,
    diffAvailable,
    adversarialDropAnalysis: telemetry.adversarialDropAnalysis,
    adversarialAcceptAnalysis: telemetry.adversarialAcceptAnalysis,
    acks,
  });
  return {
    check: "adversarial",
    success: false,
    command: "",
    exitCode: 1,
    output: `Adversarial review failed:\n\n${formatFindings(blockingFindings)}`,
    durationMs,
    findings: toAdversarialReviewFindings(blockingFindings, { isTestFile: testFileMatch }),
    advisoryFindings: advisoryFindings.length > 0 ? classification.advisoryFindingsAsFindings : undefined,
    cost: 0,
  };
}

/** Case A: every blocking finding cited a quote that does not exist in any AC — the model fabricated its grounding. */
export function buildHallucinatedAcQuoteResult(
  ctx: AdversarialOutcomeCtx,
  classification: AdversarialClassification,
  telemetry: { adversarialDropAnalysis: AdversarialDropAnalysis[] },
  diffAvailable: boolean,
  durationMs: number,
): ReviewCheckResult {
  const { runtime, workdir, projectDir, storyId, featureName, logger } = ctx;
  const { threshold, testFileMatch, acDropped, acks, advisoryFindingsAsFindings } = classification;

  const demotedFindings = toAdversarialReviewFindings(
    acDropped.map((d) => ({ ...d.finding, severity: "warning" as const, acQuote: undefined, acIndex: undefined })),
    { isTestFile: testFileMatch },
  );
  const allAdvisory = [...advisoryFindingsAsFindings, ...demotedFindings];

  logger?.warn("review", "Adversarial review passed: all blocking findings discarded as hallucinated AC quotes", {
    storyId,
    durationMs,
    droppedCount: acDropped.length,
    drops: acDropped.map((d) => ({ file: d.finding.file, issue: d.finding.issue })),
  });
  recordAdversarialAudit({
    runtime,
    workdir,
    projectDir,
    storyId,
    featureName,
    parsed: true,
    acks,
    failOpen: false,
    passed: true,
    passReason: "ac_quote_not_substring_demoted",
    blockingThreshold: threshold,
    result: { passed: true, findings: [] },
    advisoryFindings: allAdvisory.length > 0 ? allAdvisory : undefined,
    diffAvailable,
    adversarialDropAnalysis: telemetry.adversarialDropAnalysis,
    adversarialAcceptAnalysis: [],
  });
  return {
    check: "adversarial",
    success: true,
    passReason: "ac_quote_not_substring_demoted",
    command: "",
    exitCode: 0,
    output: `Adversarial review passed: ${acDropped.length} blocking finding(s) demoted to advisory — all cited AC quotes were fabricated and could not be validated.`,
    durationMs,
    advisoryFindings: allAdvisory.length > 0 ? allAdvisory : undefined,
    cost: 0,
  };
}

/** Case B: mix includes missing_ac_quote or ac_quote_does_not_constrain_locus — fail-closed. */
export function buildUngroundedFailClosedResult(
  ctx: AdversarialOutcomeCtx,
  classification: AdversarialClassification,
  telemetry: { adversarialDropAnalysis: AdversarialDropAnalysis[] },
  diffAvailable: boolean,
  durationMs: number,
): ReviewCheckResult {
  const { runtime, workdir, projectDir, storyId, featureName, logger } = ctx;
  const { threshold, acDropped, acks, advisoryFindings, advisoryReviewFindings, advisoryFindingsAsFindings } =
    classification;

  logger?.warn("review", "Adversarial review fail-closed: blocking findings dropped as ungrounded", {
    storyId,
    durationMs,
    droppedCount: acDropped.length,
    dropCodes: acDropped.map((d) => d.code),
  });
  const dropSummary = acDropped
    .map((d, i) => `${i + 1}. [${d.code}] ${d.finding.file ?? "<unknown>"}: ${d.finding.issue}`)
    .join("\n");
  recordAdversarialAudit({
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
    advisoryFindings: advisoryFindings.length > 0 ? advisoryReviewFindings : undefined,
    diffAvailable,
    adversarialDropAnalysis: telemetry.adversarialDropAnalysis,
    adversarialAcceptAnalysis: [],
  });
  return {
    check: "adversarial",
    success: false,
    command: "",
    exitCode: 1,
    output: `Adversarial review failed: ${acDropped.length} blocking finding(s) dropped as ungrounded — the model emitted "passed: false" with concerns it could not ground in any acceptance criterion. Drops:\n\n${dropSummary}`,
    durationMs,
    advisoryFindings: advisoryFindings.length > 0 ? advisoryFindingsAsFindings : undefined,
    cost: 0,
  };
}

/** Model passed with no blocking findings, or only advisory findings remained after filtering with no AC-grounding drops. */
export function buildPassedResult(
  ctx: AdversarialOutcomeCtx,
  classification: AdversarialClassification,
  telemetry: {
    adversarialDropAnalysis: AdversarialDropAnalysis[];
    adversarialAcceptAnalysis: AdversarialAcceptAnalysis[];
  },
  diffAvailable: boolean,
  durationMs: number,
): ReviewCheckResult {
  const { runtime, workdir, projectDir, storyId, featureName, logger } = ctx;
  const {
    threshold,
    allFindings,
    testFileMatch,
    advisoryFindings,
    advisoryReviewFindings,
    advisoryFindingsAsFindings,
    acks,
  } = classification;

  logger?.info("review", "Adversarial review passed", { storyId, durationMs });
  recordAdversarialAudit({
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
      findings: llmFindingsToReviewFindings(allFindings, { source: "adversarial-review", isTestFile: testFileMatch }),
    },
    advisoryFindings: advisoryFindings.length > 0 ? advisoryReviewFindings : undefined,
    diffAvailable,
    adversarialDropAnalysis: telemetry.adversarialDropAnalysis,
    adversarialAcceptAnalysis: telemetry.adversarialAcceptAnalysis,
  });
  return {
    check: "adversarial",
    success: true,
    command: "",
    exitCode: 0,
    output:
      allFindings.length === 0
        ? "Adversarial review passed"
        : "Adversarial review passed (all findings were advisory — below blocking threshold)",
    durationMs,
    advisoryFindings: advisoryFindings.length > 0 ? advisoryFindingsAsFindings : undefined,
    cost: 0,
  };
}
