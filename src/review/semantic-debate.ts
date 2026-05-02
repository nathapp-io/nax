/**
 * Semantic Review — Debate path.
 * Extracted from semantic.ts to stay within the 600-line file limit.
 *
 * Handles the `debate.enabled && debate.stages.review.enabled` path in
 * runSemanticReview. Always returns a ReviewCheckResult.
 */

import type { IAgentManager } from "../agents";
import type { NaxConfig } from "../config";
import type { ReviewConfig } from "../config/selectors";
import type { DebateRunner, DebateRunnerOptions } from "../debate";
import { getSafeLogger } from "../logger";
import {
  type LLMFinding,
  formatFindings,
  isBlockingSeverity,
  parseLLMResponse,
  sanitizeRefModeFindings,
  toReviewFindings,
} from "./semantic-helpers";
import type { SemanticReviewConfig } from "./types";
import type { ReviewCheckResult, SemanticStory } from "./types";

function recordSemanticDebateAudit(opts: {
  runtime: import("../runtime").NaxRuntime;
  workdir: string;
  storyId: string;
  featureName?: string;
  parsed: boolean;
  passed: boolean;
  blockingThreshold?: "error" | "warning" | "info";
  result: { passed: boolean; findings: unknown[] } | null;
  advisoryFindings?: unknown[];
}): void {
  opts.runtime.reviewAuditor.recordDecision({
    reviewer: "semantic",
    workdir: opts.workdir,
    storyId: opts.storyId,
    featureName: opts.featureName,
    parsed: opts.parsed,
    failOpen: false,
    passed: opts.passed,
    blockingThreshold: opts.blockingThreshold,
    result: opts.result,
    advisoryFindings: opts.advisoryFindings,
  });
}

export interface SemanticDebateOptions {
  naxConfig: ReviewConfig;
  runtime: import("../runtime").NaxRuntime;
  workdir: string;
  agentManager: IAgentManager;
  featureName: string | undefined;
  story: SemanticStory;
  resolverSession: import("./dialogue").ReviewerSession | undefined;
  diffMode: NonNullable<SemanticReviewConfig["diffMode"]>;
  diff: string | undefined;
  stat: string | undefined;
  semanticConfig: SemanticReviewConfig;
  effectiveRef: string;
  startTime: number;
  prompt: string;
  productionExcludePatterns: readonly string[];
  blockingThreshold: "error" | "warning" | "info" | undefined;
  createDebateRunner: (opts: DebateRunnerOptions) => DebateRunner;
}

export async function runSemanticDebate(opts: SemanticDebateOptions): Promise<ReviewCheckResult> {
  const {
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
    productionExcludePatterns,
    blockingThreshold,
    createDebateRunner,
  } = opts;
  const logger = getSafeLogger();
  // Safe: reviewDebateEnabled guard (in caller) confirms naxConfig.debate.stages.review is defined
  const configuredStageConfig = naxConfig.debate?.stages.review as import("../debate").DebateStageConfig;
  const reviewStageConfig =
    configuredStageConfig.sessionMode === "one-shot" && (configuredStageConfig.mode ?? "panel") === "panel"
      ? configuredStageConfig
      : {
          ...configuredStageConfig,
          // Review debate currently supports panel one-shot only.
          sessionMode: "one-shot" as const,
          mode: "panel" as const,
        };
  if (reviewStageConfig !== configuredStageConfig) {
    logger?.warn("review", "Review debate requires sessionMode=one-shot and mode=panel — forcing safe defaults", {
      storyId: story.id,
      configuredSessionMode: configuredStageConfig.sessionMode,
      configuredMode: configuredStageConfig.mode ?? "panel",
    });
  }
  const isReReview = resolverSession !== undefined && resolverSession.history.length > 0;
  const semanticAgentName =
    agentManager && typeof (agentManager as IAgentManager).getDefault === "function"
      ? (agentManager as IAgentManager).getDefault()
      : "claude";
  const semanticCallCtx: import("../operations/types").CallContext = {
    runtime,
    packageView: runtime.packages.resolve(workdir),
    packageDir: workdir,
    agentName: semanticAgentName,
    storyId: story.id,
    featureName,
  };
  const debateRunner = createDebateRunner({
    ctx: semanticCallCtx,
    stage: "review",
    stageConfig: reviewStageConfig,
    config: naxConfig,
    workdir,
    featureName: featureName,
    timeoutSeconds: naxConfig.execution?.sessionTimeoutSeconds,
    reviewerSession: resolverSession,
    resolverContextInput: resolverSession
      ? {
          diffMode,
          ...(diffMode === "ref" ? { storyGitRef: effectiveRef, stat, productionExcludePatterns } : { diff }),
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
        recordSemanticDebateAudit({
          runtime: runtime,
          workdir,
          storyId: story.id,
          featureName,
          parsed: true,
          passed: false,
          blockingThreshold,
          result: { passed: false, findings },
        });
        return {
          check: "semantic",
          success: false,
          command: "",
          exitCode: 1,
          output: `Semantic review failed:\n\n${findings.map((f) => `${f.rule ?? "semantic"}: ${f.message}`).join("\n")}`,
          durationMs,
          findings,
          cost: debateCost,
        };
      }
      const label = verdict.passed
        ? "Semantic review passed (debate+dialogue)"
        : "Semantic review passed (debate+dialogue, all findings non-blocking)";
      logger?.info("review", label, { storyId: story.id, durationMs });
      recordSemanticDebateAudit({
        runtime: runtime,
        workdir,
        storyId: story.id,
        featureName,
        parsed: true,
        passed: true,
        blockingThreshold,
        result: { passed: true, findings },
      });
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
      recordSemanticDebateAudit({
        runtime: runtime,
        workdir,
        storyId: story.id,
        featureName,
        parsed: true,
        passed: false,
        blockingThreshold: debateThreshold,
        result: { passed: false, findings: debateFindings },
        advisoryFindings: debateAdvisory,
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
    recordSemanticDebateAudit({
      runtime: runtime,
      workdir,
      storyId: story.id,
      featureName,
      parsed: true,
      passed: true,
      blockingThreshold: debateThreshold,
      result: { passed: true, findings: debateFindings },
      advisoryFindings: debateAdvisory,
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
  recordSemanticDebateAudit({
    runtime: runtime,
    workdir,
    storyId: story.id,
    featureName,
    parsed: true,
    passed: true,
    blockingThreshold: debateThreshold,
    result: { passed: true, findings: debateFindings },
    advisoryFindings: debateAdvisory,
  });
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
