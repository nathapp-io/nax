import { makeParseRetryStrategy } from "../agents/retry";
import type { TurnResult } from "../agents/types";
import { reviewConfigSelector } from "../config";
import type { ReviewConfig } from "../config/selectors";
import type { Finding, Iteration } from "../findings";
import { getSafeLogger } from "../logger";
import { ReviewPromptBuilder } from "../prompts";
import {
  checkFindingEvidence,
  downgradeUnsubstantiatedFinding,
  filterByAcGroundingMinimal,
  hasInspectionTrail,
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
  /**
   * Optional refresh payload — when present, the orchestrator re-runs
   * `prepareSemanticReviewInput` at dispatch time and overlays the fresh
   * `stat`/`diff`/`excludePatterns`/`effectiveRef` onto this input.
   *
   * Required because plan-build happens BEFORE test-writer/implementer
   * touch files, so the diff captured at plan-build is stale (often
   * empty). Without dispatch-time refresh, the reviewer LLM sees no
   * changes and silently fail-opens.
   */
  _refresh?: {
    projectDir?: string;
    storyId: string;
    storyGitRef: string | undefined;
    config?: import("../config/schema").NaxConfig;
    naxIgnoreIndex?: import("../utils/path-filters").NaxIgnoreIndex;
    resolvedTestPatterns?: import("../test-runners").ResolvedTestPatterns;
  };
}

type RepromptInfo = {
  dropCount: number;
  outcome: "recovered-blocking" | "recovered-advisory-only" | "still-dropped" | "parse-failed";
  costUsd: number;
};

function withRepromptMarker(output: string, info: RepromptInfo): string {
  const parsed = tryParseLLMJson<Record<string, unknown>>(output);
  if (!parsed || typeof parsed !== "object") return output;
  return JSON.stringify({ ...parsed, _repromptInfo: info });
}

function extractRepromptInfo(raw: Record<string, unknown> | null | undefined): RepromptInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const info = raw._repromptInfo;
  if (!info || typeof info !== "object") return undefined;
  const i = info as Record<string, unknown>;
  if (typeof i.dropCount !== "number" || typeof i.costUsd !== "number" || typeof i.outcome !== "string") {
    return undefined;
  }
  return {
    dropCount: i.dropCount,
    costUsd: i.costUsd,
    outcome: i.outcome as RepromptInfo["outcome"],
  };
}

export interface SemanticReviewOutput {
  passed: boolean;
  findings: unknown[];
  normalizedFindings: Finding[];
  acDropped: AcDroppedEntry<LLMFinding, AcGroundingMinimalRejection>[];
  failOpen?: boolean;
  looksLikeFail?: boolean;
  repromptEvent?: {
    dropCount: number;
    outcome: "recovered-blocking" | "recovered-advisory-only" | "still-dropped" | "parse-failed";
    costUsd: number;
  };
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

/**
 * Inspection-trail guard (#3A). Fires only on the rubber-stamp signature: ref
 * mode + passed:true + zero findings + no `inspectedFiles`. Issues exactly one
 * re-prompt demanding the reviewer open the code, then returns the second turn's
 * verdict (which flows through parse/verify substantiation normally). Returns
 * null when the guard does not apply, so the caller falls through to the normal
 * requote/reground logic. Cost is charged only on the rare suspicious case.
 *
 * Asymmetry (intentional): findings produced on the adopted second turn still
 * flow through parse()/verify() substantiation + AC-grounding, but skip the
 * hopBody-level same-session requote/reground recovery that first-turn findings
 * get. A reviewer that opened with a rubber-stamp forfeits that rescue turn.
 */
async function maybeRepromptForInspection(
  turn: TurnResult,
  parsed: ValidatedSemanticShape,
  rawObject: Record<string, unknown> | null | undefined,
  ctx: HopBodyContext<SemanticReviewInput>,
): Promise<TurnResult | null> {
  if (ctx.input.mode !== "ref") return null;
  if (ctx.input.semanticConfig.demandInspectionTrail === false) return null;
  if (!parsed.passed || parsed.findings.length !== 0) return null;
  if (hasInspectionTrail(rawObject)) return null;

  const secondTurn = await ctx.send(ReviewPromptBuilder.demandInspection());
  const costUsd = (turn.estimatedCostUsd ?? 0) + (secondTurn.estimatedCostUsd ?? 0);
  const secondParsed = validateLLMShape(tryParseLLMJson<Record<string, unknown>>(secondTurn.output));
  getSafeLogger()?.warn("review", "Semantic reviewer returned empty pass with no inspection trail — re-prompted", {
    storyId: ctx.input.story.id,
    event: "review.semantic.inspection_trail.reprompted",
    recovered: secondParsed !== null,
  });
  // Parseable second turn: adopt it (verify() substantiates any new findings).
  // Unparseable second turn: keep the original pass (fail-open) but bank the cost.
  return secondParsed
    ? { ...turn, output: secondTurn.output, estimatedCostUsd: costUsd }
    : { ...turn, estimatedCostUsd: costUsd };
}

const semanticReviewHopBody: RunOperation<SemanticReviewInput, SemanticReviewOutput, ReviewConfig>["hopBody"] = async (
  initialPrompt,
  ctx,
) => {
  const turn = await ctx.sendWithParseRetry(initialPrompt);
  const rawObject = tryParseLLMJson<Record<string, unknown>>(turn.output);
  const parsed = validateLLMShape(rawObject);
  if (!parsed) return turn;

  // Inspection-trail guard (#3A): a ref-mode empty-findings pass with no declared
  // inspectedFiles is a rubber-stamp — the reviewer never opened the code. Give it
  // exactly one chance to actually inspect before we trust the pass.
  const inspectionGuard = await maybeRepromptForInspection(turn, parsed, rawObject, ctx);
  if (inspectionGuard) return inspectionGuard;

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

  // Same-session AC-grounding re-prompt (issue #1105). Gated solely on
  // semanticConfig.acRegroundOnDrop.
  const regroundEnabled = ctx.input.semanticConfig.acRegroundOnDrop !== false;
  if (!regroundEnabled) return turn;

  const firstShape: ValidatedSemanticShape = { passed: parsed.passed, findings: requoted.findings };
  const trigger = evaluateRepromptTrigger(firstShape, ctx.input);
  if (!trigger.shouldReprompt) return turn;

  return performSemanticReground(turn, firstShape, trigger.acDropped, ctx);
};

/**
 * Execute the re-prompt turn for semantic drop recovery. See the adversarial
 * counterpart for outcome-label semantics.
 */
async function performSemanticReground(
  turn: TurnResult,
  firstParsed: ValidatedSemanticShape,
  drops: AcDroppedEntry<LLMFinding, AcGroundingMinimalRejection>[],
  ctx: HopBodyContext<SemanticReviewInput>,
): Promise<TurnResult> {
  const threshold = ctx.input.blockingThreshold ?? "error";
  const acceptanceCriteria = ctx.input.story.acceptanceCriteria;
  const { accepted: firstAccepted } = filterByAcGroundingMinimal(firstParsed.findings, acceptanceCriteria);
  const firstAdvisory = firstAccepted.filter((f) => !isBlockingSeverity(f.severity, threshold));

  const repromptPrompt = ReviewPromptBuilder.regroundDroppedFindings({
    drops,
    acceptanceCriteria,
  });
  const secondTurn = await ctx.send(repromptPrompt);
  const secondParsed = validateLLMShape(tryParseLLMJson<Record<string, unknown>>(secondTurn.output));

  const costUsd = (turn.estimatedCostUsd ?? 0) + (secondTurn.estimatedCostUsd ?? 0);
  const dropCount = drops.length;

  if (!secondParsed) {
    return {
      ...turn,
      output: withRepromptMarker(turn.output, { dropCount, outcome: "parse-failed", costUsd }),
    };
  }

  const { accepted: secondAccepted } = filterByAcGroundingMinimal(secondParsed.findings, acceptanceCriteria);
  const secondBlocking = secondAccepted.filter((f) => isBlockingSeverity(f.severity, threshold));

  if (secondBlocking.length > 0) {
    return {
      ...turn,
      output: JSON.stringify({
        passed: false,
        findings: secondParsed.findings,
        _repromptInfo: { dropCount, outcome: "recovered-blocking", costUsd },
      }),
      estimatedCostUsd: costUsd,
    };
  }

  if (secondParsed.passed) {
    // AC2: model agreed nothing to block on reflection — synthesise passed:true
    // with advisories from both passes merged.
    const secondAdvisory = secondAccepted.filter((f) => !isBlockingSeverity(f.severity, threshold));
    return {
      ...turn,
      output: JSON.stringify({
        passed: true,
        findings: [...firstAdvisory, ...secondAdvisory],
        _repromptInfo: { dropCount, outcome: "recovered-advisory-only", costUsd },
      }),
      estimatedCostUsd: costUsd,
    };
  }

  // Second pass still claims failure but every blocking finding dropped again.
  return {
    ...turn,
    output: withRepromptMarker(turn.output, { dropCount, outcome: "still-dropped", costUsd }),
  };
}

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
    const repromptEvent = extractRepromptInfo(raw);
    if (parsed) {
      return {
        passed: parsed.passed,
        findings: parsed.findings,
        normalizedFindings: [],
        acDropped: [],
        repromptEvent,
      };
    }
    if (/"passed"\s*:\s*false/.test(output)) {
      return {
        passed: false,
        findings: [],
        normalizedFindings: [],
        acDropped: [],
        looksLikeFail: true,
        repromptEvent,
      };
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
