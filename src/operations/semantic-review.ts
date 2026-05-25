import { makeParseRetryStrategy } from "../agents/retry";
import { reviewConfigSelector } from "../config";
import type { ReviewConfig } from "../config/selectors";
import type { Finding, Iteration } from "../findings";
import { getSafeLogger } from "../logger";
import { ReviewPromptBuilder } from "../prompts";
import {
  checkFindingEvidence,
  downgradeUnsubstantiatedFinding,
  filterByAcGroundingMinimal,
  isBlockingSeverity,
  sanitizeRefModeFindings,
  substantiateSemanticEvidence,
  toReviewFindings,
  validateLLMShape,
} from "../review/finding-filters";
import type { LLMFinding } from "../review/finding-filters";
import { parseRequoteResponse } from "../review/requote-response";
import type { SemanticReviewConfig, SemanticStory } from "../review/types";
import { tryParseLLMJson } from "../utils/llm-json";
import type { HopBodyContext, RunOperation } from "./types";

export type { SemanticReviewConfig, SemanticStory };

export interface SemanticReviewInput {
  workdir: string;
  story: SemanticStory;
  semanticConfig: SemanticReviewConfig;
  mode: "embedded" | "ref";
  diff?: string;
  storyGitRef?: string;
  stat?: string;
  priorSemanticIterations?: Iteration[];
  excludePatterns?: string[];
  /** Pre-built, role-filtered context prefix to prepend to the review prompt. */
  featureCtxBlock?: string;
  /** Severity threshold from review config — drives the JSON-retry condensation prompt. */
  blockingThreshold?: "error" | "warning" | "info";
}

export interface SemanticReviewOutput {
  passed: boolean;
  /** Raw LLM-shape findings (LLMFinding[]). Consumed by `src/review/semantic.ts`. */
  findings: unknown[];
  /**
   * Source-tagged Finding[] (`source: "semantic-review"`), used by the rectification
   * cycle's `extractPhaseFindings` → strategy `appliesTo` routing. Populated whenever
   * `findings` came from a successful LLM parse; empty for fail-open / looksLikeFail.
   */
  normalizedFindings: Finding[];
  failOpen?: boolean;
  /**
   * True when the raw output could not be parsed but contained `"passed": false` —
   * the agent clearly intended a failure but the response was truncated/malformed.
   * Callers should treat this as a hard failure rather than fail-open.
   */
  looksLikeFail?: boolean;
}

const FAIL_OPEN: SemanticReviewOutput = { passed: true, findings: [], normalizedFindings: [], failOpen: true };
const SEMANTIC_REQUOTE_RECOVERED_EVENT = "review.semantic.finding.requote_recovered";
const SEMANTIC_REQUOTE_FAILED_EVENT = "review.semantic.finding.requote_failed";
const DEFAULT_MAX_REQUOTES = 5;

const semanticReviewHopBody: RunOperation<SemanticReviewInput, SemanticReviewOutput, ReviewConfig>["hopBody"] = async (
  initialPrompt,
  ctx,
) => {
  const turn = await ctx.sendWithParseRetry(initialPrompt);
  const parsed = validateLLMShape(tryParseLLMJson<Record<string, unknown>>(turn.output));
  if (!parsed) return turn;
  const requoted = await requoteBlockingFindings(parsed.findings, ctx);
  if (!requoted.changed) return turn;
  const passed = !requoted.findings.some((finding) =>
    isBlockingSeverity(finding.severity, ctx.input.blockingThreshold ?? "error"),
  );
  return {
    ...turn,
    output: JSON.stringify({ passed, findings: requoted.findings }),
    estimatedCostUsd: (turn.estimatedCostUsd ?? 0) + requoted.extraCostUsd,
  };
};

export const semanticReviewOp: RunOperation<SemanticReviewInput, SemanticReviewOutput, ReviewConfig> = {
  kind: "run",
  name: "semantic-review",
  stage: "review",
  session: { role: "reviewer-semantic", lifetime: "fresh" },
  config: reviewConfigSelector,
  // Issue #725 — per-call tier from user-configured SemanticReviewConfig.model.
  // Without this resolver callOp would fall through to its "balanced" default and
  // silently ignore the user's review.semantic.model setting.
  model: (input) => input.semanticConfig.model,
  timeoutMs: (input) => input.semanticConfig.timeoutMs,
  retry: (input) =>
    makeParseRetryStrategy({
      validate: (parsed) => validateLLMShape(parsed) !== null,
      reviewerKind: "semantic",
      maxAttempts: 2,
      prompts: {
        invalid: () => ReviewPromptBuilder.jsonRetry(),
        truncated: () => ReviewPromptBuilder.jsonRetryCondensed({ blockingThreshold: input.blockingThreshold }),
      },
      exhaustedFallback: (lastOutput) =>
        /"passed"\s*:\s*false/.test(lastOutput)
          ? { passed: false, findings: [], normalizedFindings: [], looksLikeFail: true }
          : FAIL_OPEN,
      logContext: { blockingThreshold: input.blockingThreshold ?? "error" },
    }),
  hopBody: semanticReviewHopBody,
  build(input, _ctx) {
    const base = new ReviewPromptBuilder().buildSemanticReviewPrompt(input.story, input.semanticConfig, {
      mode: input.mode,
      diff: input.diff,
      storyGitRef: input.storyGitRef,
      stat: input.stat,
      priorSemanticIterations: input.priorSemanticIterations,
      excludePatterns: input.excludePatterns,
    });
    const content = input.featureCtxBlock ? `${input.featureCtxBlock}${base}` : base;
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content, overridable: false },
    };
  },
  parse(output, _input, _ctx) {
    const raw = tryParseLLMJson<Record<string, unknown>>(output);
    const parsed = validateLLMShape(raw);
    if (parsed) {
      // Advisory split and filter pipeline moved to verify() — parse returns raw shape.
      // normalizedFindings is populated by verify() after evidence substantiation
      // and AC-grounding; return empty here so verify() can set it authoritatively.
      return {
        passed: parsed.passed,
        findings: parsed.findings,
        normalizedFindings: [],
      };
    }
    if (/"passed"\s*:\s*false/.test(output)) {
      return { passed: false, findings: [], normalizedFindings: [], looksLikeFail: true };
    }
    return FAIL_OPEN;
  },
  async verify(parsed, input, _verifyCtx) {
    if (parsed.failOpen || parsed.looksLikeFail) return parsed;
    if (parsed.findings.length === 0) return parsed;

    const threshold = input.blockingThreshold ?? "error";
    const findings = parsed.findings as LLMFinding[];

    // 1. Downgrade ref-mode blocking findings with unverified evidence to "unverifiable".
    //    Downgraded findings fall below threshold and are excluded from normalizedFindings.
    const sanitized = sanitizeRefModeFindings(findings, input.mode, threshold);

    // 2. Substantiate evidence against HEAD source files.
    const substantiated = await substantiateSemanticEvidence(
      sanitized,
      input.mode,
      input.workdir,
      input.story.id,
      threshold,
    );

    // 3. Drop error findings without valid acIndex.
    const { accepted } = filterByAcGroundingMinimal(substantiated, input.story.acceptanceCriteria);

    // 4. Split blocking vs advisory; normalizedFindings ⊂ blocking.
    //    verify() is authoritative: if no blocking findings survive the pipeline,
    //    the result is passed regardless of the LLM's prior verdict.
    const blocking = accepted.filter((f) => isBlockingSeverity(f.severity, threshold));
    const passed = blocking.length === 0;

    return {
      ...parsed,
      passed,
      findings: accepted,
      normalizedFindings: toReviewFindings(blocking),
    };
  },
};

async function requoteBlockingFindings(
  findings: LLMFinding[],
  ctx: HopBodyContext<SemanticReviewInput>,
): Promise<{ findings: LLMFinding[]; changed: boolean; extraCostUsd: number }> {
  const threshold = ctx.input.blockingThreshold ?? "error";
  const maxRequotes = ctx.input.semanticConfig.substantiation?.maxRequotes ?? DEFAULT_MAX_REQUOTES;
  const requoteEnabled = ctx.input.semanticConfig.substantiation?.requote ?? true;
  if (ctx.input.mode !== "ref" || !requoteEnabled || maxRequotes <= 0) {
    return { findings, changed: false, extraCostUsd: 0 };
  }
  const next = [...findings];
  let changed = false;
  let extraCostUsd = 0;
  let used = 0;
  for (const [index, finding] of next.entries()) {
    if (!isBlockingSeverity(finding.severity, threshold)) continue;
    const initialEvidence = await checkFindingEvidence({ finding, workdir: ctx.input.workdir });
    if (initialEvidence.status !== "unmatched") continue;
    if (used >= maxRequotes) break;
    used += 1;

    const retry = await ctx.send(ReviewPromptBuilder.requoteVerbatim({ finding }));
    extraCostUsd += retry.estimatedCostUsd ?? 0;
    const requote = parseRequoteResponse(retry.output);
    if (!requote) {
      next[index] = downgradeUnsubstantiatedFinding({
        finding,
        storyId: ctx.input.story.id,
        event: SEMANTIC_REQUOTE_FAILED_EVENT,
        ...initialEvidence,
      });
      changed = true;
      continue;
    }

    const updatedFinding: LLMFinding = {
      ...finding,
      verifiedBy: {
        command: finding.verifiedBy?.command,
        file: requote.file,
        line: requote.line,
        observed: requote.observed,
      },
    };
    const requotedEvidence = await checkFindingEvidence({
      finding: updatedFinding,
      workdir: ctx.input.workdir,
    });
    if (requotedEvidence.status === "matched") {
      getSafeLogger()?.info("review", "Recovered semantic finding via same-session requote", {
        storyId: ctx.input.story.id,
        event: SEMANTIC_REQUOTE_RECOVERED_EVENT,
        file: requotedEvidence.file,
        line: requotedEvidence.line,
      });
      next[index] = updatedFinding;
      changed = true;
      continue;
    }

    next[index] = downgradeUnsubstantiatedFinding({
      finding: updatedFinding,
      storyId: ctx.input.story.id,
      event: SEMANTIC_REQUOTE_FAILED_EVENT,
      file: requotedEvidence.file,
      line: requotedEvidence.line,
      observed: requotedEvidence.observed,
    });
    changed = true;
  }
  return { findings: next, changed, extraCostUsd };
}
