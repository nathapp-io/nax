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
 *
 * This file is the test-writer stub. Real classification logic is owned by
 * the implementer in the next session; the stubs below compile and let
 * the failing tests resolve, but their return values do NOT satisfy the
 * acceptance criteria (cases array is empty, score numbers are absent, etc.).
 */

import { getLogger } from "../../logger";

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
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _effectivenessEvalDeps = {
  getLogger,
};

// ─────────────────────────────────────────────────────────────────────────────
// Stubs (deliberately wrong return values — implementer rewrites these bodies)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a JSON label-set file. Throws NaxError on invalid JSON or schema
 * failure so the CLI can map either to exit `2`.
 *
 * STUB: returns an empty case list so the success-path ACs fail.
 */
export function loadLabelSet(json: string): LabelSet {
  // Real implementation will JSON.parse + Zod-validate. Stub deliberately
  // returns an empty case set so AC1 (cases.length === 1) fails.
  return { version: 1, cases: [] };
}

/**
 * Score a classifier against a case list. Returns the EvalReport US-003's
 * gate consumes.
 *
 * STUB: returns an object missing the perSignal/baseline/sizeCorrelation
 * fields so the field-presence ACs (AC4–AC9) all fail.
 */
export function scoreEffectiveness(cases: readonly LabelCase[], _classifier: Classifier): EvalReport {
  // STUB: shape does not satisfy any of AC4-AC9.
  return {
    perSignal: {} as EvalReport["perSignal"],
    baseline: { precision: 0, recall: 0, f1: 0 },
    sizeCorrelation: 0,
    scoredCount: 0,
    excludedCount: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reserved for implementer — exports kept so US-003's tests can stub
// `scoreEffectiveness` and observe call shape. The seam is declared but the
// body is the implementer's.
// ─────────────────────────────────────────────────────────────────────────────

/** Error code used when JSON.parse fails — distinct from the schema code. */
export const INVALID_JSON_ERROR_CODE = "EVAL_INVALID_JSON";

/** Error code used when the JSON parses but does not match the schema. */
export const SCHEMA_INVALID_ERROR_CODE = "EVAL_SCHEMA_INVALID";
