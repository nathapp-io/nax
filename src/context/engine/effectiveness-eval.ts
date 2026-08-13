/**
 * Context Engine v2 — Effectiveness Evaluation Harness (US-001)
 *
 * Loads hand-labelled (or synthetic) chunk-vs-diff attribution cases and
 * scores a classifier against them. The scorer is deterministic and
 * dependency-free — no LLM call. US-003's gate consumes the `EvalReport`
 * shape this module produces.
 *
 * The output shape is the only public contract: the per-signal precision,
 * recall, F1 trio, the constant-`ignored` baseline, the Spearman
 * size-correlation coefficient, and the scored/excluded counts.
 */

import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Types — public contract
// ─────────────────────────────────────────────────────────────────────────────

/** A single hand-labelled attribution case. */
export interface LabelCase {
  /** Stable case id; cited in warnings and CLI output. */
  caseId: string;
  /** Chunk identifier this case labels. */
  chunkId: string;
  /** First 300 chars of the chunk content (mirror of CHUNK_SUMMARY_CHARS). */
  chunkSummary: string;
  /** Provider-declared scope globs; may be absent. */
  scopePaths?: string[];
  /** Unified diff text restricted to the files this story touched. */
  diffText: string;
  /** Hand-assigned label. */
  label: "followed" | "ignored" | "contradicted" | "unclear";
  /** Free-text note. */
  note?: string;
}

/** A set of label cases at a specific schema version. */
export interface LabelSet {
  /** Schema version — only 1 is accepted today. */
  version: number;
  cases: LabelCase[];
}

/** Per-signal scoring triple — the field US-003's gate reads. */
export interface PerSignalScore {
  precision: number;
  recall: number;
  f1: number;
}

/** Constant-`ignored` baseline row, alongside the scored classifier. */
export interface BaselineScore {
  precision: number;
  recall: number;
  f1: number;
}

/** Top-level result the CLI command prints. */
export interface EvalReport {
  perSignal: Record<"followed" | "ignored" | "contradicted", PerSignalScore>;
  baseline: BaselineScore;
  sizeCorrelation: number;
  scoredCount: number;
  excludedCount: number;
}

/** A classifier maps a single case to its predicted signal. */
export type Classifier = (singleCase: LabelCase) => "followed" | "ignored" | "contradicted" | "unknown";

// ─────────────────────────────────────────────────────────────────────────────
// Schema (Zod) — version 1
// ─────────────────────────────────────────────────────────────────────────────

const LabelSchema = z.object({
  caseId: z.string(),
  chunkId: z.string(),
  chunkSummary: z.string(),
  scopePaths: z.array(z.string()).optional(),
  diffText: z.string(),
  label: z.enum(["followed", "ignored", "contradicted", "unclear"]),
  note: z.string().optional(),
});

const LabelSetSchema = z.object({
  version: z.literal(1),
  cases: z.array(LabelSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// loadLabelSet — parse + validate + surface typed errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a JSON label-set file. Throws NaxError on invalid JSON or schema
 * failure so the CLI can map either to exit `2`.
 */
export function loadLabelSet(json: string): LabelSet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new NaxError(
      `Invalid JSON in labels file: ${err instanceof Error ? err.message : String(err)}`,
      INVALID_JSON_ERROR_CODE,
      { stage: "effectiveness-eval" },
    );
  }

  const result = LabelSetSchema.safeParse(parsed);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const issuePath = firstIssue?.path ?? [];
    const fieldName = issuePath.length > 0 ? String(issuePath[issuePath.length - 1]) : "schema";
    const caseIndex = issuePath.find((p) => typeof p === "number");
    const cases = parsed && typeof parsed === "object" && "cases" in parsed ? (parsed as { cases: unknown }).cases : [];
    let caseId = "<unknown>";
    if (
      typeof caseIndex === "number" &&
      Array.isArray(cases) &&
      cases[caseIndex] &&
      typeof cases[caseIndex] === "object"
    ) {
      const maybeId = (cases[caseIndex] as { caseId?: unknown }).caseId;
      if (typeof maybeId === "string") caseId = maybeId;
    }
    throw new NaxError(
      `Schema validation failed for label case '${caseId}': missing or invalid field '${fieldName}'`,
      SCHEMA_INVALID_ERROR_CODE,
      { stage: "effectiveness-eval", caseId, field: fieldName },
    );
  }

  return result.data as LabelSet;
}

// ─────────────────────────────────────────────────────────────────────────────
// scoreEffectiveness — per-signal precision/recall/F1 + baseline + size corr
// ─────────────────────────────────────────────────────────────────────────────

const SCORED_SIGNALS = ["followed", "ignored", "contradicted"] as const;
type ScoredSignal = (typeof SCORED_SIGNALS)[number];

/**
 * Score a classifier against a case list. Returns the EvalReport US-003's
 * gate consumes. Cases labelled "unclear" are excluded from per-signal
 * precision/recall/F1 but counted separately as `excludedCount`.
 *
 * Resilience: per-case scoring is wrapped in try/catch so a single throwing
 * case yields a warning (with the failing caseId) and does not abort the run.
 */
export function scoreEffectiveness(cases: readonly LabelCase[], classifier: Classifier): EvalReport {
  return scoreEffectivenessImpl(cases, classifier);
}

function scoreEffectivenessImpl(cases: readonly LabelCase[], classifier: Classifier): EvalReport {
  const logger = _effectivenessEvalDeps.getLogger();
  const scored: { caseObj: LabelCase; predicted: ScoredSignal }[] = [];
  let excludedCount = 0;

  for (const c of cases) {
    if (c.label === "unclear") {
      excludedCount++;
      continue;
    }
    let predicted: ScoredSignal;
    try {
      const raw = classifier(c);
      if (raw === "unknown") {
        // Treat unknown predictions as ignored — they neither help nor hurt a signal.
        predicted = "ignored";
      } else {
        predicted = raw;
      }
    } catch (err) {
      logger.warn(
        "effectiveness-eval",
        `classifier threw on caseId='${c.caseId}': ${err instanceof Error ? err.message : String(err)}; scoring remaining cases`,
      );
      continue;
    }
    scored.push({ caseObj: c, predicted });
  }

  const scoredCount = scored.length;

  // Per-signal precision/recall/F1.
  const perSignal: Record<ScoredSignal, PerSignalScore> = {
    followed: { precision: 0, recall: 0, f1: 0 },
    ignored: { precision: 0, recall: 0, f1: 0 },
    contradicted: { precision: 0, recall: 0, f1: 0 },
  };
  for (const signal of SCORED_SIGNALS) {
    perSignal[signal] = computePrecisionRecallF1(scored, signal);
  }

  // Baseline = always-ignored classifier.
  const baselineScored = scored.map(({ caseObj }) => ({ caseObj, predicted: "ignored" as ScoredSignal }));
  // The always-ignored classifier trivially scores perfectly on the ignored
  // signal; we report the *macro-average across signals* so the baseline is
  // comparable to the scored row instead of being tautological.
  const baseline: BaselineScore = computeMacroBaseline(baselineScored);

  // Spearman size correlation between diff length and whether the classifier
  // predicted "followed" (1 = followed, 0 = not).
  const sizeCorrelation = computeSizeCorrelation(scored);

  return {
    perSignal,
    baseline,
    sizeCorrelation,
    scoredCount,
    excludedCount,
  };
}

function computePrecisionRecallF1(
  scored: readonly { caseObj: LabelCase; predicted: ScoredSignal }[],
  signal: ScoredSignal,
): PerSignalScore {
  // True positives: predicted == signal AND actual == signal.
  // False positives: predicted == signal AND actual != signal.
  // False negatives: actual == signal AND predicted != signal.
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const { caseObj, predicted } of scored) {
    const actual = caseObj.label as ScoredSignal;
    if (predicted === signal && actual === signal) tp++;
    else if (predicted === signal && actual !== signal) fp++;
    else if (actual === signal && predicted !== signal) fn++;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    precision: clamp01(precision),
    recall: clamp01(recall),
    f1: clamp01(f1),
  };
}

function computeMacroBaseline(scored: readonly { caseObj: LabelCase; predicted: ScoredSignal }[]): BaselineScore {
  // Macro-average across the three signals for the always-ignored classifier.
  // This catches the "always-zero stub" failure mode: if every case is in
  // fact "ignored", the followed/contradicted signals contribute zeros but
  // the ignored signal is perfect — the baseline reflects that, not zeros.
  let pSum = 0;
  let rSum = 0;
  let fSum = 0;
  for (const signal of SCORED_SIGNALS) {
    const t = computePrecisionRecallF1(scored, signal);
    pSum += t.precision;
    rSum += t.recall;
    fSum += t.f1;
  }
  return {
    precision: clamp01(pSum / SCORED_SIGNALS.length),
    recall: clamp01(rSum / SCORED_SIGNALS.length),
    f1: clamp01(fSum / SCORED_SIGNALS.length),
  };
}

function computeSizeCorrelation(scored: readonly { caseObj: LabelCase; predicted: ScoredSignal }[]): number {
  if (scored.length < 2) return 0;
  const xs = scored.map(({ caseObj }) => caseObj.diffText.length);
  const ys = scored.map(({ predicted }) => (predicted === "followed" ? 1 : 0));
  return spearman(xs, ys);
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Spearman rank correlation between two numeric series.
 * Ties are resolved by mid-rank (the standard textbook correction).
 */
function spearman(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const rx = rankWithTies(xs);
  const ry = rankWithTies(ys);
  const sumSq = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  for (let i = 0; i < n; i++) {
    const x = rx[i];
    const y = ry[i];
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
    sumY2 += y * y;
  }
  const num = n * sumXY - sumX * sumY;
  const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denom === 0) return 0;
  return num / denom;
}

/**
 * Convert a numeric series to ranks (1-based). Ties share the mean rank of
 * the tied positions, which is the standard correction used by Spearman's
 * formula.
 */
function rankWithTies(values: readonly number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
    const avg = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) {
      ranks[indexed[k].i] = avg;
    }
    i = j + 1;
  }
  return ranks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps (declared last so the scoreEffectiveness impl above is
// already bound when tests stub it via the deps seam)
// ─────────────────────────────────────────────────────────────────────────────

export const _effectivenessEvalDeps = {
  getLogger,
  scoreEffectiveness: scoreEffectivenessImpl,
};

// ─────────────────────────────────────────────────────────────────────────────
// Error codes — public constants
// ─────────────────────────────────────────────────────────────────────────────

/** Error code used when JSON.parse fails — distinct from the schema code. */
export const INVALID_JSON_ERROR_CODE = "EVAL_INVALID_JSON";

/** Error code used when the JSON parses but does not match the schema. */
export const SCHEMA_INVALID_ERROR_CODE = "EVAL_SCHEMA_INVALID";
