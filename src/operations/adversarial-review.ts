import { ParseValidationError, makeParseRetryStrategy } from "../agents/retry";
import { reviewConfigSelector } from "../config";
import type { ReviewConfig } from "../config/selectors";
import type { Finding, Iteration } from "../findings";
import { getSafeLogger } from "../logger";
import { AdversarialReviewPromptBuilder, ReviewPromptBuilder } from "../prompts";
import type { TestInventory } from "../prompts";
import {
  isBlockingSeverity,
  toAdversarialReviewFindings,
  validateAdversarialShape,
} from "../review/adversarial-helpers";
import type { AdversarialLLMFinding } from "../review/adversarial-helpers";
import {
  checkFindingEvidence,
  downgradeUnsubstantiatedFinding,
  filterByAcQuote,
  substantiateAdversarialFindings,
} from "../review/finding-filters";
import type { AcQuoteRejectionCode } from "../review/finding-filters";
import { parseRequoteResponse } from "../review/requote-response";
import type { AdversarialReviewConfig, SemanticStory } from "../review/types";
import { tryParseLLMJson } from "../utils/llm-json";
import type { HopBodyContext, RunOperation } from "./types";

export type { AdversarialReviewConfig, SemanticStory, TestInventory };

export interface AdversarialReviewInput {
  /** Absolute path to the package workdir — required by verify() for evidence substantiation. */
  workdir: string;
  story: SemanticStory;
  adversarialConfig: AdversarialReviewConfig;
  mode: "embedded" | "ref";
  diff?: string;
  storyGitRef?: string;
  stat?: string;
  testInventory?: TestInventory;
  testGlobs?: readonly string[];
  excludePatterns?: string[];
  refExcludePatterns?: readonly string[];
  /** Pre-built, role-filtered context prefix to prepend to the review prompt. */
  featureCtxBlock?: string;
  /** Prior adversarial review iterations to carry forward into this round (ADR-022 phase 5). */
  priorAdversarialIterations?: Iteration[];
  /** Severity threshold from review config — drives the JSON-retry condensation prompt. */
  blockingThreshold?: "error" | "warning" | "info";
}

export interface AdversarialReviewOutput {
  passed: boolean;
  /** Raw AdversarialLLMFinding[]. Consumed by `src/review/adversarial.ts`. */
  findings: unknown[];
  /**
   * Source-tagged Finding[] (`source: "adversarial-review"`), used by the rectification
   * cycle's `extractPhaseFindings` → strategy `appliesTo` routing. Populated after
   * `verify()` runs the filter pipeline; empty for fail-open / looksLikeFail outcomes.
   */
  normalizedFindings: Finding[];
  /**
   * Findings dropped by the AC-grounding filter (filterByAcQuote) in verify().
   * Used by the wrapper for counterfactual telemetry (adversarial.ts). Empty array
   * when verify() short-circuits (failOpen / looksLikeFail / no findings).
   */
  acDropped: { finding: AdversarialLLMFinding; code: AcQuoteRejectionCode }[];
  failOpen?: boolean;
  /**
   * True when the raw output could not be parsed but contained `"passed": false`.
   * Callers should treat this as a hard failure rather than fail-open.
   */
  looksLikeFail?: boolean;
}

const FAIL_OPEN: AdversarialReviewOutput = {
  passed: true,
  findings: [],
  normalizedFindings: [],
  acDropped: [],
  failOpen: true,
};

const ADVERSARIAL_REQUOTE_RECOVERED_EVENT = "review.adversarial.finding.requote_recovered";
const ADVERSARIAL_REQUOTE_FAILED_EVENT = "review.adversarial.finding.requote_failed";
const DEFAULT_MAX_REQUOTES = 5;

/**
 * Same-session requote recovery for adversarial findings with unmatched evidence.
 * Mirrors requoteBlockingFindings in semantic-review.ts for the adversarial shape.
 * Only active in ref mode when substantiation.requote is true.
 */
async function requoteBlockingAdversarialFindings(
  findings: AdversarialLLMFinding[],
  ctx: HopBodyContext<AdversarialReviewInput>,
): Promise<{ findings: AdversarialLLMFinding[]; changed: boolean; extraCostUsd: number }> {
  const threshold = ctx.input.blockingThreshold ?? "error";
  const maxRequotes = ctx.input.adversarialConfig.substantiation?.maxRequotes ?? DEFAULT_MAX_REQUOTES;
  const requoteEnabled = ctx.input.adversarialConfig.substantiation?.requote ?? true;
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

    const retry = await ctx.send(AdversarialReviewPromptBuilder.requoteVerbatim({ finding }));
    extraCostUsd += retry.estimatedCostUsd ?? 0;
    const requote = parseRequoteResponse(retry.output);
    if (!requote) {
      next[index] = downgradeUnsubstantiatedFinding({
        finding,
        storyId: ctx.input.story.id,
        event: ADVERSARIAL_REQUOTE_FAILED_EVENT,
        ...initialEvidence,
      });
      changed = true;
      continue;
    }

    const updatedFinding: AdversarialLLMFinding = {
      ...finding,
      verifiedBy: {
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
      getSafeLogger()?.info("review", "Recovered adversarial finding via same-session requote", {
        storyId: ctx.input.story.id,
        event: ADVERSARIAL_REQUOTE_RECOVERED_EVENT,
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
      event: ADVERSARIAL_REQUOTE_FAILED_EVENT,
      file: requotedEvidence.file,
      line: requotedEvidence.line,
      observed: requotedEvidence.observed,
    });
    changed = true;
  }
  return { findings: next, changed, extraCostUsd };
}

const adversarialParseRetry = (input: AdversarialReviewInput) =>
  makeParseRetryStrategy({
    validate: (parsed) => validateAdversarialShape(parsed) !== null,
    reviewerKind: "adversarial",
    maxAttempts: 2,
    prompts: {
      invalid: () => ReviewPromptBuilder.jsonRetry(),
      truncated: () => ReviewPromptBuilder.jsonRetryCondensed({ blockingThreshold: input.blockingThreshold }),
    },
    exhaustedFallback: (lastOutput) =>
      /"passed"\s*:\s*false/.test(lastOutput)
        ? { passed: false, findings: [], normalizedFindings: [], acDropped: [], looksLikeFail: true }
        : FAIL_OPEN,
    logContext: { blockingThreshold: input.blockingThreshold ?? "error" },
  });

export const adversarialReviewOp: RunOperation<AdversarialReviewInput, AdversarialReviewOutput, ReviewConfig> = {
  kind: "run",
  name: "adversarial-review",
  stage: "review",
  session: { role: "reviewer-adversarial", lifetime: "fresh" },
  config: reviewConfigSelector,
  // Issue #725 — per-call tier from user-configured AdversarialReviewConfig.model.
  model: (input) => input.adversarialConfig.model,
  timeoutMs: (input) => input.adversarialConfig.timeoutMs,
  retry: (input) => adversarialParseRetry(input),
  async hopBody(initialPrompt, ctx) {
    const turn = await ctx.sendWithParseRetry(initialPrompt);
    const parsed = validateAdversarialShape(tryParseLLMJson<Record<string, unknown>>(turn.output));
    if (!parsed) return turn;
    const requoted = await requoteBlockingAdversarialFindings(parsed.findings, ctx);
    if (!requoted.changed) return turn;
    const passed = !requoted.findings.some((finding) =>
      isBlockingSeverity(finding.severity, ctx.input.blockingThreshold ?? "error"),
    );
    return {
      ...turn,
      output: JSON.stringify({ passed, findings: requoted.findings }),
      estimatedCostUsd: (turn.estimatedCostUsd ?? 0) + requoted.extraCostUsd,
    };
  },
  build(input, _ctx) {
    const base = new AdversarialReviewPromptBuilder().buildAdversarialReviewPrompt(
      input.story,
      input.adversarialConfig,
      {
        mode: input.mode,
        diff: input.diff,
        storyGitRef: input.storyGitRef,
        stat: input.stat,
        testInventory: input.testInventory,
        excludePatterns: input.excludePatterns,
        testGlobs: input.testGlobs,
        refExcludePatterns: input.refExcludePatterns,
        priorAdversarialIterations: input.priorAdversarialIterations,
        blockingThreshold: input.blockingThreshold,
      },
    );
    const content = input.featureCtxBlock ? `${input.featureCtxBlock}${base}` : base;
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content, overridable: false },
    };
  },
  parse(output, _input, _ctx) {
    const raw = tryParseLLMJson<Record<string, unknown>>(output);
    const parsed = validateAdversarialShape(raw);
    if (parsed) {
      // Advisory split moved to verify() — parse returns raw shape with normalizedFindings:[].
      // verify() runs the full filter pipeline: substantiate → AC-ground → blocking split.
      return {
        passed: parsed.passed,
        findings: parsed.findings,
        normalizedFindings: [],
        acDropped: [],
      };
    }
    if (/"passed"\s*:\s*false/.test(output) && !/"findings"\s*:\s*\[\s*\{/.test(output)) {
      return { passed: false, findings: [], normalizedFindings: [], acDropped: [], looksLikeFail: true };
    }
    throw new ParseValidationError("[adversarial-review] parse failed: invalid JSON shape");
  },
  async verify(parsed, input, _verifyCtx) {
    if (parsed.failOpen || parsed.looksLikeFail) return parsed;
    if (parsed.findings.length === 0) return parsed;

    const threshold = input.blockingThreshold ?? "error";
    const findings = parsed.findings as AdversarialLLMFinding[];

    // 1. Substantiate evidence against HEAD source files (mirrors semantic side).
    const substantiated = await substantiateAdversarialFindings({
      findings,
      workdir: input.workdir,
      storyId: input.story.id,
      blockingThreshold: threshold,
    });

    // 2. Drop error findings not grounded in AC text (filterByAcQuote).
    const { accepted, dropped } = filterByAcQuote(substantiated, input.story.acceptanceCriteria);

    // 3. Split blocking vs advisory; normalizedFindings ⊂ blocking.
    //    Preserve the model's failure signal so wrappers can still fail-closed
    //    when passed:false survives filtering without any remaining blockers.
    const blocking = accepted.filter((f) => isBlockingSeverity(f.severity, threshold));
    const passed = parsed.passed && blocking.length === 0;

    return {
      ...parsed,
      passed,
      findings: accepted,
      normalizedFindings: toAdversarialReviewFindings(blocking),
      acDropped: dropped,
    };
  },
};
