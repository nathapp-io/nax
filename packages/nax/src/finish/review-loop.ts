/**
 * A4 shared review loop (spec §5): both lenses review the whole branch, their
 * findings are merged and judged, and one fix session addresses what is left.
 * Used by the main flow, the gate-fix re-review and the advisor's re-review.
 *
 * Mutates `state.review`, `state.phases`, `state.unreviewedFixCommits` and the
 * commit flags. It never decides ready-vs-draft; `resolve` does, from the facts
 * this leaves behind.
 */
import { getSafeLogger } from "@/logger";
import type { AdviceRef, FinishAdvisor, JudgedResult } from "./advise";
import { judgeWithoutAdvisor } from "./advise";
import { type AuditTarget, recordRound } from "./audit";
import { buildCommitRound, commitFixes } from "./commit";
import { buildFixCommitMessage } from "./commit-message";
import { consumeIfCommitted, type FixStepDeps, runFixStep } from "./fix-step";
import { applyLedgerEvent, type LedgerEvent } from "./ledger";
import type { MergedFindings } from "./merge-findings";
import { mergeFindings } from "./merge-findings";
import type { FinishOps, ReviewInputs } from "./ops";
import { type ReviewRoundResult, runReviewRound } from "./review-round";
import { MAX_REVIEW_ROUNDS } from "./route";
import type { FinishState } from "./state";
import type { Finding, ReviewLens } from "./types";

/** Advisor rulings on judged findings, per finish, before the deterministic fallback takes over. */
export const MAX_ADVISE_ROUNDS = 2;

const LENSES: readonly ReviewLens[] = ["spec", "quality"];

export interface ReviewLoopDeps {
  ops: FinishOps;
  advise?: FinishAdvisor;
  inputs: ReviewInputs;
  audit: AuditTarget;
  now: () => string;
  assertNotAborted: () => void;
  /** Finish A: how every fix session runs (interrupt, set-aside, stops). */
  fix: FixStepDeps;
  /** Finish A: `finish.timeouts.reviewMs`, consumed by the review lens limit (later task). */
  reviewMs?: number;
}

function patchReview(state: FinishState, patch: Partial<FinishState["review"]>): void {
  state.review = { ...state.review, ...patch };
}

/** One record per lens that gave no findings: it either passed or gave no verdict. */
async function recordLensRounds(state: FinishState, deps: ReviewLoopDeps, round: ReviewRoundResult): Promise<void> {
  for (const lens of LENSES) {
    const out = round[lens];
    if (out.findings.length > 0) continue;
    await recordRound(deps.audit, state, lens, {
      ts: deps.now(),
      phase: lens,
      committed: false,
      outcome: out.missing ? "missing" : "passed",
      findings: [],
    });
  }
}

/** Coverage, title and summary from this round. A missing lens never wipes what an earlier round read. */
function noteRound(state: FinishState, round: ReviewRoundResult): void {
  const covered = { ...state.review.covered };
  for (const lens of LENSES) if (!round[lens].missing) covered[lens] = [...round[lens].covered];
  const { title, summary } = round.quality;
  patchReview(state, { covered, ...(title ? { title } : {}), ...(summary ? { summary } : {}) });
}

function ledgerEvent(state: FinishState, ev: LedgerEvent): void {
  patchReview(state, { ledger: applyLedgerEvent(state.review.ledger, ev) });
}

function recordJudgment(state: FinishState, judged: JudgedResult): void {
  for (const d of judged.dropped) {
    ledgerEvent(state, {
      kind: "ruled",
      finding: d.finding,
      state: d.action === "supersede" ? "superseded" : "waived",
      ref: d.decisionId,
    });
  }
  const heldRef = new Map(judged.held.map((h) => [h.finding, h.decisionId]));
  for (const u of judged.unresolved) {
    const ref = heldRef.get(u);
    ledgerEvent(state, { kind: "ruled", finding: u, state: "unresolved", ...(ref ? { ref } : {}) });
  }
}

function recordReviewStops(state: FinishState, deps: ReviewLoopDeps, round: ReviewRoundResult): void {
  for (const lens of LENSES) {
    if (!round[lens].stoppedAtLimit) continue;
    const stop = {
      kind: "review" as const,
      lens,
      round: state.review.rounds + 1,
      at: deps.now(),
      limitMs: deps.reviewMs ?? 0,
    };
    state.stops = [...state.stops, stop];
  }
}

async function judgeRound(state: FinishState, deps: ReviewLoopDeps, merged: MergedFindings): Promise<JudgedResult> {
  const { judged, contradictions } = merged;
  const advisor = deps.advise;
  const spent = state.phases.review.adviseRounds ?? 0;
  const nothingToJudge = judged.length === 0 && contradictions.length === 0;
  if (nothingToJudge || !advisor?.judgedEnabled || spent >= MAX_ADVISE_ROUNDS) {
    return judgeWithoutAdvisor(judged, contradictions);
  }
  state.phases.review.adviseRounds = spent + 1;
  try {
    return await advisor.judged(judged, contradictions, state);
  } catch (err) {
    deps.assertNotAborted();
    getSafeLogger()?.warn("finish", "Advisor failed on judged findings; carrying them unresolved", {
      storyId: "_run",
      error: String(err),
    });
    return judgeWithoutAdvisor(judged, contradictions);
  }
}

function addUnresolved(prev: Finding[], extra: Finding[]): Finding[] {
  const seen = new Set(prev.map((f) => `${f.title}\u0000${f.file ?? ""}`));
  const fresh = extra.filter((f) => {
    const key = `${f.title}\u0000${f.file ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...prev, ...fresh];
}

/** Spec findings first: the fix prompt numbers them in this order and dispositions come back by that number. */
function specFirst(findings: Finding[]): Finding[] {
  return [...findings.filter((f) => f.source === "spec"), ...findings.filter((f) => f.source !== "spec")];
}

async function fixRound(
  state: FinishState,
  deps: ReviewLoopDeps,
  fixList: Finding[],
  advice: AdviceRef[],
  atCap: boolean,
): Promise<void> {
  deps.assertNotAborted();
  const step = await runFixStep(state, deps.fix, "review", { findings: fixList });
  if (step.kind !== "done") {
    if (step.kind === "failed") {
      getSafeLogger()?.warn("finish", "Review fix session failed; findings stay open", {
        storyId: "_run",
        error: String(step.error),
      });
    }
    state.phases.review.fixAttempts += 1;
    if (step.handoff)
      ledgerEvent(state, { kind: "set-aside", findings: fixList, handoff: `handoff-${step.handoff.n}` });
    return;
  }
  const outcome = step.outcome;
  const message = buildFixCommitMessage(
    "review",
    state.feature,
    { findings: fixList },
    { workdir: state.workdir, dispositions: outcome.dispositions },
  );
  const commit = await commitFixes(state.workdir, message, { skipHooks: true });
  await consumeIfCommitted(state, step.continued, commit.committed);
  if (commit.committed && commit.shaAfter) {
    ledgerEvent(state, {
      kind: "fixed",
      findings: fixList,
      dispositions: outcome.dispositions ?? [],
      sha: commit.shaAfter,
    });
  }
  if (commit.committed) {
    state.committedThisRun = true;
    patchReview(state, { committedFixes: true });
  }
  await recordRound(deps.audit, state, "review", {
    ...buildCommitRound({
      phase: "review",
      committed: commit.committed,
      route: "fix",
      findings: fixList,
      shaAfter: commit.shaAfter,
      now: deps.now(),
      dispositions: outcome.dispositions,
    }),
    ...(advice.length > 0 ? { advice } : {}),
  });
  state.phases.review.fixAttempts += 1;
  // A fix made in the last allowed round was never re-reviewed. Only a real commit clears the findings:
  // a no-op fix (everything rejected, no diff) leaves them open for resolution to see.
  if (atCap && commit.committed && commit.shaAfter) {
    state.unreviewedFixCommits = [...state.unreviewedFixCommits, commit.shaAfter];
    patchReview(state, { lastFindings: [] });
  }
}

/** One round; true when the loop is finished (nothing left to fix). */
async function runOneRound(state: FinishState, deps: ReviewLoopDeps, limit: number): Promise<boolean> {
  const { ops, inputs } = deps;
  const round = await runReviewRound({
    spec: () => ops.reviewSpec(state, inputs),
    quality: () => ops.reviewBranch(state, inputs),
  });
  deps.assertNotAborted(); // a deadline during the lenses must not reach the advisor or a fix
  await recordLensRounds(state, deps, round);
  recordReviewStops(state, deps, round);
  noteRound(state, round);
  const merged = mergeFindings(round.spec.findings, round.quality.findings);
  const judged = await judgeRound(state, deps, merged);
  const raised = [...merged.toFix, ...merged.judged, ...merged.contradictions.flatMap((c) => [c.spec, c.quality])];
  ledgerEvent(state, { kind: "raised", findings: raised });
  if (round.missing.length === 0) ledgerEvent(state, { kind: "full-round", raised });
  recordJudgment(state, judged);
  const fixList = specFirst([...merged.toFix, ...judged.toFix]);
  patchReview(state, {
    rounds: state.review.rounds + 1,
    lastFindings: fixList,
    missingLenses: round.missing,
    unresolved: addUnresolved(state.review.unresolved, judged.unresolved),
  });
  // A round that saw both lenses has seen every commit made before it (its own fix commit excluded).
  if (round.missing.length === 0) state.unreviewedFixCommits = [];
  if (fixList.length === 0) return true;
  await fixRound(state, deps, fixList, judged.advice, state.review.rounds >= limit);
  return false;
}

/**
 * Runs review rounds until clean, nothing to fix, or the round cap.
 *
 * `extraRounds` of 0 (the default) allows rounds up to `MAX_REVIEW_ROUNDS` in
 * total for this finish. A positive value instead allows exactly that many
 * rounds beyond the ones already run: the gate-fix re-review and the advisor's
 * `re-review` both ask for one.
 */
export async function runReviewLoop(state: FinishState, deps: ReviewLoopDeps, extraRounds = 0): Promise<void> {
  const limit = extraRounds > 0 ? state.review.rounds + extraRounds : MAX_REVIEW_ROUNDS;
  while (state.review.rounds < limit) {
    deps.assertNotAborted();
    if (await runOneRound(state, deps, limit)) return;
  }
}
