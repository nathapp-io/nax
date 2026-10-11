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
import type { AcceptanceFact, AcceptanceGateResult, GateFact, QualityGateResult } from "./types";

/** Fix-and-reverify iterations tolerated per phase before escalating to a human. */
export const MAX_FIX_ATTEMPTS = 3;

/** Review rounds per finish (both lenses = one round); `re-review` adds one more. */
export const MAX_REVIEW_ROUNDS = 3;

/** What a gate decided: run on, fix and re-run, or stop (the run still ends in a PR, never an escalation). */
export type GateRoute = "proceed" | "fix" | "stop";

/**
 * What acceptance proved, as the end-of-run fact.
 *
 * "Nothing ran is not a pass": a passing result that ran zero groups, or that
 * left a group's test ungenerated, is `unverified` and can never make a PR
 * ready. A `disabled` status is the only way to `not-configured` — an empty
 * group list under an enabled status means the contract was never located, and
 * that fails closed.
 */
export function acceptanceFact(result: AcceptanceGateResult, acceptanceStatus: string): AcceptanceFact {
  if (acceptanceStatus === "disabled") return "not-configured";
  if (!result.passed) return "red";
  return result.missing.length > 0 || result.ran === 0 ? "unverified" : "green";
}

/**
 * Route the acceptance gate. `stop` replaces the old `escalate`: the cap was
 * reached or the contract is unverified, and the run carries on to a draft.
 */
export function routeAcceptance(
  result: AcceptanceGateResult,
  st: FinishPhaseState,
  acceptanceStatus = "ok",
): { route: GateRoute; fact: AcceptanceFact; reason?: string } {
  const fact = acceptanceFact(result, acceptanceStatus);
  if (fact === "green" || fact === "not-configured") return { route: "proceed", fact };
  if (fact === "unverified") {
    const reason =
      result.missing.length > 0
        ? `Acceptance test never generated for: ${result.missing.join(", ")}.`
        : "No acceptance test target resolved.";
    return { route: "stop", fact, reason };
  }
  if (st.fixAttempts >= MAX_FIX_ATTEMPTS) {
    return { route: "stop", fact, reason: `Acceptance tests still failing after ${st.fixAttempts} fix attempts.` };
  }
  return { route: "fix", fact };
}

/**
 * Route the repo's quality gates. Nothing configured is not a pass: an empty
 * `ran` list stops rather than asking an LLM fix node to invent the repo's
 * build/test commands.
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
      route: "stop",
      reason: "No quality.commands configured in .nax/config.json — nax-finish verified nothing.",
    };
  }
  if (st.fixAttempts >= MAX_FIX_ATTEMPTS) {
    return {
      route: "stop",
      reason: `Quality gates still failing after ${st.fixAttempts} fix attempts (${result.failing.join(", ")}).`,
    };
  }
  return { route: "fix" };
}

/** One entry per gate that ran: red (with the runner output) when it failed, else green. */
export function gateFacts(result: QualityGateResult): GateFact[] {
  if (result.ran.length === 0) {
    return [{ name: "quality.commands", status: "red", excerpt: "No quality.commands configured" }];
  }
  return result.ran.map((name) =>
    result.failing.includes(name) ? { name, status: "red", excerpt: result.output } : { name, status: "green" },
  );
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
