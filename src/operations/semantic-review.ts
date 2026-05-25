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
import type { AcDroppedEntry, AcGroundingMinimalRejection, LLMFinding } from "../review/finding-filters";
import { parseRequoteResponse } from "../review/requote-response";
import type { SemanticReviewConfig, SemanticStory } from "../review/types";
import { tryParseLLMJson } from "../utils/llm-json";
import type { HopBodyContext, RunOperation } from "./types";

export type { SemanticReviewConfig, SemanticStory };
export type ValidatedSemanticShape = NonNullable<ReturnType<typeof validateLLMShape>>;

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
  featureCtxBlock?: string;
  blockingThreshold?: "error" | "warning" | "info";
}

export interface SemanticReviewOutput {
  passed: boolean;
  findings: unknown[];
  normalizedFindings: Finding[];
  acDropped: AcDroppedEntry<LLMFinding, AcGroundingMinimalRejection>[];
  failOpen?: boolean;
  looksLikeFail?: boolean;
}

const FAIL_OPEN: SemanticReviewOutput = {
  passed: true,
  findings: [],
  normalizedFindings: [],
  acDropped: [],
  failOpen: true,
};
const SEMANTIC_REQUOTE_RECOVERED_EVENT = "review.semantic.finding.requote_recovered";
const SEMANTIC_REQUOTE_FAILED_EVENT = "review.semantic.finding.requote_failed";
const DEFAULT_MAX_REQUOTES = 5;

function evaluateRepromptTrigger(
  shape: ValidatedSemanticShape,
  input: SemanticReviewInput,
):
  | { shouldReprompt: false }
  | { shouldReprompt: true; acDropped: AcDroppedEntry<LLMFinding, AcGroundingMinimalRejection>[] } {
  if (input.semanticConfig.acRegroundOnDrop === false) return { shouldReprompt: false };
  if (shape.passed) return { shouldReprompt: false };
  const { accepted, dropped } = filterByAcGroundingMinimal(shape.findings, input.story.acceptanceCriteria);
  const threshold = input.blockingThreshold ?? "error";
  const blockingAccepted = accepted.filter((f) => isBlockingSeverity(f.severity, threshold));
  if (blockingAccepted.length > 0) return { shouldReprompt: false };
  if (dropped.length === 0) return { shouldReprompt: false };
  return { shouldReprompt: true, acDropped: dropped };
}

const semanticReviewHopBody: RunOperation<SemanticReviewInput, SemanticReviewOutput, ReviewConfig>["hopBody"] = async (
  initialPrompt,
  ctx,
) => {
  const turn = await ctx.sendWithParseRetry(initialPrompt);
  const parsed = validateLLMShape(tryParseLLMJson<Record<string, unknown>>(turn.output));
  if (!parsed) return turn;

  const requoted = await requoteBlockingFindings(parsed.findings, ctx);
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

  if (ctx.input.mode !== "ref") return turn;

  const firstFindings = requoted.findings;
  const { accepted: firstAccepted } = filterByAcGroundingMinimal(firstFindings, ctx.input.story.acceptanceCriteria);
  const firstShape: ValidatedSemanticShape = {
    passed: parsed.passed,
    findings: firstFindings,
  };
  const trigger = evaluateRepromptTrigger(firstShape, ctx.input);
  if (!trigger.shouldReprompt) return turn;

  const repromptPrompt = ReviewPromptBuilder.regroundDroppedFindings({
    drops: trigger.acDropped,
    acceptanceCriteria: ctx.input.story.acceptanceCriteria,
  });
  const secondTurn = await ctx.send(repromptPrompt);
  const secondParsed = validateLLMShape(tryParseLLMJson<Record<string, unknown>>(secondTurn.output));
  if (!secondParsed) return turn;

  const threshold = ctx.input.blockingThreshold ?? "error";
  const { accepted: secondAccepted } = filterByAcGroundingMinimal(
    secondParsed.findings,
    ctx.input.story.acceptanceCriteria,
  );
  const secondBlocking = secondAccepted.filter((f) => isBlockingSeverity(f.severity, threshold));

  if (secondBlocking.length > 0) {
    return {
      ...turn,
      output: JSON.stringify({ passed: false, findings: secondParsed.findings }),
      estimatedCostUsd: (turn.estimatedCostUsd ?? 0) + (secondTurn.estimatedCostUsd ?? 0),
    };
  }

  if (secondAccepted.length === 0) {
    return turn;
  }

  const firstAdvisory = firstAccepted.filter((f) => !isBlockingSeverity(f.severity, threshold));
  const secondAdvisory = secondAccepted.filter((f) => !isBlockingSeverity(f.severity, threshold));

  return {
    ...turn,
    output: JSON.stringify({ passed: secondParsed.passed, findings: [...firstAdvisory, ...secondAdvisory] }),
    estimatedCostUsd: (turn.estimatedCostUsd ?? 0) + (secondTurn.estimatedCostUsd ?? 0),
  };
};

export const semanticReviewOp: RunOperation<SemanticReviewInput, SemanticReviewOutput, ReviewConfig> = {
  kind: "run",
  name: "semantic-review",
  stage: "review",
  session: { role: "reviewer-semantic", lifetime: "fresh" },
  config: reviewConfigSelector,
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
          ? { passed: false, findings: [], normalizedFindings: [], acDropped: [], looksLikeFail: true }
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
      return {
        passed: parsed.passed,
        findings: parsed.findings,
        normalizedFindings: [],
        acDropped: [],
      };
    }
    if (/"passed"\s*:\s*false/.test(output)) {
      return { passed: false, findings: [], normalizedFindings: [], acDropped: [], looksLikeFail: true };
    }
    return FAIL_OPEN;
  },
  async verify(parsed, input, _verifyCtx) {
    if (parsed.failOpen || parsed.looksLikeFail) return parsed;
    if (parsed.findings.length === 0) return parsed;

    const threshold = input.blockingThreshold ?? "error";
    const findings = parsed.findings as LLMFinding[];

    const sanitized = sanitizeRefModeFindings(findings, input.mode, threshold);

    const substantiated = await substantiateSemanticEvidence(
      sanitized,
      input.mode,
      input.workdir,
      input.story.id,
      threshold,
    );

    const { accepted, dropped } = filterByAcGroundingMinimal(substantiated, input.story.acceptanceCriteria);

    const blocking = accepted.filter((f) => isBlockingSeverity(f.severity, threshold));
    const passed = parsed.passed && blocking.length === 0;

    return {
      ...parsed,
      passed,
      findings: accepted,
      normalizedFindings: toReviewFindings(blocking),
      acDropped: dropped,
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
