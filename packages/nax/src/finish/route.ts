/**
 * Deterministic routing over explicit state.
 *
 * Ported from `flows/nax-finish/verdict.ts` (the routing half — parsing is
 * plan 3's), `flows/nax-finish/steps/gates.ts` (the acceptance/quality-gate
 * routing), and `flows/nax-finish/nax-finish.flow.ts` /
 * `flows/nax-finish/steps/context.ts` (the commit-classification helpers).
 * `flows/` is read-only reference — never imported from `src/` — so every
 * function here is a fresh implementation against `FinishPhaseState` instead
 * of `ctx.state.steps` / `ctx.outputs`.
 *
 * Everything here is pure and synchronous: no I/O, no clock, no throw. The
 * caller (a later task's state machine) owns running gates, parsing replies,
 * and persisting the resulting `FinishState`.
 */
import type { FinishPhaseState } from "./state";
import type { AcceptanceGateResult, Finding, QualityGateResult } from "./types";

/** Fix-and-reverify iterations tolerated per phase before escalating to a human. */
export const MAX_FIX_ATTEMPTS = 3;

/** Reviews sent back for missing evidence sections, per phase, before escalating. */
export const MAX_INCOMPLETE_ATTEMPTS = 1;

export type ReviewRoute = "clean" | "fix" | "escalate" | "incomplete";
export type GateRoute = "proceed" | "fix" | "escalate";

/** What a reviewer produced, after plan 3's op has parsed it. */
export interface ReviewOutcome {
  findings: Finding[];
  /** Reading obligations the reviewer did not discharge; empty means it did. */
  gaps: string[];
}

export interface RoutedReview {
  route: ReviewRoute;
  findings: Finding[];
  escalationReason?: string;
  gaps?: string[];
}

/**
 * Turn a parsed review outcome into a deterministic route.
 *
 * Order matters and must not be reshuffled:
 *
 * 1. An absent `outcome` means the op returned nothing — the reviewer node
 *    never ran, or died before emitting. Neither is an approval, and there is
 *    no reprompt path any more (D2.2): a step that emitted nothing has no
 *    reply to quote back, so this escalates straight to a human without
 *    reading `outcome.findings` (there is none to read).
 * 2. A finding marked `judgment` escalates before the gap/count checks below
 *    — a reviewer can flag one finding as needing a human even while the rest
 *    of its reply is otherwise well-formed and under every cap.
 * 3. Unresolved `gaps` route `incomplete` while under the cap, then escalate.
 *    This runs before the "no findings" check: a reviewer that skipped its
 *    own evidence sections does not get to approve just because it also
 *    reported nothing wrong.
 * 4. Only past the gap check can zero findings mean `clean`.
 * 5. Findings under the fix-attempt cap route `fix`; at or past it, escalate.
 */
export function routeReview(
  phase: "spec" | "quality",
  outcome: ReviewOutcome | undefined,
  st: FinishPhaseState,
): RoutedReview {
  if (!outcome) {
    return {
      route: "escalate",
      findings: [],
      escalationReason: `${phase} reviewer produced no verdict — the node emitted no output, so nothing reviewed this diff.`,
    };
  }

  const judged = outcome.findings.find((f) => f.judgment);
  if (judged) {
    return {
      route: "escalate",
      findings: outcome.findings,
      escalationReason: judged.judgmentReason ?? `Needs human judgment: ${judged.title}`,
    };
  }

  if (outcome.gaps.length > 0) {
    if (st.incompleteAttempts < MAX_INCOMPLETE_ATTEMPTS) {
      return { route: "incomplete", findings: outcome.findings, gaps: outcome.gaps };
    }
    return {
      route: "escalate",
      findings: outcome.findings,
      escalationReason: `${phase} review never discharged its reading obligations: ${outcome.gaps.join("; ")}`,
      gaps: outcome.gaps,
    };
  }

  if (outcome.findings.length === 0) {
    return { route: "clean", findings: [] };
  }

  if (st.fixAttempts >= MAX_FIX_ATTEMPTS) {
    return {
      route: "escalate",
      findings: outcome.findings,
      escalationReason: `${phase} review still reporting ${outcome.findings.length} finding(s) after ${st.fixAttempts} fix attempts.`,
    };
  }
  return { route: "fix", findings: outcome.findings };
}

/**
 * Route the acceptance gate, lifted out of `acceptanceGateNode` in
 * `flows/nax-finish/steps/gates.ts`. The `no-prd` / `disabled` pre-checks stay
 * out of scope here — those come from the feature resolution, not from an
 * `AcceptanceGateResult`, and belong to the caller that resolves the feature.
 *
 * "Nothing ran is not a pass": a passing result that ran zero groups, or that
 * left a group's test ungenerated, still escalates rather than proceeding.
 */
export function routeAcceptance(
  result: AcceptanceGateResult,
  st: FinishPhaseState,
): { route: GateRoute; reason?: string } {
  if (result.passed) {
    if (result.missing.length > 0) {
      return {
        route: "escalate",
        reason: `Acceptance test never generated for: ${result.missing.join(", ")} — that package's contract is unverified.`,
      };
    }
    if (result.ran === 0) {
      return {
        route: "escalate",
        reason: "No acceptance test target resolved — nothing verified its contract.",
      };
    }
    return { route: "proceed" };
  }
  if (st.fixAttempts >= MAX_FIX_ATTEMPTS) {
    return {
      route: "escalate",
      reason: `Acceptance tests still failing after ${st.fixAttempts} fix attempts.`,
    };
  }
  return { route: "fix" };
}

/**
 * Route the repo's quality gates, lifted out of `qualityGatesNode` in
 * `flows/nax-finish/steps/gates.ts`. The acceptance-reverify branch
 * (`reverifyAcceptance`) stays out of scope — that is running behaviour, not
 * routing, and belongs to the caller that re-runs the acceptance gate before
 * calling this.
 *
 * Nothing configured is not a pass: an empty `ran` list escalates rather than
 * asking an LLM fix node to invent the repo's build/test commands.
 */
export function routeQualityGates(
  result: QualityGateResult,
  st: FinishPhaseState,
): { route: GateRoute | "green"; reason?: string } {
  if (result.passed) {
    return { route: "green" };
  }
  if (result.ran.length === 0) {
    return {
      route: "escalate",
      reason: "No quality.commands configured in .nax/config.json — nax-finish verified nothing.",
    };
  }
  if (st.fixAttempts >= MAX_FIX_ATTEMPTS) {
    return {
      route: "escalate",
      reason: `Quality gates still failing after ${st.fixAttempts} fix attempts (${result.failing.join(", ")}).`,
    };
  }
  return { route: "fix" };
}

/**
 * Split paths into test and non-test, using the regexes `nax features
 * resolve` reported. Ported from `partitionTestFiles` in
 * `flows/nax-finish/steps/context.ts` — `gateCommitRoute` below is its only
 * caller and lives here now.
 *
 * With no patterns (older nax, or a config the resolver choked on) every path
 * is reported as non-test — the safe direction, since the one caller skips
 * its re-review only for a test-only change: "cannot classify" must mean
 * "review it", never "skip it".
 *
 * An unparseable regex source is skipped rather than thrown — a bad pattern
 * in one config entry must not take a finish down mid-loop.
 */
export function partitionTestFiles(paths: string[], regexSources: string[]): { test: string[]; nonTest: string[] } {
  const matchers: RegExp[] = [];
  for (const src of regexSources) {
    try {
      matchers.push(new RegExp(src));
    } catch {
      // Skip — see the doc comment above.
    }
  }
  const test: string[] = [];
  const nonTest: string[] = [];
  for (const p of paths) {
    (matchers.some((re) => re.test(p)) ? test : nonTest).push(p);
  }
  return { test, nonTest };
}

/**
 * Route for `commit_gate`, whose successor depends on what the fix touched.
 * Ported from `gateCommitRoute` in `flows/nax-finish/nax-finish.flow.ts`.
 *
 * - `unchanged` — nothing committed; no new diff, so nothing to review.
 * - `tests-only` — every touched path matched the repo's test-file patterns.
 * - `changed` — production code was touched, or the paths could not be
 *   classified at all. "Cannot classify" reviews rather than skips.
 *
 * `files` is `null` when the post-commit SHA could not be resolved — the
 * caller's stand-in for the original `!shaAfter` branch, since this function
 * no longer resolves the SHA or lists its files itself. That case still
 * routes `changed`: the fix is real and unclassifiable, so it must be
 * reviewed. Folding it into the `!committed` branch would skip the review for
 * a change that actually landed — the one direction this function must never
 * fail in. An empty (but resolved) file list is also `changed`, for the same
 * reason.
 */
export function gateCommitRoute(
  committed: boolean,
  files: string[] | null,
  testFileRegex: string[],
): "changed" | "tests-only" | "unchanged" {
  if (!committed) return "unchanged";
  if (files === null) return "changed";
  if (files.length === 0) return "changed";
  return partitionTestFiles(files, testFileRegex).nonTest.length > 0 ? "changed" : "tests-only";
}
