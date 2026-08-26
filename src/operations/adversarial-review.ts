import { makeParseRetryStrategy, ParseValidationError, UNPARSED_PREVIEW_BYTES } from "../agents/retry";
import type { TurnResult } from "../agents/types";
import { reviewConfigSelector } from "../config";
import type { ReviewConfig } from "../config/selectors";
import type { Finding, Iteration } from "../findings";
import { getSafeLogger } from "../logger";
import type { TestInventory } from "../prompts";
import { AdversarialReviewPromptBuilder, ReviewPromptBuilder } from "../prompts";
import type { AdversarialLLMFinding } from "../review/adversarial-helpers";
import {
  isBlockingSeverity,
  toAdversarialReviewFindings,
  validateAdversarialShape,
} from "../review/adversarial-helpers";
import type { AcDroppedEntry, AcQuoteRejectionCode } from "../review/finding-filters";
import {
  checkFindingEvidence,
  downgradeUnsubstantiatedFinding,
  filterByAcQuote,
  filterByScopeQuote,
  hasInspectionTrail,
  substantiateAdversarialFindings,
} from "../review/finding-filters";
import { classifyRecurrence, tagCoverageGap } from "../review/recurrence-demotion";
import { parseRequoteResponse } from "../review/requote-response";
import type { AdversarialReviewConfig, ReviewAck, SemanticStory } from "../review/types";
import type { ResolvedTestPatterns } from "../test-runners";
import { tryParseLLMJson } from "../utils/llm-json";
import { reviewExhaustedFallback } from "./_review-fallback";
import { extractRepromptInfo, withRepromptMarker } from "./adversarial-reprompt-marker";
import type { HopBodyContext, RunOperation, RunOperationWithHooks } from "./types";

export type { AdversarialReviewConfig, SemanticStory, TestInventory };
export type ValidatedAdversarialShape = NonNullable<ReturnType<typeof validateAdversarialShape>>;

export interface AdversarialReviewInput {
  /** Absolute path to the package workdir — required by verify() for evidence substantiation. */
  workdir: string;
  /** Absolute repo root (= projectDir ?? workdir). Anchors evidence path resolution for monorepo packages. */
  repoRoot?: string;
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
  /** Resolved test-file patterns (ADR-009) for the test-gap structural guard. */
  resolvedTestPatterns?: ResolvedTestPatterns;
  /** Severity threshold from review config — drives the JSON-retry condensation prompt. */
  blockingThreshold?: "error" | "warning" | "info";
  /**
   * Optional refresh payload — see SemanticReviewInput._refresh. Lets the
   * orchestrator re-prepare stat/diff/testInventory at dispatch time, after
   * test-writer/implementer have produced a real diff.
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

export interface AdversarialReviewOutput {
  passed: boolean;
  /**
   * The model's raw `passed` flag, before `verify()` applies blockingThreshold (#1378).
   * The wrapper's ungrounded-drop branches key off this (not `passed`) so they fail
   * closed on a model-claimed failure regardless of sub-threshold survivors.
   */
  modelPassed?: boolean;
  /** Raw AdversarialLLMFinding[]. Consumed by `src/review/adversarial.ts`. */
  findings: unknown[];
  /** Prior findings resolved or withdrawn this round, not re-flagged — see `review/acks.ts` (#1423). */
  acks?: ReviewAck[];
  /**
   * The resolved blockingThreshold used during verify(). Persisted here so
   * buildPhaseDetails can compute blockingCount at the configured threshold
   * rather than always defaulting to "error".
   */
  blockingThreshold?: string;
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
  /** ADR-024 — non-blocking (sub-threshold) findings, surfaced for the best-effort fix pass. */
  advisoryFindings?: Finding[];
  failOpen?: boolean;
  /**
   * True when the raw output could not be parsed but contained `"passed": false`.
   * Callers should treat this as a hard failure rather than fail-open.
   */
  looksLikeFail?: boolean;
  /** Clipped preview of unparseable output — retained nowhere else. See semantic-review.ts. */
  unparsedPreview?: string;
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
    const initialEvidence = await checkFindingEvidence({
      finding,
      workdir: ctx.input.workdir,
      repoRoot: ctx.input.repoRoot,
    });
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
      repoRoot: ctx.input.repoRoot,
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

const adversarialParseRetry = (input: AdversarialReviewInput, maxAttempts: number) =>
  makeParseRetryStrategy({
    validate: (parsed) => validateAdversarialShape(parsed) !== null,
    reviewerKind: "adversarial",
    maxAttempts,
    prompts: {
      invalid: () => ReviewPromptBuilder.jsonRetry(),
      truncated: () => ReviewPromptBuilder.jsonRetryCondensed({ blockingThreshold: input.blockingThreshold }),
    },
    exhaustedFallback: (lastOutput) => reviewExhaustedFallback(lastOutput, FAIL_OPEN),
    outputPreviewBytes: UNPARSED_PREVIEW_BYTES,
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

/**
 * Execute the re-prompt turn for adversarial drop recovery. Returns a TurnResult
 * whose `output` embeds a `_repromptInfo` marker (read by parse()) so the wrapper
 * can emit telemetry. The outcome label is derived from what survived re-grounding:
 *
 * - re-prompt unparseable           → "parse-failed",        preserve first turn
 * - blocking survives second filter → "recovered-blocking",  emit re-grounded findings
 * - second pass agrees passed:true  → "recovered-advisory-only", merge advisories from both passes
 * - second pass passed:false / 0    → "still-dropped",       preserve first turn
 */
async function performAdversarialReground(
  turn: TurnResult,
  firstParsed: ValidatedAdversarialShape,
  drops: AcDroppedEntry<AdversarialLLMFinding, AcQuoteRejectionCode>[],
  ctx: HopBodyContext<AdversarialReviewInput>,
): Promise<TurnResult> {
  const threshold = ctx.input.blockingThreshold ?? "error";
  const acceptanceCriteria = ctx.input.story.acceptanceCriteria;
  const { accepted: firstAccepted } = filterByAcQuote(firstParsed.findings, acceptanceCriteria);
  const firstAdvisory = firstAccepted.filter((f) => !isBlockingSeverity(f.severity, threshold));

  const repromptPrompt = AdversarialReviewPromptBuilder.regroundDroppedFindings({
    drops,
    acceptanceCriteria,
  });
  const secondTurn = await ctx.send(repromptPrompt);
  const secondParsed = validateAdversarialShape(tryParseLLMJson<Record<string, unknown>>(secondTurn.output));

  const costUsd = (turn.estimatedCostUsd ?? 0) + (secondTurn.estimatedCostUsd ?? 0);
  const dropCount = drops.length;

  if (!secondParsed) {
    return {
      ...turn,
      output: withRepromptMarker(turn.output, { dropCount, outcome: "parse-failed", costUsd }),
    };
  }

  const { accepted: secondAccepted } = filterByAcQuote(secondParsed.findings, acceptanceCriteria);
  const secondBlocking = secondAccepted.filter((f) => isBlockingSeverity(f.severity, threshold));

  if (secondBlocking.length > 0) {
    return {
      ...turn,
      output: JSON.stringify({
        passed: false,
        findings: secondParsed.findings,
        // Acknowledgements must survive every output rewrite — a synthetic
        // output is still the object `parse()` reads (#1423).
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

  // Second pass still claims failure but every blocking finding was dropped
  // again — preserve first-pass fail-closed behavior.
  return {
    ...turn,
    output: withRepromptMarker(turn.output, { dropCount, outcome: "still-dropped", costUsd }),
  };
}

/**
 * Inspection-trail guard (#3A). Fires only on the rubber-stamp signature: ref
 * mode + passed:true + zero findings + no `inspectedFiles`. Issues exactly one
 * re-prompt demanding the reviewer open the code, then returns the second turn's
 * verdict (which flows through parse/verify substantiation normally). Returns
 * null when the guard does not apply, so the caller falls through to the normal
 * reground/requote logic. Cost is charged only on the rare suspicious case.
 *
 * Asymmetry (intentional): findings produced on the adopted second turn still
 * flow through parse()/verify() substantiation + AC-grounding, but skip the
 * hopBody-level same-session reground/requote recovery that first-turn findings
 * get. A reviewer that opened with a rubber-stamp forfeits that rescue turn.
 */
async function maybeRepromptForInspection(
  turn: TurnResult,
  parsed: ValidatedAdversarialShape,
  rawObject: Record<string, unknown> | null | undefined,
  ctx: HopBodyContext<AdversarialReviewInput>,
): Promise<TurnResult | null> {
  if (ctx.input.adversarialConfig.demandInspectionTrail === false) return null;
  if (!parsed.passed || parsed.findings.length !== 0) return null;
  if (hasInspectionTrail(rawObject)) return null;

  const secondTurn = await ctx.send(AdversarialReviewPromptBuilder.demandInspection());
  const costUsd = (turn.estimatedCostUsd ?? 0) + (secondTurn.estimatedCostUsd ?? 0);
  const secondParsed = validateAdversarialShape(tryParseLLMJson<Record<string, unknown>>(secondTurn.output));
  getSafeLogger()?.warn("review", "Adversarial reviewer returned empty pass with no inspection trail — re-prompted", {
    storyId: ctx.input.story.id,
    event: "review.adversarial.inspection_trail.reprompted",
    recovered: secondParsed !== null,
  });
  // Parseable second turn: adopt it (verify() substantiates any new findings).
  // Unparseable second turn: keep the original pass (fail-open) but bank the cost.
  return secondParsed
    ? { ...turn, output: secondTurn.output, estimatedCostUsd: costUsd }
    : { ...turn, estimatedCostUsd: costUsd };
}

export const adversarialReviewOp: RunOperationWithHooks<
  AdversarialReviewInput,
  AdversarialReviewOutput,
  ReviewConfig,
  "hopBody" | "verify"
> = {
  kind: "run",
  name: "adversarial-review",
  stage: "review",
  session: { role: "reviewer-adversarial", lifetime: "fresh" },
  config: reviewConfigSelector,
  model: (input) => input.adversarialConfig.model,
  timeoutMs: (input) => input.adversarialConfig.timeoutMs,
  retry: (input, ctx) => adversarialParseRetry(input, ctx.config.review.parseRetryMaxAttempts),
  async hopBody(initialPrompt, ctx) {
    const turn = await ctx.sendWithParseRetry(initialPrompt);
    const rawObject = tryParseLLMJson<Record<string, unknown>>(turn.output);
    const parsed = validateAdversarialShape(rawObject);
    if (!parsed) return turn;

    if (ctx.input.mode !== "ref") return turn;

    // Inspection-trail guard (#3A): a ref-mode empty-findings pass with no declared
    // inspectedFiles is a rubber-stamp — the reviewer never opened the code. Give it
    // exactly one chance to actually inspect before we trust the pass.
    const inspectionGuard = await maybeRepromptForInspection(turn, parsed, rawObject, ctx);
    if (inspectionGuard) return inspectionGuard;

    // Same-session AC-grounding re-prompt (issue #1105). Gated solely on
    // acRegroundOnDrop; independent of requote / maxRequotes which address a
    // different failure mode (evidence-unmatched, not drop-on-grounding).
    const regroundEnabled = ctx.input.adversarialConfig.acRegroundOnDrop !== false;
    if (regroundEnabled) {
      const firstShape: ValidatedAdversarialShape = { passed: parsed.passed, findings: parsed.findings };
      const trigger = evaluateRepromptTrigger(firstShape, ctx.input);
      if (trigger.shouldReprompt) {
        return await performAdversarialReground(turn, parsed, trigger.acDropped, ctx);
      }
    }

    const requoteEnabled = ctx.input.adversarialConfig.substantiation?.requote ?? true;
    const maxRequotes = ctx.input.adversarialConfig.substantiation?.maxRequotes ?? DEFAULT_MAX_REQUOTES;
    if (!requoteEnabled || maxRequotes <= 0) return turn;

    const requoted = await requoteBlockingAdversarialFindings(parsed.findings, ctx);
    if (requoted.changed) {
      const passed = !requoted.findings.some((finding) =>
        isBlockingSeverity(finding.severity, ctx.input.blockingThreshold ?? "error"),
      );
      return {
        ...turn,
        output: JSON.stringify({ passed, findings: requoted.findings, ...(parsed.acks && { acks: parsed.acks }) }),
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
  parse(output, _input, _ctx) {
    const raw = tryParseLLMJson<Record<string, unknown>>(output);
    const parsed = validateAdversarialShape(raw);
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
    if (/"passed"\s*:\s*false/.test(output) && !/"findings"\s*:\s*\[\s*\{/.test(output)) {
      return {
        passed: false,
        findings: [],
        normalizedFindings: [],
        acDropped: [],
        looksLikeFail: true,
        repromptEvent,
      };
    }
    throw new ParseValidationError("[adversarial-review] parse failed: invalid JSON shape");
  },
  async verify(parsed, input, _verifyCtx) {
    const threshold = input.blockingThreshold ?? "error";
    if (parsed.failOpen || parsed.looksLikeFail) return { ...parsed, blockingThreshold: threshold };
    if (parsed.findings.length === 0) return { ...parsed, blockingThreshold: threshold };
    const findings = parsed.findings as AdversarialLLMFinding[];

    const substantiated = await substantiateAdversarialFindings({
      findings,
      workdir: input.workdir,
      repoRoot: input.repoRoot,
      storyId: input.story.id,
      blockingThreshold: threshold,
    });

    // Scope-grounding runs first and at every severity: a scope finding is capped
    // at "warning" by the prompt, so filterByAcQuote (blocking-only) never
    // inspects it, yet an ungrounded one still reaches the story report and the
    // next tier's escalation context. Findings making no scope claim pass through.
    const { accepted: scopeGrounded, dropped: scopeDropped } = filterByScopeQuote(
      substantiated,
      input.story.outOfScope ?? [],
    );
    for (const entry of scopeDropped) {
      getSafeLogger()?.info("review", "Adversarial scope finding dropped (ungrounded scopeQuote)", {
        storyId: input.story.id,
        event: "review.adversarial.scope_quote_dropped",
        file: entry.finding.file,
        code: entry.code,
      });
    }

    // Phase-0 telemetry (issue #1359 — scope-violation blocking policy). Scope findings
    // are advisory today, so nothing downstream records that one fired. Without a
    // numerator to pair with scope_quote_dropped above, there is no basis to
    // decide whether they should ever block — mirrors the recurrence-demotion
    // Phase-0 counters that gate its Phase 1.
    for (const finding of scopeGrounded) {
      if (finding.category !== "out-of-scope" && finding.scopeQuote === undefined) continue;
      getSafeLogger()?.info("review", "Adversarial scope finding accepted (advisory)", {
        storyId: input.story.id,
        event: "review.adversarial.scope_finding_accepted",
        file: finding.file,
        severity: finding.severity,
        // Distinguishes a finding citing the numbered outOfScope list from one
        // reporting a description-level "Scope — Out:" bullet, which cannot be
        // machine-verified. Only the former is candidate evidence for a gate.
        grounded: finding.scopeQuote !== undefined,
        declaredExclusions: (input.story.outOfScope ?? []).length,
      });
    }

    const { accepted, dropped } = filterByAcQuote(scopeGrounded, input.story.acceptanceCriteria);

    const recurrenceCfg = input.adversarialConfig.recurrenceDemotion ?? { enabled: true, maxBlockingRounds: 2 };
    const patterns = input.resolvedTestPatterns?.regex ?? [];
    const testFileMatch = (file: string): boolean => patterns.some((re) => re.test(file));

    const { blocking, advisory, demoted } = classifyRecurrence(
      accepted,
      input.priorAdversarialIterations ?? [],
      recurrenceCfg,
      testFileMatch,
      threshold,
    );

    for (const f of demoted) {
      getSafeLogger()?.info("review", "Adversarial finding demoted to advisory (recurrence coverage-gap)", {
        storyId: input.story.id,
        event: "review.adversarial.recurrence_demoted",
        file: f.file,
        category: f.category,
      });
    }

    // Honour blockingThreshold: the verdict fails only when a blocking finding survives.
    // The model's raw `passed:false` must NOT fail the review when every surviving
    // finding is sub-threshold (nax#1347 for semantic, nax#1378 here) — the prior
    // `accepted.some(isBlockingSeverity)` clause collapsed to `parsed.passed` alone for
    // ordinary sub-threshold findings, which deadlocks the story: `normalizedFindings`
    // carries `blocking` only, so the rectification cycle gets nothing routable and
    // exits "resolved" with no derivable failure category.
    //
    // `accepted.length > 0` keeps the fail-closed guard when the model claims failure
    // but every finding was dropped as ungrounded (accepted empty) — there we still
    // respect `parsed.passed`. `accepted` is a superset of the old clause, so
    // demotion/oscillation pass-through is unchanged.
    const passed = blocking.length === 0 && (parsed.passed || accepted.length > 0);

    return {
      ...parsed,
      passed,
      blockingThreshold: threshold,
      modelPassed: parsed.passed,
      findings: accepted,
      // #1368 — `testFileMatch` also decides the fix lane: a finding located in a
      // test file goes to the test-writer whatever its category says, because the
      // implementer may not edit test files and would answer UNRESOLVED.
      normalizedFindings: toAdversarialReviewFindings(blocking, { isTestFile: testFileMatch }),
      advisoryFindings: [
        ...toAdversarialReviewFindings(advisory, { isTestFile: testFileMatch }),
        ...tagCoverageGap(toAdversarialReviewFindings(demoted, { isTestFile: testFileMatch })),
      ],
      acDropped: dropped,
    };
  },
};
