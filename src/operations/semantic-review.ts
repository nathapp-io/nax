import { makeParseRetryStrategy, previewOutput, UNPARSED_PREVIEW_BYTES } from "../agents/retry";
import type { TurnResult } from "../agents/types";
import { reviewConfigSelector } from "../config";
import type { ReviewConfig } from "../config/selectors";
import type { Finding, Iteration } from "../findings";
import { getSafeLogger } from "../logger";
import { ReviewPromptBuilder } from "../prompts";
import type { AcDroppedEntry, AcGroundingMinimalRejection, LLMFinding } from "../review/finding-filters";
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
import { classifyRecurrence, tagCoverageGap } from "../review/recurrence-demotion";
import { parseRequoteResponse } from "../review/requote-response";
import type { ReviewAck, SemanticReviewConfig, SemanticStory } from "../review/types";
import { tryParseLLMJson } from "../utils/llm-json";
import { reviewExhaustedFallback } from "./_review-fallback";
import type { HopBodyContext, RunOperation, RunOperationWithHooks } from "./types";

export type { SemanticReviewConfig, SemanticStory };
export type ValidatedSemanticShape = NonNullable<ReturnType<typeof validateLLMShape>>;

export interface SemanticReviewInput {
  workdir: string;
  /** Absolute repo root (= projectDir ?? workdir). Anchors evidence path resolution for monorepo packages. */
  repoRoot?: string;
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
   * Resolved test-file patterns (ADR-009 SSOT). Used to keep a finding about a
   * test file in the test lane (#1368) — semantic findings otherwise default to
   * `fixTarget: "source"`, which hands them to an implementer that may not edit
   * test files. Populated by the orchestrator's dispatch-time refresh.
   */
  resolvedTestPatterns?: import("../test-runners").ResolvedTestPatterns;
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

/**
 * Test-file classifier for the fix-lane override (#1368). Mirrors the adversarial
 * op's `testFileMatch`. Matches nothing when patterns are absent, so the lane
 * falls back to the semantic default of `"source"`.
 */
function semanticTestFileMatch(input: SemanticReviewInput): (file: string) => boolean {
  const patterns = input.resolvedTestPatterns?.regex ?? [];
  return (file: string): boolean => patterns.some((re) => re.test(file));
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
  /**
   * Prior findings the reviewer resolved or withdrew this round rather than
   * re-flagging (#1423). Persisted to the audit record so carry-forward
   * bookkeeping is visible without being counted as findings.
   */
  acks?: ReviewAck[];
  failOpen?: boolean;
  looksLikeFail?: boolean;
  /** Blocking-severity findings that did NOT block: oscillation-suppressed or recurrence-demoted. */
  advisoryFindings?: Finding[];
  /**
   * Clipped preview of the output that could not be parsed, carried to the
   * review-audit record. The raw reviewer response is retained nowhere else, so
   * a give-up was previously undiagnosable after the run.
   */
  unparsedPreview?: string;
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
      // Acknowledgements must survive every output rewrite — a synthetic output
      // is still the object `parse()` reads (#1423).
      output: JSON.stringify({ passed, findings: requoted.findings, ...(parsed.acks && { acks: parsed.acks }) }),
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
        ...(secondParsed.acks && { acks: secondParsed.acks }),
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
        ...(secondParsed.acks && { acks: secondParsed.acks }),
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

export const semanticReviewOp: RunOperationWithHooks<
  SemanticReviewInput,
  SemanticReviewOutput,
  ReviewConfig,
  "hopBody" | "verify"
> = {
  kind: "run",
  name: "semantic-review",
  stage: "review",
  session: { role: "reviewer-semantic", lifetime: "fresh" },
  config: reviewConfigSelector,
  model: (input) => input.semanticConfig.model,
  timeoutMs: (input) => input.semanticConfig.timeoutMs,
  retry: (input, ctx) =>
    makeParseRetryStrategy({
      validate: (parsed) => validateLLMShape(parsed) !== null,
      reviewerKind: "semantic",
      maxAttempts: ctx.config.review.parseRetryMaxAttempts,
      prompts: {
        invalid: () => ReviewPromptBuilder.jsonRetry(),
        truncated: () => ReviewPromptBuilder.jsonRetryCondensed({ blockingThreshold: input.blockingThreshold }),
      },
      exhaustedFallback: (lastOutput) => reviewExhaustedFallback(lastOutput, FAIL_OPEN),
      outputPreviewBytes: UNPARSED_PREVIEW_BYTES,
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
        ...(parsed.acks && { acks: parsed.acks }),
      };
    }
    // Both give-up branches carry a preview of the output that defeated the
    // parser — it is retained nowhere else once the turn is discarded.
    const unparsedPreview = previewOutput(output, UNPARSED_PREVIEW_BYTES);
    if (/"passed"\s*:\s*false/.test(output)) {
      return {
        passed: false,
        findings: [],
        normalizedFindings: [],
        acDropped: [],
        looksLikeFail: true,
        unparsedPreview,
        repromptEvent,
      };
    }
    return { ...FAIL_OPEN, unparsedPreview };
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
      input.repoRoot,
    );

    const { accepted, dropped } = filterByAcGroundingMinimal(substantiated, input.story.acceptanceCriteria);

    const isTestFile = semanticTestFileMatch(input);
    // Recurrence-demotion (opt-in for semantic — see schemas-review.ts). A
    // finding whose fingerprint has recurred past maxBlockingRounds stops
    // blocking and is surfaced as a coverageGap-tagged advisory, so one
    // disputed finding cannot deadlock the story indefinitely.
    const recurrenceCfg = input.semanticConfig.recurrenceDemotion ?? { enabled: false, maxBlockingRounds: 2 };
    const {
      blocking,
      advisory: subThreshold,
      demoted,
    } = classifyRecurrence(
      accepted,
      input.priorSemanticIterations ?? [],
      recurrenceCfg,
      isTestFile,
      threshold,
      "semantic-review",
    );
    // Tag AFTER conversion: llmFindingToFinding rebuilds `meta` from scratch, so
    // a coverageGap tag applied to the LLMFinding would be silently dropped.
    const advisoryFindings = [
      ...toReviewFindings(
        subThreshold.filter((f) => isBlockingSeverity(f.severity, threshold)),
        { isTestFile },
      ),
      ...tagCoverageGap(toReviewFindings(demoted, { isTestFile })),
    ];
    // Honour blockingThreshold: the verdict fails only when a blocking finding
    // survives. The model's raw `passed:false` must NOT fail the review when every
    // surviving finding is advisory (sub-threshold) — that was nax#1347. The
    // `accepted.length > 0` clause preserves the fail-closed guard for the distinct
    // case where the model claims failure but all findings were dropped as
    // ungrounded (accepted empty): there we still respect the model's `passed` flag.
    const passed = blocking.length === 0 && (parsed.passed || accepted.length > 0);

    return {
      ...parsed,
      passed,
      findings: accepted,
      normalizedFindings: toReviewFindings(blocking, { isTestFile }),
      advisoryFindings,
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
    const initialEvidence = await checkFindingEvidence({
      finding,
      workdir: ctx.input.workdir,
      repoRoot: ctx.input.repoRoot,
    });
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
      repoRoot: ctx.input.repoRoot,
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
