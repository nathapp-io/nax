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
import { DEFAULT_CONFIG } from "../config";
import type { NaxConfig } from "../config";
import { resolveModelForAgent } from "../config/schema-types";
import { filterContextByRole } from "../context";
import { createContextToolRuntime } from "../context/engine";
import { getSafeLogger } from "../logger";
import { adversarialReviewOp } from "../operations/adversarial-review";
import { callOp } from "../operations/call";
import type { UserStory } from "../prd";
import { AdversarialReviewPromptBuilder } from "../prompts/builders/adversarial-review-builder";
import { ReviewPromptBuilder } from "../prompts/builders/review-builder";
import { formatSessionName } from "../session/naming";
import type { NaxIgnoreIndex } from "../utils/path-filters";
import {
  type AdversarialLLMFinding,
  type AdversarialLLMResponse,
  formatFindings,
  isBlockingSeverity,
  parseAdversarialResponse,
  toAdversarialReviewFindings,
} from "./adversarial-helpers";
import { collectDiff, collectDiffStat, computeTestInventory, resolveEffectiveRef } from "./diff-utils";
import { writeReviewAudit } from "./review-audit";
import { looksLikeTruncatedJson } from "./truncation";
import type { AdversarialFindingsCache, AdversarialReviewConfig, ReviewCheckResult, SemanticStory } from "./types";

/** Injectable dependencies for adversarial.ts — allows tests to mock without mock.module() */
export const _adversarialDeps = {
  writeReviewAudit,
};

/**
 * Run an adversarial review using an LLM against the story diff.
 * Ships off by default — enabled only when "adversarial" is in review.checks.
 */
export async function runAdversarialReview(
  workdir: string,
  storyGitRef: string | undefined,
  story: SemanticStory,
  adversarialConfig: AdversarialReviewConfig,
  agentManager: IAgentManager | undefined,
  naxConfig?: NaxConfig,
  featureName?: string,
  priorFailures?: Array<{ stage: string; modelTier: string }>,
  blockingThreshold?: "error" | "warning" | "info",
  featureContextMarkdown?: string,
  contextBundle?: import("../context/engine").ContextBundle,
  projectDir?: string,
  naxIgnoreIndex?: NaxIgnoreIndex,
  runtime?: import("../runtime").NaxRuntime,
  priorAdversarialFindings?: AdversarialFindingsCache,
): Promise<ReviewCheckResult> {
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

  if (!agentManager) {
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

  // ADR-019 Pattern A: when a NaxRuntime is available, dispatch via callOp so the
  // hop routes through AgentManager.runWithFallback + buildHopCallback, firing the
  // middleware chain and managing session lifecycle explicitly. The adversarialReviewOp
  // hopBody handles the same-session JSON-parse retry.
  //
  // Falls back to the legacy keepOpen path when no runtime is available.
  let parsed: AdversarialLLMResponse | null;
  // NOTE: llmCost stays 0 on the runtime path — buildHopCallback charges cost via
  // costAggregator. ReviewCheckResult.cost will be 0 for pipeline-managed reviews.
  let llmCost = 0;

  if (runtime) {
    const callCtx = {
      runtime,
      packageView: runtime.packages.resolve(workdir),
      packageDir: workdir,
      agentName: agentManager.getDefault(),
      storyId: story.id,
      featureName,
      contextBundle,
    };
    let opResult: import("../operations/adversarial-review").AdversarialReviewOutput;
    try {
      opResult = await callOp(callCtx, adversarialReviewOp, {
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
    parsed = { passed: opResult.passed, findings: opResult.findings as AdversarialLLMFinding[] };
  } else {
    // @deprecated Legacy keepOpen path — runtime is always present under executeUnified().
    // TODO(ADR-019): Remove this branch once all callers thread runtime (tracked in dogfood findings 2026-04-27).
    logger?.warn("adversarial", "LLM call via legacy agentManager.run — runtime not threaded, middleware skipped", {
      storyId: story.id,
    });
    // Legacy keepOpen path — used when no runtime is available (standalone callers).
    const basePrompt = new AdversarialReviewPromptBuilder().buildAdversarialReviewPrompt(story, adversarialConfig, {
      mode: diffMode,
      diff,
      storyGitRef: effectiveRef,
      stat,
      priorFailures,
      testInventory,
      excludePatterns: adversarialConfig.excludePatterns,
      priorAdversarialFindings,
    });
    const prompt = featureCtxBlock ? `${featureCtxBlock}${basePrompt}` : basePrompt;

    const defaultAgent = agentManager.getDefault();
    let resolvedModelDef = { provider: "anthropic", model: "claude-sonnet-4-5-20250514" };
    try {
      if (naxConfig?.models) {
        resolvedModelDef = resolveModelForAgent(
          naxConfig.models,
          defaultAgent,
          adversarialConfig.modelTier,
          defaultAgent,
        );
      }
    } catch {
      // Use default model if resolution fails
    }

    const adversarialSessionName = formatSessionName({
      workdir,
      featureName,
      storyId: story.id,
      role: "reviewer-adversarial",
    });
    const contextToolStory: UserStory = {
      id: story.id,
      title: story.title,
      description: story.description,
      acceptanceCriteria: story.acceptanceCriteria,
      tags: [],
      dependencies: [],
      status: "in-progress",
      passes: false,
      escalations: [],
      attempts: 0,
    };
    const runOpts = {
      workdir,
      timeoutSeconds: adversarialConfig.timeoutMs ? Math.ceil(adversarialConfig.timeoutMs / 1000) : 600,
      modelTier: adversarialConfig.modelTier,
      modelDef: resolvedModelDef,
      pipelineStage: "review",
      config: naxConfig ?? DEFAULT_CONFIG,
      featureName,
      storyId: story.id,
      sessionRole: "reviewer-adversarial",
      contextPullTools: contextBundle?.pullTools,
      contextToolRuntime: contextBundle
        ? createContextToolRuntime({
            bundle: contextBundle,
            story: contextToolStory,
            config: naxConfig ?? DEFAULT_CONFIG,
            repoRoot: workdir,
          })
        : undefined,
    } as const;

    const adapter = agentManager.getAgent(defaultAgent);
    const legacyCloser = adapter as
      | (import("../agents/types").AgentAdapter & {
          closePhysicalSession?: (handle: string, runWorkdir: string, options?: { force?: boolean }) => Promise<void>;
        })
      | undefined;
    let rawResponse: string;
    let retryAttempted = false;
    try {
      const runResult = await agentManager.run({ runOptions: { prompt, ...runOpts, keepOpen: true } });
      rawResponse = runResult.output;
      llmCost = runResult.estimatedCostUsd ?? 0;
      logger?.debug("adversarial", "LLM call complete (legacy)", {
        storyId: story.id,
        responseLen: rawResponse.length,
        estimatedCostUsd: llmCost,
      });
    } catch (err) {
      logger?.warn("adversarial", "LLM call failed — fail-open", { storyId: story.id, cause: String(err) });
      void legacyCloser?.closePhysicalSession?.(adversarialSessionName, workdir);
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

    const isTruncated = looksLikeTruncatedJson(rawResponse);
    if (isTruncated || !parseAdversarialResponse(rawResponse)) {
      retryAttempted = true;
      const retryPrompt = isTruncated
        ? ReviewPromptBuilder.jsonRetryCondensed({ blockingThreshold })
        : ReviewPromptBuilder.jsonRetry();
      if (isTruncated) {
        logger?.warn("adversarial", "JSON parse retry — original response truncated", {
          storyId: story.id,
          originalByteSize: rawResponse.length,
          blockingThreshold: blockingThreshold ?? "error",
        });
      }
      logger?.info("adversarial", "JSON parse failed, retrying (1/1)", {
        storyId: story.id,
        rawHead: rawResponse.slice(0, 200),
        responseLen: rawResponse.length,
        isTruncated,
      });
      try {
        const retryResult = await agentManager.run({
          runOptions: { prompt: retryPrompt, ...runOpts, keepOpen: false },
        });
        rawResponse = retryResult.output;
        llmCost += retryResult.estimatedCostUsd ?? 0;
        if (parseAdversarialResponse(rawResponse)) {
          logger?.info("adversarial", "JSON retry succeeded", { storyId: story.id, responseLen: rawResponse.length });
        }
      } catch (err) {
        logger?.warn("adversarial", "JSON retry call failed", { storyId: story.id, cause: String(err) });
      }
    }

    void legacyCloser?.closePhysicalSession?.(adversarialSessionName, workdir);

    const legacyParsed = parseAdversarialResponse(rawResponse);
    if (!legacyParsed) {
      const looksLikeFail = /"passed"\s*:\s*false/.test(rawResponse);
      if (naxConfig?.review?.audit?.enabled) {
        void _adversarialDeps.writeReviewAudit({
          reviewer: "adversarial",
          sessionName: adversarialSessionName,
          workdir,
          storyId: story.id,
          featureName,
          parsed: false,
          looksLikeFail,
          result: null,
        });
      }
      if (looksLikeFail) {
        logger?.warn("adversarial", "LLM returned truncated JSON with passed:false — treating as failure", {
          storyId: story.id,
          retryAttempted,
          rawHead: rawResponse.slice(0, 200),
        });
        return {
          check: "adversarial",
          success: false,
          command: "",
          exitCode: 1,
          output:
            "adversarial review: LLM response truncated but indicated failure (passed:false found in partial response)",
          durationMs: Date.now() - startTime,
          cost: llmCost,
        };
      }
      logger?.warn("adversarial", "Retry exhausted — fail-open", {
        storyId: story.id,
        retries: retryAttempted ? 1 : 0,
        rawHead: rawResponse.slice(0, 200),
        responseLen: rawResponse.length,
      });
      return {
        check: "adversarial",
        success: true,
        failOpen: true,
        command: "",
        exitCode: 0,
        output: "adversarial review: could not parse LLM response (fail-open)",
        durationMs: Date.now() - startTime,
        cost: llmCost,
      };
    }
    parsed = legacyParsed;
    if (naxConfig?.review?.audit?.enabled) {
      void _adversarialDeps.writeReviewAudit({
        reviewer: "adversarial",
        sessionName: adversarialSessionName,
        workdir,
        storyId: story.id,
        featureName,
        parsed: true,
        looksLikeFail: false,
        result: legacyParsed,
      });
    }
  }

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
