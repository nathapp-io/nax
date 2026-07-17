import { ParseValidationError, makeParseRetryStrategy } from "../agents/retry";
import type { TurnResult } from "../agents/types";
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
  hasInspectionTrail,
  substantiateAdversarialFindings,
} from "../review/finding-filters";
import type { AcDroppedEntry, AcQuoteRejectionCode } from "../review/finding-filters";
import { classifyRecurrence, tagCoverageGap } from "../review/recurrence-demotion";
import { parseRequoteResponse } from "../review/requote-response";
import type { AdversarialReviewConfig, SemanticStory } from "../review/types";
import type { ResolvedTestPatterns } from "../test-runners";
import { tryParseLLMJson } from "../utils/llm-json";
import type { HopBodyContext, RunOperation } from "./types";

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

type RepromptInfo = {
  dropCount: number;
  outcome: "recovered-blocking" | "recovered-advisory-only" | "still-dropped" | "parse-failed";
  costUsd: number;
};

/**
 * Embed a `_repromptInfo` marker into a JSON output string. `validateAdversarialShape`
 * ignores unknown keys, so the marker is invisible to the shape validator but readable
 * by `parse()`. No-ops for non-JSON output.
 */
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
  /** ADR-024 — non-blocking (sub-threshold) findings, surfaced for the best-effort fix pass. */
  advisoryFindings?: Finding[];
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
    if (parsed.failOpen || parsed.looksLikeFail) return parsed;
    if (parsed.findings.length === 0) return parsed;

    const threshold = input.blockingThreshold ?? "error";
    const findings = parsed.findings as AdversarialLLMFinding[];

    const substantiated = await substantiateAdversarialFindings({
      findings,
      workdir: input.workdir,
      repoRoot: input.repoRoot,
      storyId: input.story.id,
      blockingThreshold: threshold,
    });

    const { accepted, dropped } = filterByAcQuote(substantiated, input.story.acceptanceCriteria);

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

    // Pass when nothing blocks AND either the model passed, or the classifier
    // reclassified a blocking-severity finding to non-blocking (recurrence-demoted
    // OR oscillation-suppressed to advisory). Preserves fail-closed when the model
    // fails with no blocking-severity findings at all.
    const hadBlockingSeverity = accepted.some((f) => isBlockingSeverity(f.severity, threshold));
    const passed = blocking.length === 0 && (parsed.passed || hadBlockingSeverity);

    return {
      ...parsed,
      passed,
      findings: accepted,
      normalizedFindings: toAdversarialReviewFindings(blocking),
      advisoryFindings: [
        ...toAdversarialReviewFindings(advisory),
        ...tagCoverageGap(toAdversarialReviewFindings(demoted)),
      ],
      acDropped: dropped,
    };
  },
};
