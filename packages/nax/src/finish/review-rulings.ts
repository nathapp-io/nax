/**
 * Finish B §3.4: the review round's ruling checks. Step 2 runs every merged finding
 * against the rulings already in force; step 4 runs the plain findings still headed for
 * the fixer against the rulings the advisor made in step 3 (the same-round cross-lens case).
 * The advisor call is gated on `judgedEnabled` (budget 0 otherwise); the check is not.
 * Any failure carries the findings it was handling unresolved: never fixed against a ruling.
 */
import { getSafeLogger } from "@/logger";
import type { FinishAdvisor } from "./advise";
import { emptyJudged, type JudgeContext, type JudgedResult } from "./advise-core";
import { MAX_NEAR_MATCH_QUESTIONS } from "./advise-rulings";
import type { MergedFindings } from "./merge-findings";
import { checkRulings, type RulingCheck, rulingFromDropped, splitForRulings } from "./ruling-check";
import type { Finding } from "./types";

interface Deps {
  advise?: FinishAdvisor;
  assertNotAborted: () => void;
}

async function safeReconcile(
  deps: Deps,
  advisor: FinishAdvisor,
  check: RulingCheck,
  budget: number,
  jctx?: JudgeContext,
): Promise<{ result: JudgedResult; asked: number }> {
  if (check.reuse.length === 0 && check.near.length === 0) return { result: emptyJudged(), asked: 0 };
  try {
    return await advisor.reconcile(check, advisor.judgedEnabled ? Math.max(0, budget) : 0, jctx);
  } catch (err) {
    deps.assertNotAborted();
    getSafeLogger()?.warn("finish", "Ruling reconcile failed; carrying the matched findings unresolved", {
      storyId: "_run",
      error: String(err),
    });
    const unresolved = [...check.reuse.map((r) => r.finding), ...check.near.map((n) => n.finding)];
    return { result: { ...emptyJudged(), unresolved }, asked: 0 };
  }
}

export async function reconcileBefore(
  deps: Deps,
  merged: MergedFindings,
  jctx?: JudgeContext,
): Promise<{ merged: MergedFindings; result: JudgedResult; asked: number }> {
  const advisor = deps.advise;
  if (!advisor) return { merged, result: emptyJudged(), asked: 0 };
  const rulings = await advisor.rulingsInForce().catch(() => []);
  const split = splitForRulings(merged, rulings);
  const r = await safeReconcile(deps, advisor, split.check, MAX_NEAR_MATCH_QUESTIONS, jctx);
  return { merged: split.merged, ...r };
}

export async function reconcileAfter(
  deps: Deps,
  toFix: Finding[],
  judged: JudgedResult,
  budget: number,
  jctx?: JudgeContext,
): Promise<{ rest: Finding[]; result: JudgedResult }> {
  const advisor = deps.advise;
  if (!advisor || judged.dropped.length === 0) return { rest: toFix, result: emptyJudged() };
  const byId = new Map((judged.decisions ?? []).map((d) => [d.id, d]));
  const rulings = judged.dropped.map((d) => rulingFromDropped(d, byId.get(d.decisionId)));
  const check = checkRulings(toFix, rulings);
  const r = await safeReconcile(deps, advisor, check, budget, jctx);
  return { rest: check.rest, result: r.result };
}
