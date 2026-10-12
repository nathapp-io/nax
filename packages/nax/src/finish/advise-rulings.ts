/**
 * Finish B §3.4-§3.6: findings that repeat a ruling. Exact matches reuse it with no call;
 * near matches are asked (up to `budget` per round) with the matched rulings as evidence;
 * whatever cannot be asked is carried unresolved. Nothing here adds to the fix list except
 * an explicit `fix` ruling.
 */
import type { QuestionDraft } from "@/advisor";
import { readTrustedDecisions } from "@/advisor";
import {
  adviseOn,
  collectJudgment,
  emptyJudged,
  type FinishAdvisorDeps,
  type JudgeContext,
  type JudgedResult,
  judgmentQuestion,
  pinnedFor,
} from "./advise-core";
import { type Ruling, type RulingCheck, rulingFromDecision } from "./ruling-check";
import type { Finding } from "./types";

/** Near-match questions per review round (spec §3.6); separate from MAX_ADVISE_ROUNDS. */
export const MAX_NEAR_MATCH_QUESTIONS = 6;

export async function loadRulings(deps: FinishAdvisorDeps): Promise<Ruling[]> {
  const decisions = await readTrustedDecisions(deps.repoRoot, deps.feature, deps.outputDir).catch(() => []);
  return decisions.flatMap((d) => {
    const r = rulingFromDecision(d);
    return r ? [r] : [];
  });
}

export function nearQuestion(
  deps: FinishAdvisorDeps,
  f: Finding,
  rulings: Ruling[],
  jctx?: JudgeContext,
): QuestionDraft {
  const base = judgmentQuestion(deps, f.source ?? "quality", f, jctx);
  const ids = rulings.map((r) => r.id).join(", ");
  return {
    ...base,
    summary: `Possibly the same issue as ${ids}. ${base.summary}`,
    evidence: [...rulings.map((r) => ({ source: "decision" as const, ref: r.id, text: r.summary })), ...base.evidence],
  };
}

async function reuseOne(deps: FinishAdvisorDeps, out: JudgedResult, f: Finding, r: Ruling): Promise<void> {
  const recorded = r.decision
    ? await deps.advisor.recordReuse(judgmentQuestion(deps, f.source ?? "quality", f), r.decision)
    : null;
  const decisionId = recorded?.id ?? r.id;
  out.advice.push({ decisionId, optionId: r.decision?.chosenOptionId ?? "", reused: true });
  out.dropped.push({ finding: f, decisionId, action: r.action });
}

export async function reconcileRulings(
  deps: FinishAdvisorDeps,
  check: RulingCheck,
  budget: number,
  jctx?: JudgeContext,
): Promise<{ result: JudgedResult; asked: number }> {
  const out = emptyJudged();
  for (const { finding, ruling } of check.reuse) await reuseOne(deps, out, finding, ruling);
  let asked = 0;
  for (const { finding, rulings } of check.near) {
    if (asked >= budget) {
      out.unresolved.push(finding);
      continue;
    }
    asked += 1;
    const pinned = pinnedFor(deps, finding, jctx);
    collectJudgment(out, finding, await adviseOn(deps, nearQuestion(deps, finding, rulings, jctx), finding, pinned));
  }
  return { result: out, asked };
}
