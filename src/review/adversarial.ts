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

import { buildSessionName, readAcpSession } from "../agents/acp/adapter";
import type { AgentAdapter } from "../agents/types";
import { DEFAULT_CONFIG } from "../config";
import type { NaxConfig } from "../config";
import { resolveModelForAgent } from "../config/schema-types";
import type { ModelTier } from "../config/schema-types";
import { getSafeLogger } from "../logger";
import type { ReviewFinding } from "../plugins/types";
import { AdversarialReviewPromptBuilder } from "../prompts/builders/adversarial-review-builder";
import { tryParseLLMJson } from "../utils/llm-json";
import { collectDiff, collectDiffStat, computeTestInventory, resolveEffectiveRef } from "./diff-utils";
import type { AdversarialReviewConfig, ReviewCheckResult, SemanticStory } from "./types";

/** Function that resolves an AgentAdapter for a given model tier */
export type ModelResolver = (tier: ModelTier) => AgentAdapter | null | undefined;

/** Injectable dependencies for adversarial.ts — allows tests to mock without mock.module() */
export const _adversarialDeps = {
  readAcpSession,
};

interface AdversarialLLMFinding {
  severity: string;
  category: string;
  file: string;
  line: number;
  issue: string;
  suggestion: string;
}

interface AdversarialLLMResponse {
  passed: boolean;
  findings: AdversarialLLMFinding[];
}

/**
 * Validate parsed JSON matches the expected adversarial LLM response shape.
 */
function validateAdversarialShape(parsed: unknown): AdversarialLLMResponse | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.passed !== "boolean") return null;
  if (!Array.isArray(obj.findings)) return null;
  return { passed: obj.passed, findings: obj.findings as AdversarialLLMFinding[] };
}

/**
 * Parse and validate adversarial LLM JSON response.
 * Returns null only when all extraction tiers fail or shape validation fails.
 */
function parseAdversarialResponse(raw: string): AdversarialLLMResponse | null {
  try {
    return validateAdversarialShape(tryParseLLMJson(raw));
  } catch {
    return null;
  }
}

/** Format findings into readable text output. */
function formatFindings(findings: AdversarialLLMFinding[]): string {
  return findings
    .map((f) => `[${f.severity}][${f.category}] ${f.file}:${f.line} — ${f.issue}\n  Suggestion: ${f.suggestion}`)
    .join("\n");
}

/** Normalize LLM severity values to ReviewFinding severity union. */
function normalizeSeverity(sev: string): ReviewFinding["severity"] {
  if (sev === "warn") return "warning";
  if (sev === "unverifiable") return "info";
  if (sev === "critical" || sev === "error" || sev === "warning" || sev === "info" || sev === "low") return sev;
  return "info";
}

/**
 * Check whether a finding severity is blocking (counts toward pass/fail).
 * "unverifiable" and "info" are non-blocking per the adversarial output schema:
 *   passed may be true with findings if all findings are "info" or "unverifiable".
 */
function isBlockingSeverity(sev: string): boolean {
  return sev !== "unverifiable" && sev !== "info";
}

/** Convert AdversarialLLMFinding[] to ReviewFinding[] with adversarial-review metadata. */
function toAdversarialReviewFindings(findings: AdversarialLLMFinding[]): ReviewFinding[] {
  return findings.map((f) => ({
    ruleId: "adversarial",
    severity: normalizeSeverity(f.severity),
    file: f.file,
    line: f.line,
    message: f.issue,
    source: "adversarial-review",
    category: f.category,
  }));
}

/**
 * Run an adversarial review using an LLM against the story diff.
 * Ships off by default — enabled only when "adversarial" is in review.checks.
 */
export async function runAdversarialReview(
  workdir: string,
  storyGitRef: string | undefined,
  story: SemanticStory,
  adversarialConfig: AdversarialReviewConfig,
  modelResolver: ModelResolver,
  naxConfig?: NaxConfig,
  featureName?: string,
  priorFailures?: Array<{ stage: string; modelTier: string }>,
): Promise<ReviewCheckResult> {
  const startTime = Date.now();
  const logger = getSafeLogger();

  // BUG-114: Resolve effective git ref via shared fallback chain (diff-utils.ts).
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
  const stat = await collectDiffStat(workdir, effectiveRef);

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
    // Adversarial embedded mode: no excludePatterns — sees test files too.
    diff = await collectDiff(workdir, effectiveRef, adversarialConfig.excludePatterns ?? []);
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
    testInventory = await computeTestInventory(workdir, effectiveRef);
  }

  // Resolve agent
  const agent = modelResolver(adversarialConfig.modelTier);
  if (!agent) {
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

  // Build prompt
  const prompt = new AdversarialReviewPromptBuilder().buildAdversarialReviewPrompt(story, adversarialConfig, {
    mode: diffMode,
    diff,
    storyGitRef: effectiveRef,
    stat,
    priorFailures,
    testInventory,
  });

  // Resolve model definition
  const defaultAgent = naxConfig?.autoMode?.defaultAgent ?? "claude";
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

  // Adversarial review uses its own session (NOT the implementer session).
  const adversarialSessionName = buildSessionName(workdir, featureName, story.id, "reviewer-adversarial");

  let rawResponse: string;
  let llmCost = 0;
  try {
    const runResult = await agent.run({
      prompt,
      workdir,
      acpSessionName: adversarialSessionName,
      keepSessionOpen: false,
      timeoutSeconds: adversarialConfig.timeoutMs ? Math.ceil(adversarialConfig.timeoutMs / 1000) : 180,
      modelTier: adversarialConfig.modelTier,
      modelDef: resolvedModelDef,
      pipelineStage: "review",
      config: naxConfig ?? DEFAULT_CONFIG,
      featureName,
      storyId: story.id,
      sessionRole: "reviewer-adversarial",
    });
    rawResponse = runResult.output;
    llmCost = runResult.estimatedCost ?? 0;
  } catch (err) {
    logger?.warn("adversarial", "LLM call failed — fail-open", {
      storyId: story.id,
      cause: String(err),
    });
    return {
      check: "adversarial",
      success: true,
      command: "",
      exitCode: 0,
      output: `skipped: LLM call failed — ${String(err)}`,
      durationMs: Date.now() - startTime,
    };
  }

  // Parse response — fail-closed when LLM clearly intended to fail,
  // fail-open only when response is truly unparseable with no signal.
  const parsed = parseAdversarialResponse(rawResponse);
  if (!parsed) {
    const looksLikeFail = /"passed"\s*:\s*false/.test(rawResponse);
    if (looksLikeFail) {
      logger?.warn("adversarial", "LLM returned truncated JSON with passed:false — treating as failure", {
        storyId: story.id,
        rawResponse: rawResponse.slice(0, 200),
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

    logger?.warn("adversarial", "LLM returned invalid JSON — fail-open", {
      storyId: story.id,
      rawResponse: rawResponse.slice(0, 200),
    });
    return {
      check: "adversarial",
      success: true,
      command: "",
      exitCode: 0,
      output: "adversarial review: could not parse LLM response (fail-open)",
      durationMs: Date.now() - startTime,
      cost: llmCost,
    };
  }

  const blockingFindings = parsed.findings.filter((f) => isBlockingSeverity(f.severity));
  const nonBlockingFindings = parsed.findings.filter((f) => !isBlockingSeverity(f.severity));

  if (nonBlockingFindings.length > 0) {
    logger?.debug(
      "review",
      `Adversarial review: ${nonBlockingFindings.length} non-blocking findings (unverifiable/info)`,
      {
        storyId: story.id,
        findings: nonBlockingFindings.map((f) => ({
          severity: f.severity,
          category: f.category,
          file: f.file,
          issue: f.issue,
        })),
      },
    );
  }

  // Findings take precedence over the passed field.
  // The schema requires passed:false when any error/warn finding exists, but if the LLM
  // contradicts itself (passed:true + error findings), trust the findings and fail-closed.
  if (blockingFindings.length > 0) {
    const durationMs = Date.now() - startTime;
    logger?.warn("review", `Adversarial review failed: ${blockingFindings.length} findings`, {
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
      cost: llmCost,
    };
  }

  // If all findings are non-blocking (unverifiable/info), override to pass regardless of passed field.
  if (!parsed.passed && blockingFindings.length === 0) {
    const durationMs = Date.now() - startTime;
    logger?.info("review", "Adversarial review passed (all findings non-blocking)", {
      storyId: story.id,
      durationMs,
    });
    return {
      check: "adversarial",
      success: true,
      command: "",
      exitCode: 0,
      output: "Adversarial review passed (all findings were unverifiable or informational)",
      durationMs,
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
    cost: llmCost,
  };
}
