/**
 * Semantic Review — Debate path.
 * Extracted from semantic.ts to stay within the 600-line file limit.
 *
 * Handles the `debate.enabled && debate.stages.review.enabled` path in
 * runSemanticReview. Always returns a ReviewCheckResult.
 */

import type { IAgentManager } from "../agents";
import type { ReviewConfig } from "../config/selectors";
import type { DebateRunner, DebateRunnerOptions, DebateStageConfig } from "../debate";
import { pickBaseSelectorKind } from "../debate";
import { getSafeLogger } from "../logger";
import { filterByAcGroundingMinimal } from "./ac-quote-validator";
import { MAX_ACKS } from "./acks";
import { llmFindingsToReviewFindings } from "./finding-projection";
import { normalizeIssueText } from "./recurrence-demotion";
import {
  formatFindings,
  isBlockingSeverity,
  type LLMFinding,
  parseLLMResponse,
  sanitizeRefModeFindings,
  toReviewFindings,
} from "./semantic-helpers";
import type { ReviewAck, ReviewCheckResult, SemanticReviewConfig, SemanticStory } from "./types";

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
  /** #1423 — prior findings resolved or withdrawn, recorded outside `result.findings`. */
  acks?: ReviewAck[];
}): void {
  opts.runtime.dispatchEvents.emitReviewDecision({
    kind: "review-decision",
    reviewer: "semantic",
    workdir: opts.workdir,
    storyId: opts.storyId,
    featureName: opts.featureName,
    timestamp: Date.now(),
    parsed: opts.parsed,
    failOpen: false,
    passed: opts.passed,
    blockingThreshold: opts.blockingThreshold,
    result: opts.result,
    advisoryFindings: opts.advisoryFindings,
    acks: opts.acks,
  });
}

export interface SemanticDebateOptions {
  naxConfig: ReviewConfig;
  runtime: import("../runtime").NaxRuntime;
  workdir: string;
  agentManager: IAgentManager;
  featureName: string | undefined;
  story: SemanticStory;
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
  /**
   * Test-file classifier from the caller's resolved patterns. Keeps a debate
   * finding about a test file in the test lane (#1368) — debate findings, like
   * plain semantic ones, otherwise default to `fixTarget: "source"`.
   */
  isTestFile?: (path: string) => boolean;
}

export async function runSemanticDebate(opts: SemanticDebateOptions): Promise<ReviewCheckResult> {
  const {
    naxConfig,
    runtime,
    workdir,
    agentManager,
    featureName,
    story,
    diffMode,
    startTime,
    prompt,
    blockingThreshold,
    createDebateRunner,
    isTestFile,
  } = opts;
  const logger = getSafeLogger();
  // Safe: reviewDebateEnabled guard (in caller) confirms naxConfig.debate.stages.review is defined
  const configuredStageConfig = naxConfig.debate?.stages.review as import("../debate").DebateStageConfig;
  // Explicit composition: review debate is always panel one-shot with the resolver-derived
  // base selector and review-grounding-filter verifier. (Historically forced "dialogue-verdict",
  // which always fell through to this same base selector because no ReviewerSession was ever
  // produced — see 2026-05-29 ReviewerSession removal plan.)
  const reviewStageConfig: import("../debate").DebateStageConfig = {
    ...configuredStageConfig,
    sessionMode: "one-shot" as const,
    mode: "panel" as const,
    selector: { kind: pickBaseSelectorKind(configuredStageConfig) } as unknown as DebateStageConfig["selector"],
    postDebateVerifier: { kind: "review-grounding-filter" },
  };
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
  });
  const debateResult = await debateRunner.run(prompt);
  const debateCost = debateResult.totalCostUsd ?? 0;

  // Re-derive verdict from proposals (stateless path)
  const resolverPassed = debateResult.outcome === "passed";
  const allFindings: LLMFinding[] = [];
  // #1423 — acknowledgements ride the same proposals as findings; without this
  // a project running review debate would record no ack telemetry at all.
  const acks: ReviewAck[] = [];
  for (const p of debateResult.proposals) {
    const parsed = parseLLMResponse(p.output);
    if (parsed) {
      allFindings.push(...parsed.findings);
      // `extractAcks` caps each response; the merge across debaters has to
      // respect the same ceiling or a 3-debater panel persists 3 × MAX_ACKS.
      if (parsed.acks) acks.push(...parsed.acks.slice(0, MAX_ACKS - acks.length));
    }
  }
  const debateAcks = acks.length > 0 ? acks : undefined;

  // Deduplicate findings by AC id (primary), then file + normalized issue text
  // (fallback). BUG-27: keying on file:line alone collapses two distinct
  // defects that share a line into one, hiding the second from blocking
  // classification and recurrence fingerprints. Including the normalized
  // issue text (mirroring the prose fallback in fingerprintFor) keeps
  // multiple defects within the same AC/file/line distinct.
  const seen = new Set<string>();
  const deduped: LLMFinding[] = [];
  for (const f of allFindings) {
    const key = f.acId ?? `${f.file ?? ""}|${normalizeIssueText(f.issue).slice(0, 48)}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(f);
    }
  }

  // Split debate findings by blocking threshold — drop ungrounded error findings first
  const debateThreshold = blockingThreshold ?? "error";
  const sanitized = sanitizeRefModeFindings(deduped, diffMode, debateThreshold);
  const { accepted: debateFindings, dropped: acDropped } = filterByAcGroundingMinimal(
    sanitized,
    story.acceptanceCriteria ?? [],
  );
  if (acDropped.length > 0) {
    logger?.warn("review", "Semantic debate findings dropped: acIndex missing or out of range", {
      storyId: story.id,
      dropped: acDropped.length,
    });
  }
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
        acks: debateAcks,
        passed: false,
        blockingThreshold: debateThreshold,
        result: {
          passed: false,
          findings: llmFindingsToReviewFindings(debateFindings, { source: "semantic-debate-review", isTestFile }),
        },
        advisoryFindings:
          debateAdvisory.length > 0
            ? llmFindingsToReviewFindings(debateAdvisory, { source: "semantic-debate-review", isTestFile })
            : undefined,
      });
      return {
        check: "semantic",
        success: false,
        command: "",
        exitCode: 1,
        output: `Semantic review failed:\n\n${formatFindings(debateBlocking)}`,
        durationMs,
        findings: toReviewFindings(debateBlocking, { isTestFile }),
        advisoryFindings: debateAdvisory.length > 0 ? toReviewFindings(debateAdvisory, { isTestFile }) : undefined,
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
      acks: debateAcks,
      passed: true,
      blockingThreshold: debateThreshold,
      result: {
        passed: true,
        findings: llmFindingsToReviewFindings(debateFindings, { source: "semantic-debate-review", isTestFile }),
      },
      advisoryFindings:
        debateAdvisory.length > 0
          ? llmFindingsToReviewFindings(debateAdvisory, { source: "semantic-debate-review", isTestFile })
          : undefined,
    });
    return {
      check: "semantic",
      success: true,
      command: "",
      exitCode: 0,
      output: "Semantic review passed (debate, all findings were advisory — below blocking threshold)",
      durationMs,
      advisoryFindings: debateAdvisory.length > 0 ? toReviewFindings(debateAdvisory, { isTestFile }) : undefined,
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
    acks: debateAcks,
    passed: true,
    blockingThreshold: debateThreshold,
    result: {
      passed: true,
      findings: llmFindingsToReviewFindings(debateFindings, { source: "semantic-debate-review", isTestFile }),
    },
    advisoryFindings:
      debateAdvisory.length > 0
        ? llmFindingsToReviewFindings(debateAdvisory, { source: "semantic-debate-review", isTestFile })
        : undefined,
  });
  return {
    check: "semantic",
    success: true,
    command: "",
    exitCode: 0,
    output: "Semantic review passed",
    durationMs,
    advisoryFindings: debateAdvisory.length > 0 ? toReviewFindings(debateAdvisory, { isTestFile }) : undefined,
    cost: debateCost,
  };
}
