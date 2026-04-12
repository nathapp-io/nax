/**
 * Semantic Review Runner
 *
 * Runs an LLM-based semantic review against the git diff for a story.
 * Validates behavior — checks that the implementation satisfies the
 * story's acceptance criteria. Code quality (lint, style, conventions)
 * is handled by lint/typecheck, not semantic review.
 */

import { buildSessionName, readAcpSession } from "../agents/acp/adapter";
import type { AgentAdapter } from "../agents/types";
import { DEFAULT_CONFIG } from "../config";
import type { NaxConfig } from "../config";
import { resolveModelForAgent } from "../config/schema-types";
import type { ModelTier } from "../config/schema-types";
import { DebateSession } from "../debate";
import type { DebateSessionOptions } from "../debate";
import { getSafeLogger } from "../logger";
import type { ReviewFinding } from "../plugins/types";
import { ReviewPromptBuilder } from "../prompts";
import { tryParseLLMJson } from "../utils/llm-json";
import { DIFF_CAP_BYTES, collectDiff, collectDiffStat, resolveEffectiveRef, truncateDiff } from "./diff-utils";
import type { ReviewCheckResult, SemanticReviewConfig, SemanticStory } from "./types";

// Re-export so existing callers (`import type { SemanticStory } from "./semantic"`) keep working.
export type { SemanticStory };

/** Function that resolves an AgentAdapter for a given model tier */
export type ModelResolver = (tier: ModelTier) => AgentAdapter | null | undefined;

/** Injectable dependencies for semantic.ts — allows tests to mock without mock.module() */
export const _semanticDeps = {
  createDebateSession: (opts: DebateSessionOptions): DebateSession => new DebateSession(opts),
  readAcpSession,
};

interface LLMFinding {
  severity: string;
  file: string;
  line: number;
  issue: string;
  suggestion: string;
  acId?: string;
}

interface LLMResponse {
  passed: boolean;
  findings: LLMFinding[];
}

/**
 * Validate parsed JSON matches the expected LLM response shape.
 */
function validateLLMShape(parsed: unknown): LLMResponse | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.passed !== "boolean") return null;
  if (!Array.isArray(obj.findings)) return null;
  return { passed: obj.passed, findings: obj.findings as LLMFinding[] };
}

/**
 * Parse and validate LLM JSON response using multi-tier extraction.
 * Returns null only when all tiers fail or shape validation fails.
 */
function parseLLMResponse(raw: string): LLMResponse | null {
  try {
    return validateLLMShape(tryParseLLMJson(raw));
  } catch {
    return null;
  }
}

/**
 * Format findings into readable text output.
 */
function formatFindings(findings: LLMFinding[]): string {
  return findings
    .map((f) => `[${f.severity}] ${f.file}:${f.line} — ${f.issue}\n  Suggestion: ${f.suggestion}`)
    .join("\n");
}

/** Normalize LLM severity values to ReviewFinding severity union. */
function normalizeSeverity(sev: string): ReviewFinding["severity"] {
  if (sev === "warn") return "warning";
  if (sev === "unverifiable") return "info";
  if (sev === "critical" || sev === "error" || sev === "warning" || sev === "info" || sev === "low") return sev;
  return "info";
}

/** Check whether a finding severity is blocking (counts toward pass/fail). */
function isBlockingSeverity(sev: string): boolean {
  return sev !== "unverifiable";
}

/** Convert LLMFinding[] to ReviewFinding[] with semantic-review metadata. */
function toReviewFindings(findings: LLMFinding[]): ReviewFinding[] {
  return findings.map((f) => ({
    ruleId: "semantic",
    severity: normalizeSeverity(f.severity),
    file: f.file,
    line: f.line,
    message: f.issue,
    source: "semantic-review",
  }));
}

/**
 * Run a semantic review using an LLM against the story diff.
 */
export async function runSemanticReview(
  workdir: string,
  storyGitRef: string | undefined,
  story: SemanticStory,
  semanticConfig: SemanticReviewConfig,
  modelResolver: ModelResolver,
  naxConfig?: NaxConfig,
  featureName?: string,
  resolverSession?: import("./dialogue").ReviewerSession,
  priorFailures?: Array<{ stage: string; modelTier: string }>,
): Promise<ReviewCheckResult> {
  const startTime = Date.now();
  const logger = getSafeLogger();

  if (featureName === undefined) {
    logger?.debug("semantic", "featureName missing — semantic session name will not include feature", {
      storyId: story.id,
    });
  }

  // BUG-114: Resolve effective git ref via shared fallback chain (diff-utils.ts).
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

  const diffMode = semanticConfig.diffMode ?? "embedded";
  logger?.info("review", "Running semantic check", {
    storyId: story.id,
    modelTier: semanticConfig.modelTier,
    diffMode,
    configProvided: !!naxConfig,
  });

  // Collect stat summary (used by both modes).
  // In embedded mode: also collect full diff, truncate if needed.
  // In ref mode: pass stat + ref to reviewer; reviewer self-serves the full diff via tools.
  const stat = await collectDiffStat(workdir, effectiveRef);

  let diff: string | undefined;
  if (diffMode === "embedded") {
    const rawDiff = await collectDiff(workdir, effectiveRef, semanticConfig.excludePatterns);
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

  // Resolve agent
  const agent = modelResolver(semanticConfig.modelTier);
  if (!agent) {
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

  // Build prompt — mode determines whether diff is embedded or reviewer self-serves via tools.
  const prompt = new ReviewPromptBuilder().buildSemanticReviewPrompt(story, semanticConfig, {
    mode: diffMode,
    diff,
    storyGitRef: effectiveRef,
    stat,
    priorFailures,
    excludePatterns: semanticConfig.excludePatterns,
  });

  // Debate path: when debate is enabled for review stage, use DebateSession instead of agent.complete()
  const reviewDebateEnabled = naxConfig?.debate?.enabled && naxConfig?.debate?.stages?.review?.enabled;
  if (reviewDebateEnabled) {
    // Safe: reviewDebateEnabled guard confirms naxConfig.debate.stages.review is defined
    const reviewStageConfig = naxConfig?.debate?.stages.review as import("../debate").DebateStageConfig;
    const isReReview = resolverSession !== undefined && resolverSession.history.length > 0;
    const debateSession = _semanticDeps.createDebateSession({
      storyId: story.id,
      stage: "review",
      stageConfig: reviewStageConfig,
      config: naxConfig ?? DEFAULT_CONFIG,
      workdir,
      featureName: featureName,
      timeoutSeconds: naxConfig?.execution?.sessionTimeoutSeconds,
      reviewerSession: resolverSession,
      resolverContextInput: resolverSession
        ? {
            diffMode,
            ...(diffMode === "ref" ? { storyGitRef: effectiveRef, stat } : { diff }),
            story: { id: story.id, title: story.title, acceptanceCriteria: story.acceptanceCriteria },
            semanticConfig,
            resolverType: reviewStageConfig.resolver.type,
            isReReview,
          }
        : undefined,
    });
    // Track history length before to detect if the session was actually used by the resolver
    const historyLenBefore = resolverSession?.history.length ?? 0;
    const debateResult = await debateSession.run(prompt);
    const debateCost = debateResult.totalCostUsd ?? 0;

    // When the ReviewerSession was used by the resolver (history grew), use its tool-verified
    // verdict via getVerdict() instead of re-deriving from raw proposals.
    const sessionUsed = resolverSession && resolverSession.history.length > historyLenBefore;
    if (sessionUsed) {
      const durationMs = Date.now() - startTime;
      try {
        const verdict = resolverSession.getVerdict();
        const findings = verdict.findings ?? [];
        if (!verdict.passed && findings.length > 0) {
          logger?.warn("review", `Semantic review failed (debate+dialogue): ${findings.length} findings`, {
            storyId: story.id,
            durationMs,
          });
          return {
            check: "semantic",
            success: false,
            command: "",
            exitCode: 1,
            output: `Semantic review failed:\n\n${findings.map((f) => `${f.ruleId}: ${f.message}`).join("\n")}`,
            durationMs,
            findings,
            cost: debateCost,
          };
        }
        const label = verdict.passed
          ? "Semantic review passed (debate+dialogue)"
          : "Semantic review passed (debate+dialogue, all findings non-blocking)";
        logger?.info("review", label, { storyId: story.id, durationMs });
        return {
          check: "semantic",
          success: true,
          command: "",
          exitCode: 0,
          output: label,
          durationMs,
          cost: debateCost,
        };
      } catch {
        // getVerdict() threw (e.g. session destroyed) — fall through to stateless path
        logger?.warn("review", "getVerdict() failed after debate+dialogue — falling back to stateless verdict", {
          storyId: story.id,
        });
      }
    }

    // Stateless fallback: re-derive verdict from proposals (existing behavior)
    const resolverPassed = debateResult.outcome === "passed";
    const allFindings: LLMFinding[] = [];
    for (const p of debateResult.proposals) {
      const parsed = parseLLMResponse(p.output);
      if (parsed) {
        allFindings.push(...parsed.findings);
      }
    }

    // Deduplicate findings by AC id (primary) or file:line (fallback)
    const seen = new Set<string>();
    const deduped: LLMFinding[] = [];
    for (const f of allFindings) {
      const key = f.acId ?? `${f.file}:${f.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(f);
      }
    }

    // Filter non-blocking findings from debate results
    const debateBlocking = deduped.filter((f) => isBlockingSeverity(f.severity));

    const durationMs = Date.now() - startTime;
    if (!resolverPassed) {
      if (debateBlocking.length > 0) {
        logger?.warn("review", `Semantic review failed (debate): ${debateBlocking.length} findings`, {
          storyId: story.id,
          durationMs,
        });
        return {
          check: "semantic",
          success: false,
          command: "",
          exitCode: 1,
          output: `Semantic review failed:\n\n${formatFindings(debateBlocking)}`,
          durationMs,
          findings: toReviewFindings(debateBlocking),
          cost: debateCost,
        };
      }
      // All findings were non-blocking — override to pass
      logger?.info("review", "Semantic review passed (debate, all findings non-blocking)", {
        storyId: story.id,
        durationMs,
      });
      return {
        check: "semantic",
        success: true,
        command: "",
        exitCode: 0,
        output: "Semantic review passed (debate, all findings were unverifiable or informational)",
        durationMs,
        cost: debateCost,
      };
    }
    logger?.info("review", "Semantic review passed (debate)", { storyId: story.id, durationMs });
    return {
      check: "semantic",
      success: true,
      command: "",
      exitCode: 0,
      output: "Semantic review passed",
      durationMs,
      cost: debateCost,
    };
  }

  // Check if implementer session exists (fail-open — proceed regardless)
  const implementerSidecarKey = `${story.id}:implementer`;
  const existingSession = await _semanticDeps.readAcpSession(workdir, featureName ?? "", implementerSidecarKey);
  if (!existingSession) {
    logger?.debug("semantic", "implementer session not found — semantic review running in new session", {
      storyId: story.id,
    });
  }

  // Call LLM via agent.run() targeting the implementer session
  const implementerSessionName = buildSessionName(workdir, featureName, story.id, "implementer");
  const defaultAgent = naxConfig?.autoMode?.defaultAgent ?? "claude";
  let resolvedModelDef = { provider: "anthropic", model: "claude-sonnet-4-5-20250514" };
  try {
    if (naxConfig?.models) {
      resolvedModelDef = resolveModelForAgent(naxConfig.models, defaultAgent, semanticConfig.modelTier, defaultAgent);
    }
  } catch {
    // Use default model if resolution fails
  }
  let rawResponse: string;
  let llmCost = 0;
  try {
    const runResult = await agent.run({
      prompt,
      workdir,
      acpSessionName: implementerSessionName,
      keepSessionOpen: true,
      timeoutSeconds: semanticConfig.timeoutMs ? Math.ceil(semanticConfig.timeoutMs / 1000) : 3600,
      modelTier: semanticConfig.modelTier,
      modelDef: resolvedModelDef,
      pipelineStage: "review",
      config: naxConfig ?? DEFAULT_CONFIG,
      featureName,
      storyId: story.id,
      sessionRole: "reviewer-semantic",
    });
    rawResponse = runResult.output;
    llmCost = runResult.estimatedCost ?? 0;
  } catch (err) {
    logger?.warn("semantic", "LLM call failed — fail-open", { storyId: story.id, cause: String(err) });
    return {
      check: "semantic",
      success: true,
      command: "",
      exitCode: 0,
      output: `skipped: LLM call failed — ${String(err)}`,
      durationMs: Date.now() - startTime,
    };
  }

  // Parse response — fail-closed when LLM clearly intended to fail,
  // fail-open only when response is truly unparseable with no signal.
  const parsed = parseLLMResponse(rawResponse);
  if (!parsed) {
    // Check if truncated response contains "passed": false — LLM intended to fail
    // but output was cut off mid-response. Treating this as a pass is incorrect (#105).
    const looksLikeFail = /"passed"\s*:\s*false/.test(rawResponse);
    if (looksLikeFail) {
      logger?.warn("semantic", "LLM returned truncated JSON with passed:false — treating as failure", {
        storyId: story.id,
        rawResponse: rawResponse.slice(0, 200),
      });
      return {
        check: "semantic",
        success: false,
        command: "",
        exitCode: 1,
        output:
          "semantic review: LLM response truncated but indicated failure (passed:false found in partial response)",
        durationMs: Date.now() - startTime,
        cost: llmCost,
      };
    }

    logger?.warn("semantic", "LLM returned invalid JSON — fail-open", {
      storyId: story.id,
      rawResponse: rawResponse.slice(0, 200),
    });
    return {
      check: "semantic",
      success: true,
      command: "",
      exitCode: 0,
      output: "semantic review: could not parse LLM response (fail-open)",
      durationMs: Date.now() - startTime,
      cost: llmCost,
    };
  }

  // Split findings into blocking (error/warn) and non-blocking (unverifiable/info)
  const blockingFindings = parsed.findings.filter((f) => isBlockingSeverity(f.severity));
  const nonBlockingFindings = parsed.findings.filter((f) => !isBlockingSeverity(f.severity));

  if (nonBlockingFindings.length > 0) {
    logger?.debug(
      "review",
      `Semantic review: ${nonBlockingFindings.length} non-blocking findings (unverifiable/info)`,
      {
        storyId: story.id,
        findings: nonBlockingFindings.map((f) => ({ severity: f.severity, file: f.file, issue: f.issue })),
      },
    );
  }

  // Format findings and populate structured ReviewFinding[]
  if (!parsed.passed && blockingFindings.length > 0) {
    const durationMs = Date.now() - startTime;
    logger?.warn("review", `Semantic review failed: ${blockingFindings.length} findings`, {
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
      cost: llmCost,
    };
  }

  // If LLM said failed but all findings are non-blocking, override to pass
  if (!parsed.passed && blockingFindings.length === 0) {
    const durationMs = Date.now() - startTime;
    logger?.info("review", "Semantic review passed (all findings non-blocking)", { storyId: story.id, durationMs });
    return {
      check: "semantic",
      success: true,
      command: "",
      exitCode: 0,
      output: "Semantic review passed (all findings were unverifiable or informational)",
      durationMs,
      cost: llmCost,
    };
  }

  const durationMs = Date.now() - startTime;
  if (parsed.passed) {
    logger?.info("review", "Semantic review passed", { storyId: story.id, durationMs });
  }
  return {
    check: "semantic",
    success: parsed.passed,
    command: "",
    exitCode: parsed.passed ? 0 : 1,
    output: parsed.passed ? "Semantic review passed" : "Semantic review failed (no findings)",
    durationMs,
    cost: llmCost,
  };
}
