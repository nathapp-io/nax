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
import { resolveModelForAgent } from "../config/schema-types";
import { filterContextByRole } from "../context";
import { createContextToolRuntime } from "../context/engine";
import { DebateRunner } from "../debate";
import type { DebateRunnerOptions } from "../debate";
import { getSafeLogger } from "../logger";
import type { ReviewFinding } from "../plugins/types";
import type { UserStory } from "../prd";
import { ReviewPromptBuilder } from "../prompts";
import { formatSessionName } from "../session/naming";
import { resolveReviewExcludePatterns, resolveTestFilePatterns } from "../test-runners";
import { tryParseLLMJson } from "../utils/llm-json";
import type { NaxIgnoreIndex } from "../utils/path-filters";
import { DIFF_CAP_BYTES, collectDiff, collectDiffStat, resolveEffectiveRef, truncateDiff } from "./diff-utils";
import { writeReviewAudit } from "./review-audit";
import { looksLikeTruncatedJson } from "./truncation";
import type { ReviewCheckResult, SemanticReviewConfig, SemanticStory } from "./types";

// Re-export so existing callers (`import type { SemanticStory } from "./semantic"`) keep working.
export type { SemanticStory };

/** Injectable dependencies for semantic.ts — allows tests to mock without mock.module() */
export const _semanticDeps = {
  createDebateRunner: (opts: DebateRunnerOptions): DebateRunner => new DebateRunner(opts),
  writeReviewAudit,
};

interface LLMFinding {
  severity: string;
  file: string;
  line: number;
  issue: string;
  suggestion: string;
  acId?: string;
  verifiedBy?: {
    command?: string;
    file: string;
    line?: number;
    observed: string;
  };
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

/**
 * Severity rank for threshold comparison.
 * "unverifiable" is treated as info (non-blocking by default).
 */
const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  unverifiable: 0,
  low: 1,
  warning: 1,
  error: 2,
  critical: 3,
};

const UNVERIFIED_FINDING_PATTERNS = [
  "cannot verify",
  "can't verify",
  "from diff alone",
  "missing from diff",
  "not found in diff",
  "not present in diff",
  "does not appear in diff",
] as const;

/**
 * Check whether a normalized finding severity meets or exceeds the blocking threshold.
 * threshold defaults to "error" — only error/critical block unless configured stricter.
 */
function isBlockingSeverity(sev: string, threshold: "error" | "warning" | "info" = "error"): boolean {
  return (SEVERITY_RANK[sev] ?? 0) >= (SEVERITY_RANK[threshold] ?? 2);
}

/** Ref-mode semantic errors must prove they were verified against current files. */
function sanitizeRefModeFindings(findings: LLMFinding[], diffMode: SemanticReviewConfig["diffMode"]): LLMFinding[] {
  if (diffMode !== "ref") return findings;
  return findings.map((finding) =>
    needsDowngradeForMissingEvidence(finding) ? downgradeToUnverifiable(finding) : finding,
  );
}

function needsDowngradeForMissingEvidence(finding: LLMFinding): boolean {
  if ((SEVERITY_RANK[finding.severity] ?? 0) < SEVERITY_RANK.error) return false;
  return mentionsUnverifiedSource(finding) || !hasVerifiedEvidence(finding);
}

function mentionsUnverifiedSource(finding: LLMFinding): boolean {
  const text = `${finding.issue} ${finding.suggestion}`.toLowerCase();
  return UNVERIFIED_FINDING_PATTERNS.some((pattern) => text.includes(pattern));
}

function hasVerifiedEvidence(finding: LLMFinding): boolean {
  const evidence = finding.verifiedBy;
  return !!evidence?.file?.trim() && !!evidence.observed?.trim();
}

function downgradeToUnverifiable(finding: LLMFinding): LLMFinding {
  return {
    ...finding,
    severity: "unverifiable",
  };
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
    // Safe: reviewDebateEnabled guard confirms naxConfig.debate.stages.review is defined
    const reviewStageConfig = naxConfig?.debate?.stages.review as import("../debate").DebateStageConfig;
    const isReReview = resolverSession !== undefined && resolverSession.history.length > 0;
    const semanticEffectiveConfig = naxConfig ?? DEFAULT_CONFIG;
    const semanticAgentName =
      agentManager && typeof (agentManager as IAgentManager).getDefault === "function"
        ? (agentManager as IAgentManager).getDefault()
        : "claude";
    const semanticCallCtx: import("../operations/types").CallContext = {
      runtime: {
        agentManager: agentManager ?? ({} as import("../agents").IAgentManager),
        sessionManager: undefined as unknown as import("../session").ISessionManager,
        configLoader: { current: () => semanticEffectiveConfig } as import("../config").ConfigLoader,
        packages: {
          resolve: () => ({
            config: semanticEffectiveConfig,
            select: (sel: { select: (c: import("../config").NaxConfig) => unknown }) =>
              sel.select(semanticEffectiveConfig),
          }),
        } as unknown as import("../runtime").PackageRegistry,
        runId: "semantic-review",
        workdir,
        projectDir: workdir,
        costAggregator: undefined as unknown as import("../runtime").ICostAggregator,
        promptAuditor: undefined as unknown as import("../runtime").IPromptAuditor,
        logger: undefined as unknown as import("../logger").Logger,
        signal: undefined as unknown as AbortSignal,
        close: async () => {},
      } as import("../runtime").NaxRuntime,
      packageView: {
        config: semanticEffectiveConfig,
        select: (sel: { select: (c: import("../config").NaxConfig) => unknown }) => sel.select(semanticEffectiveConfig),
      } as unknown as import("../runtime").PackageView,
      packageDir: workdir,
      agentName: semanticAgentName,
      storyId: story.id,
      featureName,
    };
    const debateRunner = _semanticDeps.createDebateRunner({
      ctx: semanticCallCtx,
      stage: "review",
      stageConfig: reviewStageConfig,
      config: semanticEffectiveConfig,
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
    const debateResult = await debateRunner.run(prompt);
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

    // Split debate findings by blocking threshold
    const debateFindings = sanitizeRefModeFindings(deduped, diffMode);
    const debateThreshold = blockingThreshold ?? "error";
    const debateBlocking = debateFindings.filter((f) => isBlockingSeverity(f.severity, debateThreshold));
    const debateAdvisory = debateFindings.filter((f) => !isBlockingSeverity(f.severity, debateThreshold));

    const durationMs = Date.now() - startTime;
    if (!resolverPassed) {
      if (debateBlocking.length > 0) {
        logger?.warn("review", `Semantic review failed (debate): ${debateBlocking.length} blocking findings`, {
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
          advisoryFindings: debateAdvisory.length > 0 ? toReviewFindings(debateAdvisory) : undefined,
          cost: debateCost,
        };
      }
      // All findings were advisory — override to pass
      logger?.info("review", "Semantic review passed (debate, all findings below blocking threshold)", {
        storyId: story.id,
        durationMs,
      });
      return {
        check: "semantic",
        success: true,
        command: "",
        exitCode: 0,
        output: "Semantic review passed (debate, all findings were advisory — below blocking threshold)",
        durationMs,
        advisoryFindings: debateAdvisory.length > 0 ? toReviewFindings(debateAdvisory) : undefined,
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
      advisoryFindings: debateAdvisory.length > 0 ? toReviewFindings(debateAdvisory) : undefined,
      cost: debateCost,
    };
  }

  // Call LLM via agent.run() with own reviewer session (not the implementer session).
  // The reviewer works from diff + tools, not from implementer conversation history.
  // See #414: supersedes #262 US-003 session-sharing design.
  const reviewerSessionName = formatSessionName({
    workdir,
    featureName,
    storyId: story.id,
    role: "reviewer-semantic",
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
  const defaultAgent = agentManager.getDefault();
  const adapter = agentManager.getAgent(defaultAgent);
  let resolvedModelDef = { provider: "anthropic", model: "claude-sonnet-4-5-20250514" };
  try {
    if (naxConfig?.models) {
      resolvedModelDef = resolveModelForAgent(naxConfig.models, defaultAgent, semanticConfig.modelTier, defaultAgent);
    }
  } catch {
    // Use default model if resolution fails
  }

  const runOpts = {
    workdir,
    timeoutSeconds: semanticConfig.timeoutMs ? Math.ceil(semanticConfig.timeoutMs / 1000) : 3600,
    modelTier: semanticConfig.modelTier,
    modelDef: resolvedModelDef,
    pipelineStage: "review",
    config: naxConfig ?? DEFAULT_CONFIG,
    featureName,
    storyId: story.id,
    sessionRole: "reviewer-semantic",
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

  let rawResponse: string;
  let llmCost = 0;
  let retryAttempted = false;
  try {
    // keepOpen: true — session stays alive so the JSON retry prompt has
    // full conversation history. Closed explicitly below on the happy path, or
    // by the retry call (keepOpen: false) when a retry is needed.
    const runResult = await agentManager.run({ runOptions: { prompt, ...runOpts, keepOpen: true } });
    rawResponse = runResult.output;
    llmCost = runResult.estimatedCost ?? 0;
    logger?.debug("semantic", "LLM call complete", {
      storyId: story.id,
      responseLen: rawResponse.length,
      estimatedCost: llmCost,
    });
  } catch (err) {
    logger?.warn("semantic", "LLM call failed — fail-open", { storyId: story.id, cause: String(err) });
    void adapter?.closePhysicalSession(reviewerSessionName, workdir);
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

  // Detect cap truncation before attempting parse — the ACP adapter tail-truncates
  // output at MAX_AGENT_OUTPUT_CHARS, so a near-cap response is corrupted JSON and
  // parsing it is pointless. Go straight to condensed retry in that case.
  // For short unparseable responses (model misbehaved), use the standard retry.
  const isTruncated = looksLikeTruncatedJson(rawResponse);
  if (isTruncated || !parseLLMResponse(rawResponse)) {
    retryAttempted = true;
    const retryPrompt = isTruncated ? ReviewPromptBuilder.jsonRetryCondensed() : ReviewPromptBuilder.jsonRetry();
    logger?.info("semantic", "JSON parse failed, retrying (1/1)", {
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
      llmCost += retryResult.estimatedCost ?? 0;
      if (parseLLMResponse(rawResponse)) {
        logger?.info("semantic", "JSON retry succeeded", {
          storyId: story.id,
          responseLen: rawResponse.length,
        });
      }
    } catch (err) {
      logger?.warn("semantic", "JSON retry call failed", { storyId: story.id, cause: String(err) });
    }
  }

  // Close the session — covers both the happy path (no retry) and the retry-exhausted
  // path (retry threw or returned unparseable JSON, so keepOpen: false on the
  // retry call may not have closed it). Best-effort: already-closed sessions no-op.
  void adapter?.closePhysicalSession(reviewerSessionName, workdir);

  // Parse response — fail-closed when LLM clearly intended to fail,
  // fail-open only when response is truly unparseable with no signal.
  const parsed = parseLLMResponse(rawResponse);
  if (!parsed) {
    // Check if truncated response contains "passed": false — LLM intended to fail
    // but output was cut off mid-response. Treating this as a pass is incorrect (#105).
    const looksLikeFail = /"passed"\s*:\s*false/.test(rawResponse);
    if (naxConfig?.review?.audit?.enabled) {
      void _semanticDeps.writeReviewAudit({
        reviewer: "semantic",
        sessionName: reviewerSessionName,
        workdir,
        storyId: story.id,
        featureName,
        parsed: false,
        looksLikeFail,
        result: null,
      });
    }
    if (looksLikeFail) {
      logger?.warn("semantic", "LLM returned truncated JSON with passed:false — treating as failure", {
        storyId: story.id,
        retryAttempted,
        rawHead: rawResponse.slice(0, 200),
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

    logger?.warn("semantic", "Retry exhausted — fail-open", {
      storyId: story.id,
      retries: retryAttempted ? 1 : 0,
      rawHead: rawResponse.slice(0, 200),
      responseLen: rawResponse.length,
    });
    return {
      check: "semantic",
      success: true,
      failOpen: true,
      command: "",
      exitCode: 0,
      output: "semantic review: could not parse LLM response (fail-open)",
      durationMs: Date.now() - startTime,
      cost: llmCost,
    };
  }

  const sanitizedFindings = sanitizeRefModeFindings(parsed.findings, diffMode);
  const sanitizedParsed: LLMResponse = { ...parsed, findings: sanitizedFindings };

  if (naxConfig?.review?.audit?.enabled) {
    void _semanticDeps.writeReviewAudit({
      reviewer: "semantic",
      sessionName: reviewerSessionName,
      workdir,
      storyId: story.id,
      featureName,
      parsed: true,
      result: { passed: sanitizedParsed.passed, findings: sanitizedParsed.findings },
    });
  }

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
