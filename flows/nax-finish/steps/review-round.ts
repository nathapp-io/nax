/**
 * Recording the review rounds that produce no commit.
 *
 * `commit_<phase>` is the audit seam for rounds that *fix* something — it is the
 * only point where a round's findings and its resulting commit are both known.
 * But that made a commit the sole evidence a reviewer ever ran: a review that
 * passed produced no `fix_*`, therefore no `commit_*`, therefore no round, and
 * "this phase passed" became indistinguishable from "this phase never ran"
 * (#1507). Worse, it made the owed re-review in #1506 unprovable after the fact.
 *
 * So the two seams split by what they know:
 * - `commit_<phase>` records rounds that changed the tree (`outcome: "fixed"`).
 * - here records rounds that did not (`passed` / `unparseable` / `escalated`).
 *
 * Wrapping `routeReview` rather than living inside it keeps that function pure
 * and synchronous — it is the flow's routing SSOT and is exercised by a large
 * table of unit tests that would all have to become async otherwise.
 */
import { inputOf } from "../flow-ctx";
import type { OutputsCtx, StepsCtx } from "../flow-ctx";
import type { Finding, FinishRoundOutcome, ReviewVerdict } from "../types";
import { MAX_INCOMPLETE_ATTEMPTS, routeReview } from "../verdict";
import { appendRound } from "./result";
import { auditGaps } from "./review-audit";

/** Route → what to call the round. `fix` is absent by construction — see below. */
const OUTCOME_BY_ROUTE: Record<string, FinishRoundOutcome> = {
  clean: "passed",
  reprompt: "unparseable",
  escalate: "escalated",
  incomplete: "incomplete",
};

/**
 * The Nth time this phase's *review* node has run.
 *
 * Deliberately not `fixAttemptCount`: that counts `fix_<phase>` steps, which is
 * the right number for a round that fixed something and the wrong one here — a
 * review that passes on the first look runs zero fix nodes, and every clean
 * round would be numbered 0. Self-inclusive, for the same reason `repromptCount`
 * is: acpx records the `review_<phase>` step before `route_<phase>` executes.
 */
function reviewAttemptCount(ctx: StepsCtx, phase: "spec" | "quality"): number {
  return (ctx.state.steps ?? []).filter((s) => s.nodeId === `review_${phase}`).length;
}

/**
 * How many previous rounds of this phase were sent back as incomplete.
 *
 * NOT self-inclusive, unlike `repromptCount` — that one counts `review_<phase>`
 * steps, which acpx has already recorded by the time `route_<phase>` runs, while
 * this counts `route_<phase>` steps and we are *inside* the current one. So the
 * comparison below is `<`, where `routeReview`'s reprompt comparison is `<=`.
 */
function incompleteCount(ctx: StepsCtx, phase: "spec" | "quality"): number {
  return (ctx.state.steps ?? []).filter(
    (s) => s.nodeId === `route_${phase}` && (s.output as { route?: string } | undefined)?.route === "incomplete",
  ).length;
}

/**
 * Route this phase's review verdict, and record the round when it produced no
 * commit.
 *
 * `fix` is the one route that records nothing here: it leads to `fix_<phase>` →
 * `commit_<phase>`, which appends the round with the commit attached. Recording
 * at both seams would double-count every fixed round in the PR body.
 *
 * Best-effort, exactly like `appendRound` itself: the route is returned whether
 * or not the write lands. Losing the record is bad; failing the run that has
 * already done the work is worse.
 */
export async function routeReviewAndRecord(
  ctx: { input: unknown } & OutputsCtx & StepsCtx,
  phase: "spec" | "quality",
): Promise<{ route: string; escalationReason?: string; findings: Finding[]; gaps?: string[] }> {
  const routed = routeReview(ctx, phase);
  const input = inputOf(ctx);
  // The gate runs only on a verdict the flow would otherwise act on. `reprompt`
  // and `escalate` already end the round, and re-checking a verdict with no
  // content would report the same two gaps as a second failure mode.
  let result: { route: string; escalationReason?: string; findings: Finding[]; gaps?: string[] } = routed;
  if (routed.route === "clean" || routed.route === "fix") {
    const verdict = (ctx.outputs as Record<string, ReviewVerdict | undefined>)[`review_${phase}`];
    const gaps = verdict ? await auditGaps(verdict, input.workdir) : [];
    if (gaps.length > 0) {
      result =
        incompleteCount(ctx, phase) < MAX_INCOMPLETE_ATTEMPTS
          ? { ...routed, route: "incomplete", gaps }
          : {
              ...routed,
              route: "escalate",
              escalationReason: `${phase} review never discharged its reading obligations: ${gaps.join("; ")}`,
            };
    }
  }
  const outcome = OUTCOME_BY_ROUTE[result.route];
  if (outcome) {
    await appendRound(input, {
      ts: new Date().toISOString(),
      phase,
      attempt: reviewAttemptCount(ctx, phase),
      committed: false,
      outcome,
      findings: result.findings,
    });
  }
  return result;
}
