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

import { relative, sep } from "node:path";
import type { IAgentManager } from "../agents";
import { DEFAULT_CONFIG, reviewConfigSelector } from "../config";
import type { ReviewConfig } from "../config/selectors";
import { filterContextByRole } from "../context";
import { NaxError } from "../errors";
import type { Iteration } from "../findings";
import { getSafeLogger } from "../logger";
import { adversarialReviewOp } from "../operations/adversarial-review";
import { callOp as _callOp } from "../operations/call";
import { resolveReviewExcludePatterns, resolveTestFilePatterns } from "../test-runners";
import { extractDiffFiles } from "../utils/diff-files";
import type { NaxIgnoreIndex } from "../utils/path-filters";
import {
  type AdversarialAcceptAnalysis,
  type AdversarialDropAnalysis,
  analyzeStructuralCounterfactual,
} from "./ac-structural-counterfactual";
import {
  type AdversarialLLMFinding,
  formatFindings,
  isBlockingSeverity,
  toAdversarialReviewFindings,
} from "./adversarial-helpers";
import {
  collectDiffFileList as _collectDiffFileList,
  collectDiffStat as _collectDiffStat,
  resolveEffectiveRef as _resolveEffectiveRef,
  collectDiff,
  computeTestInventory,
} from "./diff-utils";
import { llmFindingsToReviewFindings } from "./finding-projection";
import { writeReviewAudit } from "./review-audit";
import type { AdversarialReviewConfig, ReviewCheckResult, SemanticStory } from "./types";

/** Injectable dependencies for adversarial.ts — allows tests to mock without mock.module() */
export const _adversarialDeps = {
  writeReviewAudit,
  callOp: _callOp,
  resolveEffectiveRef: _resolveEffectiveRef,
  collectDiffStat: _collectDiffStat,
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
  } = opts;
  const startTime = Date.now();
  const logger = getSafeLogger();

  // @design: BUG-114: Resolve effective git ref via shared fallback chain (diff-utils.ts).
  const effectiveRef = await _adversarialDeps.resolveEffectiveRef(workdir, storyGitRef, story.id);

  if (!effectiveRef) {
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

  // Collect stat summary (used by both modes as a quick overview).
  // In ref mode: stat + ref passed to reviewer; reviewer self-serves the full diff via git tools.
  // In embedded mode: also collect full diff (no excludePatterns — adversarial sees test files).
  const repoRoot = projectDir ?? workdir;
  const packageDir = workdir !== repoRoot ? workdir : undefined;
  const stat = await _adversarialDeps.collectDiffStat(workdir, effectiveRef, { naxIgnoreIndex, packageDir });

  if (!stat) {
    return {
      check: "adversarial",
      success: true,
      command: "",
      exitCode: 0,
      output: "skipped: no changes detected",
      durationMs: Date.now() - startTime,
    };
  }

  let diff: string | undefined;
  let testInventory: import("./diff-utils").TestInventory | undefined;
  const effectiveConfig = naxConfig ?? reviewConfigSelector.select(DEFAULT_CONFIG);
  const packageDirRelative =
    projectDir && workdir !== projectDir
      ? (() => {
          const rel = relative(projectDir, workdir);
          if (rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
          return rel && rel !== "." ? rel : undefined;
        })()
      : undefined;
  const resolvedTestPatterns = await resolveTestFilePatterns(
    effectiveConfig,
    projectDir ?? workdir,
    packageDirRelative,
  );
  const effectiveRefExcludePatterns = [
    ...resolveReviewExcludePatterns(adversarialConfig.excludePatterns, resolvedTestPatterns),
  ];

  if (diffMode === "embedded") {
    // Adversarial embedded mode: excludes .nax/ metadata but sees test files (unlike semantic).
    diff = await collectDiff(workdir, effectiveRef, adversarialConfig.excludePatterns ?? [], {
      naxIgnoreIndex,
      packageDir,
    });
    if (!diff) {
      return {
        check: "adversarial",
        success: true,
        command: "",
        exitCode: 0,
        output: "skipped: no code changes",
        durationMs: Date.now() - startTime,
      };
    }
    const testFilePatterns =
      (typeof naxConfig?.execution?.smartTestRunner === "object"
        ? naxConfig.execution.smartTestRunner?.testFilePatterns
        : undefined) ?? undefined;
    testInventory = await computeTestInventory(workdir, effectiveRef, testFilePatterns, { naxIgnoreIndex, packageDir });
  }

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
      story,
      adversarialConfig,
      mode: diffMode,
      diff,
      storyGitRef: effectiveRef,
      stat,
      testInventory,
      excludePatterns: adversarialConfig.excludePatterns,
      testGlobs: resolvedTestPatterns.globs,
      featureCtxBlock,
      priorAdversarialIterations,
      blockingThreshold,
      refExcludePatterns: effectiveRefExcludePatterns,
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
  const blockingFindings = allFindings.filter((f) => isBlockingSeverity(f.severity, threshold));
  const advisoryFindings = allFindings.filter((f) => !isBlockingSeverity(f.severity, threshold));
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
