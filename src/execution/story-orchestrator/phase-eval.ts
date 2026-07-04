import type { Finding } from "@/findings";
import { getSafeLogger } from "@/logger";
import type { InternalPhase, PhaseKind } from "./types";
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
    keys.add(`${f.file ?? ""}::${f.rule ?? ""}`);
  }
  return keys;
}

/**
 * The key `gateFailureKeys` emits for a gate failure with no identity — both `file`
 * and `rule` empty. Produced by execution-failure synth findings (non-zero exit, no
 * structured failures). Such a key cannot be diffed against a baseline, so the
 * staleness guard must treat it as a regression rather than a comparable identity.
 */
const KEYLESS_GATE_FAILURE_KEY = "::";

/**
 * Did the full-suite gate REGRESS during rectification relative to the verifier-time
 * baseline? Drives the verifier-SSOT carve-out: a verifier that passed exempts a red
 * gate as a "pre-existing/unrelated regression" ONLY while the gate did not get worse
 * after the verifier blessed it.
 *
 * Returns false when the final gate is passing (green ⇒ nothing to be stale about).
 *
 * When the final gate is failing, it regressed if EITHER:
 *  - it carries a structured failure key absent from `baselineKeys` (a new, identifiable
 *    failing test), OR
 *  - it failed in a KEYLESS form — a timeout (`findings: []` ⇒ empty key set) or an
 *    execution-failure (synth finding ⇒ `"::"`). These yield no identity to compare, so
 *    the structured key-diff alone is blind to them (audit #3). We cannot prove a keyless
 *    failure is the same one the verifier blessed, and silently exempting an unidentifiable
 *    red suite is exactly the laundering this guards against — so treat it as a regression.
 *
 * Pure over (output, baseline, gateName) — exported for unit testing.
 */
export function gateRegressedAfterRectification(
  finalGateOutput: unknown,
  baselineKeys: ReadonlySet<string>,
  gateName: string,
  storyId?: string,
): boolean {
  // Green gate ⇒ not regressed. Also guards the keyless check below: a passing gate
  // has an empty key set too, but must never be read as a keyless failure.
  if (phasePassed(gateName, finalGateOutput, storyId)) return false;

  const finalKeys = gateFailureKeys(finalGateOutput);
  const hasNewStructuredKey = [...finalKeys].some((k) => !baselineKeys.has(k));
  const isKeylessFailure = finalKeys.size === 0 || finalKeys.has(KEYLESS_GATE_FAILURE_KEY);
  return hasNewStructuredKey || isKeylessFailure;
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
export function phasesToRevalidate(
  strategiesRun: readonly string[] | undefined,
  allPhases: readonly InternalPhase[],
): readonly InternalPhase[] {
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
export function orderGateLast(phases: readonly InternalPhase[]): InternalPhase[] {
  const rest = phases.filter((p) => p.kind !== "full-suite-gate");
  const gates = phases.filter((p) => p.kind === "full-suite-gate");
  return [...rest, ...gates];
}
