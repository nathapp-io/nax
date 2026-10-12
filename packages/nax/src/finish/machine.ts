/**
 * The finish state machine: reviews the whole branch, fixes in one shared
 * loop, and always ends in a ready or draft PR (spec §3). There is no
 * escalation exit: anything that goes wrong becomes a draft PR carrying the
 * reason, or -- only when the run was cancelled or the forge itself failed --
 * a `failed` result.
 *
 * One outer `try` wraps the phase functions, with a single `catch`
 * (`recoverAfterThrow`) that routes any thrown `FinishOps` failure or
 * `FINISH_ABORTED` abort per the §3.1 table. A phase function adds its own
 * try/catch around an `ops.*` call only where the spec names the recovery (a
 * review lens, a review fix session, a gate runner).
 */

import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import { acceptancePathsOf } from "./acceptance-guard";
import { runAcceptanceLoop } from "./acceptance-loop";
import type { FinishAdvisor } from "./advise";
import { type WriteResultOptions, writeResult } from "./audit";
import { changedFiles } from "./changed-files";
import { writeCheckpoint } from "./checkpoint";
import { headSha } from "./commit";
import { runGatesLoop } from "./gates-loop";
import { restorePendingNumbers } from "./handoff-state";
import { applyLedgerEvent } from "./ledger";
import { assertNotAborted, type FinishMachineDeps, fixStepDeps } from "./machine-deps";
import type { ReviewInputs } from "./ops";
import { computeFacts, draftReason, type Resolution, resolve, stopReason } from "./resolve";
import { loadReviewInputs } from "./review-inputs";
import { type ReviewLoopDeps, runReviewLoop } from "./review-loop";
import type { FinishState } from "./state";
import type { FinishResolution, FinishResult, GateFact, ResolutionFacts } from "./types";

export type { FinishMachineDeps } from "./machine-deps";

/** `writeResult`, with a failure downgraded to a warning: a lost result file must not turn a finished PR into a throw. */
async function safeWriteResult(
  deps: FinishMachineDeps,
  result: FinishResult,
  options?: WriteResultOptions,
): Promise<void> {
  try {
    await writeResult(deps.audit, result, options);
  } catch (err) {
    getSafeLogger()?.warn("finish", "Finish result file could not be written", {
      storyId: "_run",
      error: errorMessage(err),
    });
  }
}

/** Step 1: the context-resolution route decided before the machine started. */
async function runPreconditions(state: FinishState, deps: FinishMachineDeps): Promise<FinishResult | null> {
  assertNotAborted(deps);
  const { context } = deps;
  if (context.route === "escalate") {
    return failedResult(state, deps, context.reason ?? "Finish context could not be resolved.");
  }
  if (context.route === "already-finished") {
    // #1674 part 1: the ledger already covers this exact HEAD. Reported as
    // `nothing-to-finish` with a `skipReason`, which `runFinishPhase` maps to "skipped".
    state.status = "nothing-to-finish";
    const result: FinishResult = {
      feature: state.feature,
      status: "nothing-to-finish",
      skipReason: "already-finished",
      ...(context.prUrl ? { url: context.prUrl } : {}),
    };
    await safeWriteResult(deps, result);
    return result;
  }
  if (context.route === "nothing-to-finish") {
    state.status = "nothing-to-finish";
    const result: FinishResult = {
      feature: state.feature,
      status: "nothing-to-finish",
      ...(context.skipReason ? { skipReason: context.skipReason } : {}),
      ...(context.prUrl ? { url: context.prUrl } : {}),
    };
    await safeWriteResult(deps, result);
    return result;
  }
  return null;
}

/** Step 3: open the draft PR exactly once, guarded by `state.prUrl`. */
async function maybeOpenDraftPr(state: FinishState, deps: FinishMachineDeps): Promise<void> {
  if (state.prUrl) return;
  assertNotAborted(deps);
  const opened = await deps.ops.openDraftPr(state);
  if (opened) state.prUrl = opened.url;
}

function reviewLoopDeps(deps: FinishMachineDeps, inputs: ReviewInputs): ReviewLoopDeps {
  return {
    ops: deps.ops,
    ...(deps.advise ? { advise: deps.advise } : {}),
    inputs,
    audit: deps.audit,
    now: deps.now,
    assertNotAborted: () => assertNotAborted(deps),
    fix: fixStepDeps(deps),
    ...(deps.timeouts?.reviewMs !== undefined ? { reviewMs: deps.timeouts.reviewMs } : {}),
    acceptancePaths: acceptancePathsOf(deps.context),
  };
}

const NOT_RUN_GATE: GateFact[] = [{ name: "gates", status: "not-run", excerpt: "not run" }];

/**
 * The end-of-run facts. Fail closed: acceptance that never reported is
 * `unverified`, gates that never ran are red, and a finish whose review loop
 * never completed a round has both lenses missing.
 */
function currentFacts(state: FinishState, changed: string[]): ResolutionFacts {
  if (state.review.rounds === 0) {
    state.review = { ...state.review, missingLenses: ["spec", "quality"] };
  }
  return computeFacts({
    review: state.review,
    acceptance: state.acceptanceFact ?? "unverified",
    gates: state.gateFacts ?? NOT_RUN_GATE,
    unreviewedFixCommits: state.unreviewedFixCommits,
    changed,
    ledger: state.review.ledger,
    stops: state.stops,
    restoreFailed: restorePendingNumbers(state.handoffs),
  });
}

/** An advisor that remembers whether it was asked, so the ledger is committed only when it ruled on something. */
function approvalAdvisor(advise: FinishAdvisor | undefined, asked: { value: boolean }): FinishAdvisor | undefined {
  if (!advise?.approvalEnabled) return undefined;
  return {
    ...advise,
    approval: (facts, approval) => {
      asked.value = true;
      return advise.approval(facts, approval);
    },
  };
}

async function reReview(state: FinishState, deps: FinishMachineDeps, rdeps: ReviewLoopDeps): Promise<void> {
  state.review = { ...state.review, reReviewUsed: true };
  const before = await headSha(state.workdir);
  await runReviewLoop(state, rdeps, 1);
  await writeCheckpoint(deps.audit, state);
  if ((await headSha(state.workdir)) !== before) {
    await runAcceptanceLoop(state, deps);
    await writeCheckpoint(deps.audit, state);
  }
  await runGatesLoop(state, deps, rdeps);
  await writeCheckpoint(deps.audit, state);
}

type Decision =
  | { outcome: "ready"; acceptedResidue: FinishResolution["acceptedResidue"] }
  | { outcome: "draft"; reason: string };

function toDecision(res: Resolution): Decision {
  if (res.outcome === "re-review") return { outcome: "draft", reason: "advisor asked for a second re-review" };
  return res;
}

async function decide(state: FinishState, deps: FinishMachineDeps, rdeps: ReviewLoopDeps) {
  const asked = { value: false };
  const advise = approvalAdvisor(deps.advise, asked);
  const run = async (): Promise<{ facts: ResolutionFacts; res: Resolution }> => {
    const facts = currentFacts(state, rdeps.inputs.changed);
    return { facts, res: await resolve({ facts, advise, reReviewUsed: state.review.reReviewUsed }) };
  };
  let out = await run();
  if (out.res.outcome === "re-review") {
    await reReview(state, deps, rdeps);
    out = await run();
  }
  const advisorRan = asked.value || (state.phases.review.adviseRounds ?? 0) > 0;
  return { facts: out.facts, decision: toDecision(out.res), advisorRan };
}

async function commitLedgerSafe(state: FinishState, deps: FinishMachineDeps): Promise<void> {
  try {
    await deps.advise?.commitLedger(state);
  } catch (err) {
    getSafeLogger()?.warn("finish", "Advisor ledger commit failed", { storyId: "_run", error: errorMessage(err) });
  }
}

/** Calls the forge once. `state.finalizing` tells `recoverAfterThrow` that a throw came from here. */
async function finalizePr(state: FinishState, deps: FinishMachineDeps, decision: Decision) {
  state.finalizing = true;
  const out = decision.outcome === "ready" ? await deps.ops.promotePr(state) : await deps.ops.finalizeDraftPr(state);
  state.finalizing = false;
  return out;
}

/** `result.handoffs` for a state that set work aside (absent when none did); on every terminal result. */
function handoffsField(state: FinishState): Pick<FinishResult, "handoffs"> {
  if (state.handoffs.length === 0) return {};
  return {
    handoffs: state.handoffs.map((h) => ({
      dir: h.dir,
      limit: h.limit,
      findingIds: h.findingIds,
      consumed: h.consumed,
      ...(h.reapplied !== undefined ? { reapplied: h.reapplied } : {}),
    })),
  };
}

async function finalizeResult(
  state: FinishState,
  deps: FinishMachineDeps,
  facts: ResolutionFacts,
  decision: Decision,
): Promise<FinishResult> {
  const acceptedResidue = decision.outcome === "ready" ? decision.acceptedResidue : [];
  if (acceptedResidue.length > 0) {
    const ledger = applyLedgerEvent(state.review.ledger, {
      kind: "accepted",
      findings: acceptedResidue,
      ref: "advisor approval",
    });
    state.review = { ...state.review, ledger };
  }
  const stopped = stopReason(state.stops);
  const reason =
    decision.outcome === "draft"
      ? stopped && !decision.reason.startsWith(stopped)
        ? `${stopped}; ${decision.reason}`
        : decision.reason
      : undefined;
  state.resolution = { outcome: decision.outcome, ...(reason ? { reason } : {}), facts, acceptedResidue };
  if (reason) state.reason = reason;
  const out = await finalizePr(state, deps, decision);
  state.status = out.status;
  await writeCheckpoint(deps.audit, state);
  // The PR path can add a commit to the facts (an unreviewed recovery commit).
  const finalFacts = state.resolution?.facts ?? facts;
  const sha = await headSha(state.workdir);
  const url = out.url ?? state.prUrl;
  const result: FinishResult = {
    feature: state.feature,
    status: out.status,
    outcome: decision.outcome,
    ...(reason ? { reason } : {}),
    // The ledger at finalize time: the PR body renders the same one (the earlier snapshot predates `accepted`).
    facts: { ...finalFacts, findings: [...state.review.ledger] },
    ...(acceptedResidue.length > 0 ? { acceptedResidue } : {}),
    ...(decision.outcome === "draft" ? { findings: finalFacts.findingsOpen } : {}),
    ...handoffsField(state),
    branch: state.branch,
    ...(sha ? { headSha: sha } : {}),
    ...(url ? { url } : {}),
  };
  await safeWriteResult(deps, result);
  return result;
}

async function resolveAndFinalize(
  state: FinishState,
  deps: FinishMachineDeps,
  rdeps: ReviewLoopDeps,
): Promise<FinishResult> {
  assertNotAborted(deps);
  const { facts, decision, advisorRan } = await decide(state, deps, rdeps);
  if (advisorRan) await commitLedgerSafe(state, deps);
  assertNotAborted(deps);
  return finalizeResult(state, deps, facts, decision);
}

/** A result that ends the finish without a PR: a cancelled run, a precondition failure, or a forge failure. */
async function failedResult(state: FinishState, deps: FinishMachineDeps, reason: string): Promise<FinishResult> {
  state.status = "failed";
  state.reason = reason;
  const sha = await headSha(state.workdir).catch(() => null);
  const result: FinishResult = {
    feature: state.feature,
    status: "failed",
    outcome: "failed",
    reason,
    branch: state.branch,
    ...(sha ? { headSha: sha } : {}),
    ...handoffsField(state),
    ...(state.stops.length > 0 ? { stops: [...state.stops] } : {}),
  };
  await safeWriteResult(deps, result);
  return result;
}

/** Spec 3.3: a cancelled run is a `run` stop, never `flow`. A fix session aborted by the run already recorded its own. */
function recordRunStop(state: FinishState, deps: FinishMachineDeps): void {
  if (!deps.runSignal?.aborted || state.stops.some((s) => s.kind === "run")) return;
  state.stops = [
    ...state.stops,
    {
      kind: "run",
      ...(state.step ? { step: state.step } : {}),
      round: state.review.pendingRound || state.review.rounds,
      at: deps.now(),
      limitMs: 0,
    },
  ];
}

function recordFlowStop(state: FinishState, deps: FinishMachineDeps): void {
  if (!deps.signal?.aborted || deps.runSignal?.aborted) return;
  if (state.stops.some((s) => s.kind === "flow")) return;
  state.stops = [
    ...state.stops,
    {
      kind: "flow",
      ...(state.step ? { step: state.step } : {}),
      // Convention: the review round the stop interrupted (lenses running), else the last completed one.
      round: state.review.pendingRound || state.review.rounds,
      at: deps.now(),
      limitMs: deps.timeouts?.flowMs ?? 0,
    },
  ];
}

/** The §3.1 table: what a throw becomes. */
async function recoverAfterThrow(
  state: FinishState,
  deps: FinishMachineDeps,
  err: unknown,
  inputs?: ReviewInputs,
): Promise<FinishResult> {
  const message = errorMessage(err);
  if (deps.runSignal?.aborted) {
    recordRunStop(state, deps);
    return failedResult(state, deps, "aborted");
  }
  if (state.finalizing) return failedResult(state, deps, message);
  recordFlowStop(state, deps);
  await writeCheckpoint(deps.audit, state);
  const prefix = deps.signal?.aborted ? (stopReason(state.stops) ?? "deadline") : `finish error: ${message}`;
  try {
    const changed = inputs?.changed ?? (await changedFiles(state.workdir, state.base));
    if (changed.length === 0) {
      getSafeLogger()?.warn("finish", "No changed files for coverage on the recovery path", { storyId: "_run" });
    }
    const facts = currentFacts(state, changed);
    const detail = draftReason(facts);
    const decision: Decision = { outcome: "draft", reason: detail ? `${prefix}; ${detail}` : prefix };
    return await finalizeResult(state, deps, facts, decision);
  } catch (finalizeErr) {
    return failedResult(state, deps, errorMessage(finalizeErr));
  }
}

export async function runFinishMachine(state: FinishState, deps: FinishMachineDeps): Promise<FinishResult> {
  let inputs: ReviewInputs | undefined;
  try {
    const pre = await runPreconditions(state, deps);
    if (pre) return pre;
    state.step = "acceptance";
    await runAcceptanceLoop(state, deps);
    await writeCheckpoint(deps.audit, state);
    await maybeOpenDraftPr(state, deps);
    inputs = await loadReviewInputs(state, deps.outputDir);
    const rdeps = reviewLoopDeps(deps, inputs);
    state.step = "review";
    await runReviewLoop(state, rdeps);
    await writeCheckpoint(deps.audit, state);
    if (state.review.committedFixes) {
      state.step = "acceptance";
      await runAcceptanceLoop(state, deps);
      await writeCheckpoint(deps.audit, state);
    }
    state.step = "gate";
    await runGatesLoop(state, deps, rdeps);
    await writeCheckpoint(deps.audit, state);
    state.step = "resolve";
    return await resolveAndFinalize(state, deps, rdeps);
  } catch (err) {
    return await recoverAfterThrow(state, deps, err, inputs);
  }
}
