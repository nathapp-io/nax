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
import type { NaxConfig } from "../config";
import { filterContextByRole } from "../context";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import { adversarialReviewOp } from "../operations/adversarial-review";
import { callOp as _callOp } from "../operations/call";
import type { NaxIgnoreIndex } from "../utils/path-filters";
import {
  type AdversarialLLMFinding,
  type AdversarialLLMResponse,
  formatFindings,
  isBlockingSeverity,
  toAdversarialReviewFindings,
} from "./adversarial-helpers";
import { collectDiff, collectDiffStat, computeTestInventory, resolveEffectiveRef } from "./diff-utils";
import { writeReviewAudit } from "./review-audit";
import type { AdversarialFindingsCache, AdversarialReviewConfig, ReviewCheckResult, SemanticStory } from "./types";

/** Injectable dependencies for adversarial.ts — allows tests to mock without mock.module() */
export const _adversarialDeps = {
  writeReviewAudit,
  callOp: _callOp,
};

export interface RunAdversarialReviewOptions {
  workdir: string;
  storyGitRef: string | undefined;
  story: SemanticStory;
  adversarialConfig: AdversarialReviewConfig;
  agentManager: IAgentManager | undefined;
  naxConfig?: NaxConfig;
  featureName?: string;
  priorFailures?: Array<{ stage: string; modelTier: string }>;
  blockingThreshold?: "error" | "warning" | "info";
  featureContextMarkdown?: string;
  contextBundle?: import("../context/engine").ContextBundle;
  projectDir?: string;
  naxIgnoreIndex?: NaxIgnoreIndex;
  runtime?: import("../runtime").NaxRuntime;
  priorAdversarialFindings?: AdversarialFindingsCache;
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
    naxConfig,
    featureName,
    priorFailures,
    blockingThreshold,
    featureContextMarkdown,
    contextBundle,
    projectDir,
    naxIgnoreIndex,
    runtime,
    priorAdversarialFindings,
  } = opts;
  const startTime = Date.now();
  const logger = getSafeLogger();

  // @design: BUG-114: Resolve effective git ref via shared fallback chain (diff-utils.ts).
  const effectiveRef = await resolveEffectiveRef(workdir, storyGitRef, story.id);

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
    modelTier: adversarialConfig.modelTier,
    diffMode,
  });

  // Collect stat summary (used by both modes as a quick overview).
  // In ref mode: stat + ref passed to reviewer; reviewer self-serves the full diff via git tools.
  // In embedded mode: also collect full diff (no excludePatterns — adversarial sees test files).
  const repoRoot = projectDir ?? workdir;
  const packageDir = workdir !== repoRoot ? workdir : undefined;
  const stat = await collectDiffStat(workdir, effectiveRef, { naxIgnoreIndex, packageDir });

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
      modelTier: adversarialConfig.modelTier,
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
      story,
      adversarialConfig,
      mode: diffMode,
      diff,
      storyGitRef: effectiveRef,
      stat,
      priorFailures,
      testInventory,
      excludePatterns: adversarialConfig.excludePatterns,
      featureCtxBlock,
      priorAdversarialFindings,
      blockingThreshold,
    });
  } catch (err) {
    logger?.warn("adversarial", "LLM call failed — fail-open", { storyId: story.id, cause: String(err) });
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
    if (naxConfig?.review?.audit?.enabled) {
      void _adversarialDeps.writeReviewAudit({
        reviewer: "adversarial",
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
    if (naxConfig?.review?.audit?.enabled) {
      void _adversarialDeps.writeReviewAudit({
        reviewer: "adversarial",
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
      check: "adversarial",
      success: false,
      command: "",
      exitCode: 1,
      output:
        "adversarial review: LLM response truncated but indicated failure (passed:false found in partial response)",
      durationMs: Date.now() - startTime,
    };
  }
  const parsed: AdversarialLLMResponse = {
    passed: opResult.passed,
    findings: opResult.findings as AdversarialLLMFinding[],
  };

  const threshold = blockingThreshold ?? "error";
  const blockingFindings = parsed.findings.filter((f) => isBlockingSeverity(f.severity, threshold));
  const advisoryFindings = parsed.findings.filter((f) => !isBlockingSeverity(f.severity, threshold));

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

  // Findings take precedence over the passed field.
  // The schema requires passed:false when any blocking finding exists, but if the LLM
  // contradicts itself (passed:true + blocking findings), trust the findings and fail-closed.
  if (blockingFindings.length > 0) {
    const durationMs = Date.now() - startTime;
    logger?.warn("review", `Adversarial review failed: ${blockingFindings.length} blocking findings`, {
      storyId: story.id,
      durationMs,
    });
    logger?.debug("review", "Adversarial review findings", {
      storyId: story.id,
      findings: blockingFindings.map((f) => ({
        severity: f.severity,
        category: f.category,
        file: f.file,
        line: f.line,
        issue: f.issue,
      })),
    });
    return {
      check: "adversarial",
      success: false,
      command: "",
      exitCode: 1,
      output: `Adversarial review failed:\n\n${formatFindings(blockingFindings)}`,
      durationMs,
      findings: toAdversarialReviewFindings(blockingFindings),
      advisoryFindings: advisoryFindings.length > 0 ? toAdversarialReviewFindings(advisoryFindings) : undefined,
      cost: llmCost,
    };
  }

  // If all findings are advisory (below threshold), override to pass regardless of passed field.
  if (!parsed.passed && blockingFindings.length === 0) {
    const durationMs = Date.now() - startTime;
    logger?.info("review", "Adversarial review passed (all findings below blocking threshold)", {
      storyId: story.id,
      durationMs,
    });
    return {
      check: "adversarial",
      success: true,
      command: "",
      exitCode: 0,
      output: "Adversarial review passed (all findings were advisory — below blocking threshold)",
      durationMs,
      advisoryFindings: advisoryFindings.length > 0 ? toAdversarialReviewFindings(advisoryFindings) : undefined,
      cost: llmCost,
    };
  }

  const durationMs = Date.now() - startTime;
  if (parsed.passed) {
    logger?.info("review", "Adversarial review passed", { storyId: story.id, durationMs });
  }
  return {
    check: "adversarial",
    success: parsed.passed,
    command: "",
    exitCode: parsed.passed ? 0 : 1,
    output: parsed.passed ? "Adversarial review passed" : "Adversarial review failed (no findings)",
    durationMs,
    advisoryFindings: advisoryFindings.length > 0 ? toAdversarialReviewFindings(advisoryFindings) : undefined,
    cost: llmCost,
  };
}
