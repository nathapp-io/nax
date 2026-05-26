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
import type { AcDroppedEntry, AcQuoteRejectionCode } from "../review/finding-filters";
import { parseRequoteResponse } from "../review/requote-response";
import type { AdversarialReviewConfig, SemanticStory } from "../review/types";
import { tryParseLLMJson } from "../utils/llm-json";
import type { HopBodyContext, RunOperation } from "./types";

export type { AdversarialReviewConfig, SemanticStory, TestInventory };
export type ValidatedAdversarialShape = NonNullable<ReturnType<typeof validateAdversarialShape>>;

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
  /** Internal: set by hopBody when a reprompt occurs. Read by parse() to populate repromptEvent. */
  _repromptInfo?: {
    dropCount: number;
    outcome: "recovered-blocking" | "recovered-advisory-only" | "still-dropped" | "parse-failed";
    costUsd: number;
  };
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
  acDropped: AcDroppedEntry<AdversarialLLMFinding, AcQuoteRejectionCode>[];
  failOpen?: boolean;
  /**
   * True when the raw output could not be parsed but contained `"passed": false`.
   * Callers should treat this as a hard failure rather than fail-open.
   */
  looksLikeFail?: boolean;
  /**
   * Set when hopBody executed a reprompt (second turn). Used by adversarial.ts
   * to emit review-reprompt-on-drop telemetry event.
   */
  repromptEvent?: {
    dropCount: number;
    outcome: "recovered-blocking" | "recovered-advisory-only" | "still-dropped" | "parse-failed";
    costUsd: number;
  };
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

function evaluateRepromptTrigger(
  shape: ValidatedAdversarialShape,
  input: AdversarialReviewInput,
):
  | { shouldReprompt: false }
  | { shouldReprompt: true; acDropped: AcDroppedEntry<AdversarialLLMFinding, AcQuoteRejectionCode>[] } {
  if (input.adversarialConfig.acRegroundOnDrop === false) return { shouldReprompt: false };
  if (shape.passed) return { shouldReprompt: false };
  const { accepted, dropped } = filterByAcQuote(shape.findings, input.story.acceptanceCriteria);
  const threshold = input.blockingThreshold ?? "error";
  const blockingAccepted = accepted.filter((f) => isBlockingSeverity(f.severity, threshold));
  if (blockingAccepted.length > 0) return { shouldReprompt: false };
  if (dropped.length === 0) return { shouldReprompt: false };
  return { shouldReprompt: true, acDropped: dropped };
}

function mergeAdversarialResponses(
  first: ValidatedAdversarialShape,
  second: ValidatedAdversarialShape,
): ValidatedAdversarialShape {
  const threshold = "error";
  const secondBlocking = second.findings.filter((f) => isBlockingSeverity(f.severity, threshold));
  if (secondBlocking.length > 0) {
    return {
      passed: false,
      findings: second.findings,
    };
  }
  const firstAdvisory = first.findings.filter((f) => !isBlockingSeverity(f.severity, threshold));
  const secondAdvisory = second.findings.filter((f) => !isBlockingSeverity(f.severity, threshold));
  return {
    passed: true,
    findings: [...firstAdvisory, ...secondAdvisory],
  };
}

export const adversarialReviewOp: RunOperation<AdversarialReviewInput, AdversarialReviewOutput, ReviewConfig> = {
  kind: "run",
  name: "adversarial-review",
  stage: "review",
  session: { role: "reviewer-adversarial", lifetime: "fresh" },
  config: reviewConfigSelector,
  model: (input) => input.adversarialConfig.model,
  timeoutMs: (input) => input.adversarialConfig.timeoutMs,
  retry: (input) => adversarialParseRetry(input),
  async hopBody(initialPrompt, ctx) {
    const turn = await ctx.sendWithParseRetry(initialPrompt);
    const parsed = validateAdversarialShape(tryParseLLMJson<Record<string, unknown>>(turn.output));
    if (!parsed) return turn;

    const requoteEnabled = ctx.input.adversarialConfig.substantiation?.requote ?? true;
    const maxRequotes = ctx.input.adversarialConfig.substantiation?.maxRequotes ?? DEFAULT_MAX_REQUOTES;
    const regroundEnabled = ctx.input.adversarialConfig.acRegroundOnDrop !== false;

    if (ctx.input.mode !== "ref") return turn;

    const firstFindings = parsed.findings;
    const { accepted: firstAccepted } = filterByAcQuote(firstFindings, ctx.input.story.acceptanceCriteria);
    const firstShape: ValidatedAdversarialShape = {
      passed: parsed.passed,
      findings: firstFindings,
    };
    const trigger = evaluateRepromptTrigger(firstShape, ctx.input);
    const shouldReground =
      trigger.shouldReprompt &&
      regroundEnabled &&
      (ctx.input.adversarialConfig.acRegroundOnDrop === true || (requoteEnabled && maxRequotes > 0));
    if (shouldReground) {
      const repromptPrompt = AdversarialReviewPromptBuilder.regroundDroppedFindings({
        drops: trigger.acDropped,
        acceptanceCriteria: ctx.input.story.acceptanceCriteria,
      });
      const secondTurn = await ctx.send(repromptPrompt);
      const secondParsed = validateAdversarialShape(tryParseLLMJson<Record<string, unknown>>(secondTurn.output));

      const repromptCostUsd = (turn.estimatedCostUsd ?? 0) + (secondTurn.estimatedCostUsd ?? 0);

      if (!secondParsed) {
        ctx.input._repromptInfo = {
          dropCount: trigger.acDropped.length,
          outcome: "parse-failed",
          costUsd: repromptCostUsd,
        };
        return turn;
      }

      const { accepted: secondAccepted } = filterByAcQuote(secondParsed.findings, ctx.input.story.acceptanceCriteria);
      const secondBlocking = secondAccepted.filter((f) =>
        isBlockingSeverity(f.severity, ctx.input.blockingThreshold ?? "error"),
      );

      if (secondBlocking.length > 0) {
        ctx.input._repromptInfo = {
          dropCount: trigger.acDropped.length,
          outcome: "still-dropped",
          costUsd: repromptCostUsd,
        };
        return {
          ...turn,
          output: JSON.stringify({ passed: false, findings: secondParsed.findings }),
          estimatedCostUsd: repromptCostUsd,
        };
      }

      if (secondAccepted.length === 0) {
        ctx.input._repromptInfo = {
          dropCount: trigger.acDropped.length,
          outcome: "recovered-advisory-only",
          costUsd: repromptCostUsd,
        };
        return turn;
      }

      const firstAdvisory = firstAccepted.filter(
        (f) => !isBlockingSeverity(f.severity, ctx.input.blockingThreshold ?? "error"),
      );
      const secondAdvisory = secondAccepted.filter(
        (f) => !isBlockingSeverity(f.severity, ctx.input.blockingThreshold ?? "error"),
      );

      ctx.input._repromptInfo = {
        dropCount: trigger.acDropped.length,
        outcome: secondParsed.passed ? "recovered-advisory-only" : "recovered-blocking",
        costUsd: repromptCostUsd,
      };

      return {
        ...turn,
        output: JSON.stringify({ passed: secondParsed.passed, findings: [...firstAdvisory, ...secondAdvisory] }),
        estimatedCostUsd: repromptCostUsd,
      };
    }

    if (!requoteEnabled || maxRequotes <= 0) return turn;

    const requoted = await requoteBlockingAdversarialFindings(parsed.findings, ctx);
    if (requoted.changed) {
      const passed = !requoted.findings.some((finding) =>
        isBlockingSeverity(finding.severity, ctx.input.blockingThreshold ?? "error"),
      );
      return {
        ...turn,
        output: JSON.stringify({ passed, findings: requoted.findings }),
        estimatedCostUsd: (turn.estimatedCostUsd ?? 0) + requoted.extraCostUsd,
      };
    }

    return turn;
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
  parse(output, input, _ctx) {
    const raw = tryParseLLMJson<Record<string, unknown>>(output);
    const parsed = validateAdversarialShape(raw);
    if (parsed) {
      return {
        passed: parsed.passed,
        findings: parsed.findings,
        normalizedFindings: [],
        acDropped: [],
        repromptEvent: input._repromptInfo,
      };
    }
    if (/"passed"\s*:\s*false/.test(output) && !/"findings"\s*:\s*\[\s*\{/.test(output)) {
      return {
        passed: false,
        findings: [],
        normalizedFindings: [],
        acDropped: [],
        looksLikeFail: true,
        repromptEvent: input._repromptInfo,
      };
    }
    throw new ParseValidationError("[adversarial-review] parse failed: invalid JSON shape");
  },
  async verify(parsed, input, _verifyCtx) {
    if (parsed.failOpen || parsed.looksLikeFail) return parsed;
    if (parsed.findings.length === 0) return parsed;

    const threshold = input.blockingThreshold ?? "error";
    const findings = parsed.findings as AdversarialLLMFinding[];

    const substantiated = await substantiateAdversarialFindings({
      findings,
      workdir: input.workdir,
      storyId: input.story.id,
      blockingThreshold: threshold,
    });

    const { accepted, dropped } = filterByAcQuote(substantiated, input.story.acceptanceCriteria);

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
