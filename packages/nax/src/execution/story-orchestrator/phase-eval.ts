import type { Finding } from "@/findings";
import { getSafeLogger } from "@/logger";
import type { QuarantineMemo } from "@/verification";
import type { PhaseKind } from "./types";
import { STRATEGY_TO_REVALIDATION_PHASES, STRICT_VERDICT_PHASE_NAMES } from "./types";

/**
 * Stricter variant of `phasePassed` for SSOT carve-out logic. Where `phasePassed`
 * defensively treats missing/undefined/non-object outputs as "passed" (to avoid
 * fail-closing on ops that don't conform to the envelope), this requires an
 * affirmative `success === true` or `passed === true`. SSOT semantics ("verifier
 * judged this OK") must not trigger off a malformed envelope.
 */
export function phaseExplicitlyPassed(output: unknown): boolean {
  if (output === null || output === undefined || typeof output !== "object") return false;
  const r = output as Record<string, unknown>;
  return r.success === true || r.passed === true;
}

export function phasePassed(opName: string, output: unknown, storyId?: string): boolean {
  const strictVerdictPhase = STRICT_VERDICT_PHASE_NAMES.has(opName);
  if (output === null || output === undefined) {
    getSafeLogger()?.warn(
      "story-orchestrator",
      strictVerdictPhase
        ? "Strict phase produced no output — treating as fail"
        : "Phase produced no output — treating as pass",
      {
        storyId,
        phase: opName,
      },
    );
    return !strictVerdictPhase;
  }
  if (typeof output !== "object") {
    if (!strictVerdictPhase) return true;
    getSafeLogger()?.warn("story-orchestrator", "Strict phase produced non-object output — treating as fail", {
      storyId,
      phase: opName,
    });
    return false;
  }
  const r = output as Record<string, unknown>;
  if ("success" in r) return r.success !== false;
  if ("passed" in r) return r.passed !== false;
  getSafeLogger()?.warn(
    "story-orchestrator",
    strictVerdictPhase
      ? "Strict phase output has neither 'success' nor 'passed' — treating as fail"
      : "Phase output has neither 'success' nor 'passed' — treating as pass",
    {
      storyId,
      phase: opName,
    },
  );
  return !strictVerdictPhase;
}

function isFinding(value: unknown): value is Finding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { source?: unknown }).source === "string" &&
    (value as { source: string }).source.length > 0
  );
}

/**
 * Extract structured Findings from a phase output. Ops that produce LLM-shape findings
 * (semanticReviewOp / adversarialReviewOp) expose a `normalizedFindings: Finding[]`
 * field with `source` already tagged — strategies' `appliesTo` gates on `source`, so
 * the un-tagged raw `findings` must NEVER reach the rectification cycle (issue: when
 * the cast lied, `source` was undefined and every strategy was filtered out, producing
 * "no matching strategy" exits despite real blocking findings). We prefer
 * `normalizedFindings` when present and fall back to `findings` for ops whose envelope
 * already speaks the `Finding` wire format (verifierOp etc.).
 *
 * Exported for unit testing; not for external callers — use `runPhase`.
 */
export function extractPhaseFindings(output: unknown): Finding[] {
  if (output === null || output === undefined || typeof output !== "object") {
    return [];
  }
  const record = output as Record<string, unknown>;
  const rawArray =
    Array.isArray(record.normalizedFindings) && record.normalizedFindings.length > 0
      ? record.normalizedFindings
      : Array.isArray(record.findings)
        ? record.findings
        : [];
  // Runtime guard: strip anything that isn't a source-tagged Finding. Strategies'
  // `appliesTo` predicates gate on `f.source` — entries without it cannot be
  // routed and previously caused the cycle to exit with "no matching strategy".
  const findings = rawArray.filter(isFinding);
  const success =
    "success" in record ? record.success === true : "passed" in record ? record.passed === true : findings.length === 0;
  return success ? [] : findings;
}

/**
 * Failing-test identity keys (`file::testName`) from a full-suite-gate output.
 * Returns an empty set when the gate passed (extractPhaseFindings yields [] on
 * success). Used to detect gate failures *introduced* during rectification by
 * diffing against the verifier-time baseline — see ExecutionPlan.run success
 * aggregation.
 *
 * Excludes `flaky-test` findings (the quarantine category emitted by flake
 * triage): they are pre-existing flakes the story did not cause, so they must
 * not contribute to the regression key set. Exported for unit testing.
 */
export function gateFailureKeys(gateOutput: unknown): Set<string> {
  const keys = new Set<string>();
  for (const f of extractPhaseFindings(gateOutput)) {
    if (f.source !== "test-runner") continue;
    if (f.category === "flaky-test") continue;
    keys.add(gateFindingKey(f));
  }
  return keys;
}

/**
 * Identity key for a single gate test-failure finding: `file::rule`.
 *
 * SSOT for every consumer that has to decide "is this the same failure?" — baseline
 * diffing here, and quarantine-memo exclusion in both `describeGateRegression` and the
 * rectification validate sweep. Extracted because those consumers must agree: when the
 * sweep computed membership differently from the keep-decision that consumes its verdict,
 * a known flake could seed a fix attempt that the keep-decision would have ignored (#1401).
 */
export function gateFindingKey(finding: Finding): string {
  return `${finding.file ?? ""}::${finding.rule ?? ""}`;
}

/** Synthetic key for a gate failure with no comparable test identity. */
const KEYLESS_GATE_FAILURE_KEY = "::";

/**
 * The subset of a gate's findings that `describeGateRegression` would call regressed:
 * failures absent from the verifier-time baseline, plus keyless (timeout /
 * execution-failure) failures the key diff is blind to.
 *
 * Used by the rectification validate sweep so the findings it feeds the fix cycle are
 * exactly the ones the terminal keep-decision will later judge (#1452). Before this, the
 * verifier-SSOT carve-out discarded the gate's findings wholesale, so a regression
 * introduced BY rectification never entered the cycle's work queue — and the story was
 * then failed on it by the staleness guard, having never been given a chance to fix it.
 *
 * Quarantined flakes and findings already relabelled `flaky-test` are excluded, matching
 * `gatherRectificationFindings` and the memo exclusion in `describeGateRegression` (#1383).
 *
 * Pure function. Exported for unit testing.
 */
export function selectRegressedGateFindings(
  findings: readonly Finding[],
  baselineKeys: ReadonlySet<string>,
  quarantineMemo?: QuarantineMemo,
): Finding[] {
  return findings.filter((finding) => {
    if (finding.category === "flaky-test") return false;
    if (isQuarantinedFlake(finding, quarantineMemo)) return false;
    const key = gateFindingKey(finding);
    if (key === KEYLESS_GATE_FAILURE_KEY) return true;
    return !baselineKeys.has(key);
  });
}

/**
 * True when this finding is a test failure the run has already quarantined as a flake.
 *
 * Mirrors the exclusion `describeGateRegression` applies before assigning blame, so a
 * consumer that filters findings and a consumer that diffs keys reach the same verdict
 * about the same gate output. Keyless failures are never quarantinable: the regression
 * predicate treats them as attributable regardless of memo contents.
 */
export function isQuarantinedFlake(finding: Finding, quarantineMemo: QuarantineMemo | undefined): boolean {
  if (finding.source !== "test-runner") return false;
  const key = gateFindingKey(finding);
  return key !== KEYLESS_GATE_FAILURE_KEY && quarantineMemo?.has(key) === true;
}

/**
 * A gate-regression verdict together with the identities behind it.
 *
 * The evidence is part of the return value because the ADR-024 nbf rollback
 * (`runNonBlockingFix`) used to discard a best-effort pass with no recoverable record of
 * what broke: the new-key diff was computed here and thrown away, `phaseOutputs` is wiped
 * by the restore, and the offending edit is hard-reset away (#1382).
 */
export interface GateRegressionDetail {
  /** The verdict: did the gate get worse in a way attributable to this story? */
  regressed: boolean;
  /**
   * Structured failure keys in the final gate that are absent from the baseline AND
   * not already quarantined as flakes. These are what the story is blamed for.
   */
  regressedKeys: readonly string[];
  /**
   * Failing keys excluded because the run had already quarantined them as flakes
   * (`runtime.quarantineMemo`). Never contribute to `regressed` — a known flake is
   * not attributable to the story on any path (#1383).
   */
  memoExcludedKeys: readonly string[];
  /** Size of the verifier-time baseline the final gate was diffed against. */
  baselineKeySize: number;
  /**
   * The gate failed with no comparable identity (timeout ⇒ no findings, or
   * execution-failure ⇒ the synth `"::"` key). Such a failure is treated as a
   * regression on principle, so an empty `regressedKeys` here does NOT mean
   * "nothing regressed".
   */
  keyless: boolean;
}

/** Inputs to `describeGateRegression`. Options object — five positional params would breach the convention cap. */
export interface GateRegressionInput {
  /** The gate's FINAL output, after rectification / the nbf pass. */
  gateOutput: unknown;
  /** Failing-test identities captured before rectification (the verifier-time baseline). */
  baselineKeys: ReadonlySet<string>;
  /** Absent ⇒ no gate in the plan ⇒ nothing to be stale about. */
  gateName: string | undefined;
  storyId?: string;
  /**
   * Run-scoped quarantine memo (`runtime.quarantineMemo`). When supplied, failing keys
   * the run already quarantined as flakes are excluded from the blame set.
   *
   * Load-bearing for #1383: the nbf revalidation re-runs the gate but never flake-triages
   * it (triage owns the main gate path only), so without this a single known flake firing
   * inside the revalidation window deterministically discarded the best-effort pass — and
   * was indistinguishable in the logs from a real break. Omitted ⇒ pre-#1383 behaviour.
   */
  quarantineMemo?: QuarantineMemo;
}

/**
 * Did the full-suite gate REGRESS relative to the baseline, and on what evidence?
 *
 * Drives two decisions that must never disagree: the verifier-SSOT carve-out in the story
 * verdict, and ADR-024 §3's keep-or-restore for a best-effort nbf pass.
 *
 * Not regressed when the final gate is passing, or when there is no gate at all.
 * Otherwise it regressed if EITHER:
 *  - it carries a structured failure key that is absent from `baselineKeys` and not
 *    already quarantined (a new, identifiable, attributable failing test), OR
 *  - it failed in a KEYLESS form — a timeout (`findings: []` ⇒ empty key set) or an
 *    execution-failure (synth finding ⇒ `"::"`). These yield no identity to compare, so
 *    the structured key-diff alone is blind to them (audit #3). We cannot prove a keyless
 *    failure is the same one the baseline blessed, and silently exempting an unidentifiable
 *    red suite is exactly the laundering this guards against — so treat it as a regression.
 *
 * `keyless` is decided on the UNFILTERED key set, deliberately. Excluding quarantined keys
 * first would empty the set on a still-failing gate, which this function would then read as
 * a timeout — so the single-known-flake case (#1383's motivating case) would still be called
 * a regression, now mislabelled as keyless. The memo filter narrows blame; it must never
 * erase the fact that an identity existed.
 *
 * Pure over its input — exported for unit testing.
 */
export function describeGateRegression(input: GateRegressionInput): GateRegressionDetail {
  const { gateOutput, baselineKeys, gateName, storyId, quarantineMemo } = input;
  const notRegressed: GateRegressionDetail = {
    regressed: false,
    regressedKeys: [],
    memoExcludedKeys: [],
    baselineKeySize: baselineKeys.size,
    keyless: false,
  };
  // Green gate ⇒ not regressed. Also guards the keyless check below: a passing gate
  // has an empty key set too, but must never be read as a keyless failure.
  if (gateName === undefined || phasePassed(gateName, gateOutput, storyId)) return notRegressed;

  const allKeys = gateFailureKeys(gateOutput);
  const memoExcludedKeys = quarantineMemo ? [...allKeys].filter((k) => quarantineMemo.has(k)) : [];
  const excluded = new Set(memoExcludedKeys);
  const regressedKeys = [...allKeys].filter((k) => !baselineKeys.has(k) && !excluded.has(k));
  const keyless = allKeys.size === 0 || allKeys.has(KEYLESS_GATE_FAILURE_KEY);
  return {
    regressed: regressedKeys.length > 0 || keyless,
    regressedKeys,
    memoExcludedKeys,
    baselineKeySize: baselineKeys.size,
    keyless,
  };
}

/**
 * Determine which phases to re-run after a fix iteration.
 *
 * The verifier IS eligible for revalidation when a strategy mapped to include
 * it ran (full-suite-rectify only — it edits test code, changing the verdict).
 * autofix-implementer and autofix-test-writer address review findings, not the
 * TDD isolation boundary, so verifier is excluded from their sets.
 *
 * Falls back to all phases when:
 * - strategiesRun is undefined/empty (conservative default)
 * - any strategy name is unknown to the mapping (plugin-supplied strategy)
 *
 * Exported for unit testing — pure function over (strategiesRun, allPhases).
 */
export function phasesToRevalidate<T extends { readonly kind: PhaseKind }>(
  strategiesRun: readonly string[] | undefined,
  allPhases: readonly T[],
): readonly T[] {
  if (!strategiesRun || strategiesRun.length === 0) return allPhases;

  const unknown = strategiesRun.some((name) => STRATEGY_TO_REVALIDATION_PHASES[name] === undefined);
  if (unknown) return allPhases;

  const needed = new Set<PhaseKind>();
  for (const name of strategiesRun) {
    for (const kind of STRATEGY_TO_REVALIDATION_PHASES[name] ?? []) {
      needed.add(kind);
    }
  }
  return allPhases.filter((p) => needed.has(p.kind));
}

/**
 * Move `full-suite-gate` phases to the end of the revalidation order, preserving
 * the relative order of every other phase.
 *
 * Used by the terminal lite-validate so the expensive gate runs only after all
 * cheaper phases have passed (they short-circuit first on failure), while still
 * acting as the final arbiter of "resolved" rather than being skipped. Pure over
 * its input — exported for unit testing.
 */
export function orderGateLast<T extends { readonly kind: PhaseKind }>(phases: readonly T[]): T[] {
  const rest = phases.filter((p) => p.kind !== "full-suite-gate");
  const gates = phases.filter((p) => p.kind === "full-suite-gate");
  return [...rest, ...gates];
}
