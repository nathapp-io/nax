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
 */

import type { IAgentManager } from "../agents";
import type { ReviewConfig } from "../config/selectors";
import { filterContextByRole } from "../context";
import { NaxError } from "../errors";
import type { Iteration } from "../findings";
import { getSafeLogger } from "../logger";
import { adversarialReviewOp } from "../operations/adversarial-review";
import { callOp as _callOp } from "../operations/call";
import { extractDiffFiles } from "../utils/diff-files";
import type { NaxIgnoreIndex } from "../utils/path-filters";
import {
  type AdversarialAcceptAnalysis,
  type AdversarialDropAnalysis,
  analyzeStructuralCounterfactual,
} from "./ac-structural-counterfactual";
import { type AdversarialLLMFinding, formatFindings, toAdversarialReviewFindings } from "./adversarial-helpers";
import { collectDiffFileList as _collectDiffFileList } from "./diff-utils";
import { llmFindingsToReviewFindings } from "./finding-projection";
import { prepareAdversarialReviewInput } from "./prepare-inputs";
import { classifyRecurrence } from "./recurrence-demotion";
import { writeReviewAudit } from "./review-audit";
import type { AdversarialReviewConfig, ReviewCheckResult, SemanticStory } from "./types";

/** Injectable dependencies for adversarial.ts — allows tests to mock without mock.module() */
export const _adversarialDeps = {
  writeReviewAudit,
  callOp: _callOp,
  collectDiffFileList: _collectDiffFileList,
};

function recordAdversarialAudit(opts: {
  runtime?: import("../runtime").NaxRuntime;
  workdir: string;
  projectDir?: string;
  storyId: string;
  featureName?: string;
  parsed: boolean;
  looksLikeFail?: boolean;
  failOpen?: boolean;
  passed?: boolean;
  passReason?: string;
  blockingThreshold?: "error" | "warning" | "info";
  result: { passed: boolean; findings: unknown[] } | null;
  advisoryFindings?: unknown[];
  // Issue #986 — adversarial-only structural counterfactual telemetry.
  diffAvailable?: boolean;
  adversarialDropAnalysis?: AdversarialDropAnalysis[];
  adversarialAcceptAnalysis?: AdversarialAcceptAnalysis[];
}): void {
  opts.runtime?.dispatchEvents.emitReviewDecision({
    kind: "review-decision",
    reviewer: "adversarial",
    workdir: opts.workdir,
    projectDir: opts.projectDir,
    storyId: opts.storyId,
    featureName: opts.featureName,
    timestamp: Date.now(),
    parsed: opts.parsed,
    looksLikeFail: opts.looksLikeFail,
    failOpen: opts.failOpen,
    passed: opts.passed,
    passReason: opts.passReason,
    blockingThreshold: opts.blockingThreshold,
    result: opts.result,
    advisoryFindings: opts.advisoryFindings,
    diffAvailable: opts.diffAvailable,
    adversarialDropAnalysis: opts.adversarialDropAnalysis,
    adversarialAcceptAnalysis: opts.adversarialAcceptAnalysis,
  });
}

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
  contextBundle?: import("../context/engine").ContextBundle;
  projectDir?: string;
  naxIgnoreIndex?: NaxIgnoreIndex;
  runtime?: import("../runtime").NaxRuntime;
  priorAdversarialIterations?: Iteration[];
  resolvedTestPatterns?: import("../test-runners").ResolvedTestPatterns;
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
    return {
      check: "adversarial",
      success: true,
      command: "",
      exitCode: 0,
      output: "skipped: no git ref",
      durationMs: Date.now() - startTime,
    };
  }

  const diffMode = adversarialConfig.diffMode ?? "ref";
  logger?.info("review", "Running adversarial check", {
    storyId: story.id,
    model: adversarialConfig.model,
    diffMode,
  });

  if (prepared.skipReason === "no changes detected") {
    return {
      check: "adversarial",
      success: true,
      command: "",
      exitCode: 0,
      output: "skipped: no changes detected",
      durationMs: Date.now() - startTime,
    };
  }
  if (prepared.skipReason === "no code changes") {
    return {
      check: "adversarial",
      success: true,
      command: "",
      exitCode: 0,
      output: "skipped: no code changes",
      durationMs: Date.now() - startTime,
    };
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
    return {
      check: "adversarial",
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
    const filtered = filterContextByRole(featureContextMarkdown, "reviewer-adversarial");
    if (filtered.trim()) featureCtxBlock = `${filtered}\n\n---\n\n`;
  }

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

  // NOTE: llmCost stays 0 on the runtime path — buildHopCallback charges cost via
  // costAggregator. ReviewCheckResult.cost is 0 for pipeline-managed reviews.
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
  let opResult: import("../operations/adversarial-review").AdversarialReviewOutput;
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
    logger?.warn("adversarial", "LLM call failed — fail-open", { storyId: story.id, cause: String(err) });
    recordAdversarialAudit({
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
      check: "adversarial",
      success: true,
      failOpen: true,
      command: "",
      exitCode: 0,
      output: `skipped: LLM call failed — ${String(err)}`,
      durationMs: Date.now() - startTime,
    };
  }
  if (opResult.failOpen) {
    logger?.warn("adversarial", "Retry exhausted — fail-open", { storyId: story.id });
    recordAdversarialAudit({
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
      check: "adversarial",
      success: true,
      failOpen: true,
      command: "",
      exitCode: 0,
      output: "adversarial review: could not parse LLM response (fail-open)",
      durationMs: Date.now() - startTime,
    };
  }
  if (opResult.looksLikeFail) {
    logger?.warn("adversarial", "LLM returned truncated JSON with passed:false — treating as failure", {
      storyId: story.id,
    });
    recordAdversarialAudit({
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
      check: "adversarial",
      success: false,
      command: "",
      exitCode: 1,
      output:
        "adversarial review: LLM response truncated but indicated failure (passed:false found in partial response)",
      durationMs: Date.now() - startTime,
    };
  }

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
  const acDropped = opResult.acDropped ?? [];

  // Issue #986 — build diff file set for structural counterfactual telemetry.
  // Embedded mode: parse `diff` (already in memory). Ref mode: shell git diff
  // --name-only via collectDiffFileList. diffAvailable=false signals "exclude
  // this entry from percentage calculations" to the aggregation script.
  let diffFiles: ReadonlySet<string>;
  let diffAvailable: boolean;
  if (diff && diff.length > 0) {
    diffFiles = extractDiffFiles(diff);
    diffAvailable = true;
  } else {
    const repoRoot = projectDir ?? workdir;
    const packageDir = workdir !== repoRoot ? workdir : undefined;
    const list = await _adversarialDeps.collectDiffFileList(workdir, effectiveRef, { naxIgnoreIndex, packageDir });
    if (list === undefined) {
      diffFiles = new Set();
      diffAvailable = false;
    } else {
      diffFiles = new Set(list);
      diffAvailable = true;
    }
  }

  // Issue #986 — counterfactual analysis for every drop. Adversarial-only.
  const adversarialDropAnalysis: AdversarialDropAnalysis[] = acDropped.map((d) => ({
    finding: {
      file: d.finding.file ?? "<unknown>",
      line: d.finding.line ?? 0,
      severity: d.finding.severity,
      category: d.finding.category ?? "<unknown>",
      issue: d.finding.issue,
    },
    dropCode: d.code,
    acIndex: d.finding.acIndex,
    rawCategory: d.finding.category ?? "",
    counterfactual: analyzeStructuralCounterfactual(
      { acIndex: d.finding.acIndex, category: d.finding.category, file: d.finding.file },
      story.acceptanceCriteria,
      diffFiles,
    ),
  }));

  // Issue #986 — counterfactual analysis for every accepted blocking finding.
  const adversarialAcceptAnalysis: AdversarialAcceptAnalysis[] = blockingFindings.map((f) => ({
    finding: {
      file: f.file,
      line: f.line,
      severity: f.severity,
      category: f.category,
    },
    acIndex: f.acIndex,
    rawCategory: f.category,
    counterfactual: analyzeStructuralCounterfactual(
      { acIndex: f.acIndex, category: f.category, file: f.file },
      story.acceptanceCriteria,
      diffFiles,
    ),
  }));

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

  if (blockingFindings.length > 0) {
    logger?.warn("review", `Adversarial review failed: ${blockingFindings.length} blocking findings`, {
      storyId: story.id,
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
      storyId: story.id,
      featureName,
      parsed: true,
      failOpen: false,
      passed: false,
      blockingThreshold: threshold,
      result: {
        passed: false,
        findings: llmFindingsToReviewFindings(allFindings, { source: "adversarial-review" }),
      },
      advisoryFindings:
        advisoryFindings.length > 0
          ? llmFindingsToReviewFindings(advisoryFindings, { source: "adversarial-review" })
          : undefined,
      diffAvailable,
      adversarialDropAnalysis,
      adversarialAcceptAnalysis,
    });
    const output =
      blockingFindings.length > 0
        ? `Adversarial review failed:\n\n${formatFindings(blockingFindings)}`
        : "Adversarial review failed (no findings)";
    return {
      check: "adversarial",
      success: false,
      command: "",
      exitCode: 1,
      output,
      durationMs,
      findings: blockingFindings.length > 0 ? toAdversarialReviewFindings(blockingFindings) : undefined,
      advisoryFindings: advisoryFindings.length > 0 ? toAdversarialReviewFindings(advisoryFindings) : undefined,
      cost: llmCost,
    };
  }

  if (!opResult.passed && acDropped.length > 0) {
    const allHallucinated = acDropped.every((d) => d.code === "ac_quote_not_substring");

    if (allHallucinated) {
      // Case A: every blocking finding cited a quote that does not exist in any AC.
      // The model fabricated its grounding. Treat as pass — demote each dropped finding
      // to "warning" and surface as advisory so it remains auditable.
      const demotedFindings = toAdversarialReviewFindings(
        acDropped.map((d) => ({ ...d.finding, severity: "warning" as const, acQuote: undefined, acIndex: undefined })),
      );
      const existingAdvisory = advisoryFindings.length > 0 ? toAdversarialReviewFindings(advisoryFindings) : [];
      const allAdvisory = [...existingAdvisory, ...demotedFindings];

      logger?.warn("review", "Adversarial review passed: all blocking findings discarded as hallucinated AC quotes", {
        storyId: story.id,
        durationMs,
        droppedCount: acDropped.length,
        drops: acDropped.map((d) => ({ file: d.finding.file, issue: d.finding.issue })),
      });
      recordAdversarialAudit({
        runtime,
        workdir,
        projectDir,
        storyId: story.id,
        featureName,
        parsed: true,
        failOpen: false,
        passed: true,
        passReason: "ac_quote_not_substring_demoted",
        blockingThreshold: threshold,
        result: { passed: true, findings: [] },
        advisoryFindings: allAdvisory.length > 0 ? allAdvisory : undefined,
        diffAvailable,
        adversarialDropAnalysis,
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
        cost: llmCost,
      };
    }

    // Case B: mix includes missing_ac_quote or ac_quote_does_not_constrain_locus —
    // fail-closed (existing behavior unchanged).
    logger?.warn("review", "Adversarial review fail-closed: blocking findings dropped as ungrounded", {
      storyId: story.id,
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
      storyId: story.id,
      featureName,
      parsed: true,
      failOpen: false,
      passed: false,
      blockingThreshold: threshold,
      result: { passed: false, findings: [] },
      advisoryFindings:
        advisoryFindings.length > 0
          ? llmFindingsToReviewFindings(advisoryFindings, { source: "adversarial-review" })
          : undefined,
      diffAvailable,
      adversarialDropAnalysis,
      adversarialAcceptAnalysis: [],
    });
    return {
      check: "adversarial",
      success: false,
      command: "",
      exitCode: 1,
      output: `Adversarial review failed: ${acDropped.length} blocking finding(s) dropped as ungrounded — the model emitted "passed: false" with concerns it could not ground in any acceptance criterion. Drops:\n\n${dropSummary}`,
      durationMs,
      advisoryFindings: advisoryFindings.length > 0 ? toAdversarialReviewFindings(advisoryFindings) : undefined,
      cost: llmCost,
    };
  }

  // passed — either the model passed with no blocking findings, or only advisory
  // findings remained after filtering and there were no AC-grounding drops.
  logger?.info("review", "Adversarial review passed", { storyId: story.id, durationMs });
  recordAdversarialAudit({
    runtime,
    workdir,
    projectDir,
    storyId: story.id,
    featureName,
    parsed: true,
    failOpen: false,
    passed: true,
    blockingThreshold: threshold,
    result: {
      passed: true,
      findings: llmFindingsToReviewFindings(allFindings, { source: "adversarial-review" }),
    },
    advisoryFindings:
      advisoryFindings.length > 0
        ? llmFindingsToReviewFindings(advisoryFindings, { source: "adversarial-review" })
        : undefined,
    diffAvailable,
    adversarialDropAnalysis,
    adversarialAcceptAnalysis: [],
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
    advisoryFindings: advisoryFindings.length > 0 ? toAdversarialReviewFindings(advisoryFindings) : undefined,
    cost: llmCost,
  };
}
