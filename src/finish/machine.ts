/**
 * The finish state machine: an explicit async loop replacing the 22-node acpx
 * graph in `flows/nax-finish/nax-finish.flow.ts` (read-only reference, never
 * imported — `flows/` is a separate module system).
 *
 * Structured as one outer `try` wrapping a sequence of small phase functions,
 * with a single `catch` that routes anything at all — a thrown `FinishOps`
 * failure or a `FINISH_ABORTED` abort — to `ops.escalate` (I7). No phase
 * function below may add its own try/catch around an `ops.*` call; doing so
 * would intercept the throw before this file's one catch sees it.
 *
 * Every recorded round goes through `recordRound` (`./audit`) — never
 * `appendRound` directly. A round that fixed something is recorded after its
 * commit; a round that did not (`passed` / `escalated` / `incomplete`) is
 * recorded at the point routing decided that. Each is recorded exactly once.
 */
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import { errorMessage } from "../utils/errors";
import { type AuditTarget, recordRound, type WriteResultOptions, writeResult } from "./audit";
import { buildCommitRound, commitFixes, filesInCommit, headSha } from "./commit";
import { buildFixCommitMessage } from "./commit-message";
import type { FinishContext } from "./context";
import { runAcceptanceGate } from "./gates/acceptance";
import { resolveGateCommands, runQualityGates } from "./gates/quality";
import type { FinishOps } from "./ops";
import { gateCommitRoute, routeAcceptance, routeQualityGates, routeReview } from "./route";
import type { FinishState } from "./state";
import type { Finding, FinishResult, FinishTimeouts, QualityGateResult } from "./types";

export interface FinishMachineDeps {
  context: FinishContext;
  ops: FinishOps;
  audit: AuditTarget;
  signal?: AbortSignal;
  /**
   * The *run's* signal, distinct from `signal` (which also carries the phase's
   * own `flowMs` deadline).
   *
   * `doEscalate` delivers an escalation for every failure path except one: a
   * run the user cancelled. Delivery pushes a `wip(...)` commit and writes to
   * the forge, and doing that while tearing down a Ctrl-C is a side effect
   * nobody asked for. A `flowMs` deadline is the opposite case — finish ran
   * too long and a human genuinely needs telling — so the two signals cannot
   * be collapsed into one check.
   */
  runSignal?: AbortSignal;
  /** Injected so tests can assert round ordering deterministically. */
  now: () => string;
  timeouts?: FinishTimeouts;
}

/** Reviewed phases loop the same shape; only their acceptance-reverify differs. */
type ReviewPhase = "spec" | "quality";

/** Checked at the top of every loop iteration and before each `ops.*` call (I6). */
function assertNotAborted(deps: FinishMachineDeps): void {
  if (deps.signal?.aborted) {
    throw new NaxError("Finish aborted mid-loop", "FINISH_ABORTED", { stage: "finish" });
  }
}

/**
 * Record the window a later re-review will diff from (D3.2).
 *
 * Applies to every reviewed phase that has already produced a verdict and has
 * no window yet — a commit made by the acceptance loop during a spec fix must
 * widen the spec reviewer's next window, which is why this is not scoped to the
 * phase that owns the commit.
 */
function noteCommitWindow(state: FinishState, shaBefore: string | null): void {
  if (!shaBefore) return;
  for (const phase of ["spec", "quality"] as const) {
    const st = state.phases[phase];
    if (st.reviewAttempts > 0 && !st.reviewSince) st.reviewSince = shaBefore;
  }
}

/**
 * Hand a terminal escalation to `ops.escalate` and persist the result.
 *
 * The single path every escalation goes through — both a routed `escalate`
 * decision and a caught throw (I7) — so the result file and `state` always
 * agree about why a run stopped.
 */
async function doEscalate(
  state: FinishState,
  deps: FinishMachineDeps,
  reason: string,
  findings: Finding[],
): Promise<FinishResult> {
  state.status = "escalated";
  state.escalationReason = reason;
  state.findings = findings;

  // Stamped onto the escalation result so a re-run at the same HEAD hits the
  // ledger's `already-finished` route instead of re-paging the same human
  // (#1674 part 1) — see `FinishResult.headSha`'s doc comment. `null` (no
  // repo, unborn branch) is dropped rather than written as a false key.
  const sha = await headSha(state.workdir);
  const base: FinishResult = {
    feature: state.feature,
    status: "escalated",
    escalationReason: reason,
    findings,
    branch: state.branch,
    ...(sha ? { headSha: sha } : {}),
  };
  // Written BEFORE delivery is attempted (#1399): "the one path whose job is
  // to say a human is needed was the one path with no fallback". An external
  // kill (Ctrl-C, OOM) part-way through delivery must still leave a result
  // file behind, which writing it afterwards cannot guarantee.
  //
  // `ledger: false` (post-review CRITICAL fix): at this point delivery has
  // not even been attempted, so this result must never be mistaken for a
  // completed escalation by a later run's ledger entry check — see
  // `updateLedger`'s doc comment (`./audit`) for the full reasoning.
  await safeWriteResult(deps, base, { ledger: false });

  // A run the user cancelled is not an escalation to broadcast -- see
  // `FinishMachineDeps.runSignal`. The result above is still on disk, so the
  // run stays auditable; only the outward-facing half is skipped.
  if (deps.runSignal?.aborted) {
    const aborted: FinishResult = { ...base, deliveryError: "run aborted before the escalation was delivered" };
    await safeWriteResult(deps, aborted);
    return aborted;
  }

  // ops.escalate is documented "must not throw" (./ops), but this is the
  // terminal safety net -- a violation here must still leave a result on
  // disk rather than propagate past the outer catch and skip writeResult.
  let url: string | undefined;
  let deliveryError: string | undefined;
  try {
    // `escalateWithoutPush` is set only by the closed-PR precondition route
    // (#1674 part 2, `./context`) — reachable here because that route
    // escalates out of `runPreconditions` before anything else runs, so no
    // other `doEscalate` caller can be carrying it.
    const push = deps.context.escalateWithoutPush ? { push: false } : undefined;
    ({ url, deliveryError } = await deps.ops.escalate(state, reason, findings, push));
  } catch (err) {
    deliveryError = errorMessage(err);
  }
  const result: FinishResult = {
    ...base,
    ...(url ? { url } : {}),
    ...(deliveryError ? { deliveryError } : {}),
  };
  // Only rewrite when delivery actually produced something to add -- the
  // pre-delivery write above already carries everything else.
  if (url || deliveryError) await safeWriteResult(deps, result);
  return result;
}

/**
 * `writeResult`, with a failure downgraded to a warning.
 *
 * Unguarded, a throw from here escapes `doEscalate`, reaches
 * `runFinishMachine`'s outer catch and lands in `doEscalate` a *second* time
 * -- delivering the same escalation twice (a duplicate PR comment and a
 * duplicate Telegram message) before failing anyway. The round trail and the
 * phase's own status write already record that finish escalated, so a lost
 * result file is worth strictly less than a duplicate page to a human.
 */
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
    return doEscalate(state, deps, context.reason ?? "Finish context could not be resolved.", []);
  }
  if (context.route === "already-finished") {
    // #1674 part 1: the entry check in `loadFinishContext` already confirmed
    // the ledger's branch/HEAD match this run and its recorded status was
    // terminal. Reuses `"nothing-to-finish"` as the machine-level status —
    // there genuinely is nothing new to finish — but sets `skipReason` so
    // `runFinishPhase` can tell this apart from a real zero-commits preflight
    // and report `status: "skipped"` rather than `"passed"` on status.json.
    state.status = "nothing-to-finish";
    const result: FinishResult = {
      feature: state.feature,
      status: "nothing-to-finish",
      skipReason: "already-finished",
      ...(context.prUrl ? { url: context.prUrl } : {}),
    };
    await writeResult(deps.audit, result);
    return result;
  }
  if (context.route === "nothing-to-finish") {
    state.status = "nothing-to-finish";
    // `skipReason`/`prUrl` are set only by the merged-PR short-circuit
    // (#1674 part 2); a plain zero-commits preflight carries neither, and
    // must keep reporting a bare `nothing-to-finish` as it always has.
    const result: FinishResult = {
      feature: state.feature,
      status: "nothing-to-finish",
      ...(context.skipReason ? { skipReason: context.skipReason } : {}),
      ...(context.prUrl ? { url: context.prUrl } : {}),
    };
    await writeResult(deps.audit, result);
    return result;
  }
  return null;
}

/**
 * Step 2: the acceptance fix-and-reverify loop. Step 6's gate zero
 * (`runGateZeroAndRepoGates`) re-runs the acceptance gate raw, not through
 * this loop — this function owns only the looped acceptance gate used at
 * step 2 and again from step 4's spec-fix branch (I8).
 */
async function runAcceptanceLoop(state: FinishState, deps: FinishMachineDeps): Promise<FinishResult | null> {
  const { context, audit, now, ops } = deps;
  if (context.acceptanceStatus === "disabled") return null;

  for (;;) {
    assertNotAborted(deps);
    const result = await runAcceptanceGate(state.workdir, context.groups, { timeoutMs: deps.timeouts?.acceptanceMs });
    const routed = routeAcceptance(result, state.phases.acceptance);

    if (routed.route === "proceed") {
      await recordRound(audit, state, "acceptance", {
        ts: now(),
        phase: "acceptance",
        committed: false,
        outcome: "no-reviewer",
        findings: [],
      });
      return null;
    }
    if (routed.route === "escalate") {
      await recordRound(audit, state, "acceptance", {
        ts: now(),
        phase: "acceptance",
        committed: false,
        outcome: "escalated",
        findings: [],
      });
      return doEscalate(state, deps, routed.reason ?? "Acceptance gate escalated.", []);
    }

    assertNotAborted(deps);
    const fixOutcome = await ops.fix("acceptance", { state, acceptanceOutput: result.output });
    const message = buildFixCommitMessage(
      "acceptance",
      state.feature,
      { acceptance: { output: result.output } },
      { workdir: state.workdir },
    );
    const commit = await commitFixes(state.workdir, message, { skipHooks: true });
    noteCommitWindow(state, commit.committed ? commit.shaBefore : null);
    // #1674 part 3: the one honest place to learn "did this run commit
    // anything" — see `FinishState.committedThisRun`'s doc comment.
    if (commit.committed) state.committedThisRun = true;
    await recordRound(
      audit,
      state,
      "acceptance",
      buildCommitRound({
        phase: "acceptance",
        committed: commit.committed,
        route: "fix",
        findings: [],
        shaAfter: commit.shaAfter,
        now: now(),
        dispositions: fixOutcome.dispositions,
      }),
    );
    state.phases.acceptance.fixAttempts += 1;
  }
}

/** Step 3: open the draft PR exactly once, guarded by `state.prUrl`. */
async function maybeOpenDraftPr(state: FinishState, deps: FinishMachineDeps): Promise<void> {
  if (state.prUrl) return;
  assertNotAborted(deps);
  const opened = await deps.ops.openDraftPr(state);
  if (opened) state.prUrl = opened.url;
}

/** Steps 4 and 5: the spec / quality review-fix-reverify loop. */
async function runReviewLoop(
  phase: ReviewPhase,
  state: FinishState,
  deps: FinishMachineDeps,
): Promise<FinishResult | null> {
  const { audit, now, ops } = deps;
  const phaseState = state.phases[phase];

  for (;;) {
    assertNotAborted(deps);
    const outcome = await ops.review(phase, { state });
    phaseState.reviewAttempts += 1;
    // The window and the gap notice describe the attempt just consumed --
    // clear both before routing decides anything for this call.
    phaseState.reviewSince = undefined;
    phaseState.reviewGaps = undefined;
    const routed = routeReview(phase, outcome, phaseState);
    // Set as soon as routing decides -- state.findings documents "the current
    // phase's reviewer last reported" (./types), and a throw from any op past
    // this point (fix, the commit, or a later phase) must escalate with these
    // findings rather than the [] the outer catch would otherwise see.
    state.findings = routed.findings;

    if (routed.route === "clean") {
      await recordRound(audit, state, phase, { ts: now(), phase, committed: false, outcome: "passed", findings: [] });
      return null;
    }
    if (routed.route === "incomplete") {
      phaseState.incompleteAttempts += 1;
      await recordRound(audit, state, phase, {
        ts: now(),
        phase,
        committed: false,
        outcome: "incomplete",
        findings: routed.findings,
      });
      // Order matters: the clear above runs at the top of the next
      // iteration after ops.review has already been handed the state, so a
      // gap set here survives exactly one review call.
      phaseState.reviewGaps = routed.gaps ?? [];
      continue;
    }
    if (routed.route === "escalate") {
      await recordRound(audit, state, phase, {
        ts: now(),
        phase,
        committed: false,
        outcome: "escalated",
        findings: routed.findings,
      });
      return doEscalate(state, deps, routed.escalationReason ?? `${phase} review escalated.`, routed.findings);
    }

    assertNotAborted(deps);
    const fixOutcome = await ops.fix(phase, { state, findings: routed.findings });
    const message = buildFixCommitMessage(
      phase,
      state.feature,
      { findings: routed.findings },
      { workdir: state.workdir, dispositions: fixOutcome.dispositions },
    );
    const commit = await commitFixes(state.workdir, message, { skipHooks: true });
    noteCommitWindow(state, commit.committed ? commit.shaBefore : null);
    // #1674 part 3 — see `FinishState.committedThisRun`'s doc comment.
    if (commit.committed) state.committedThisRun = true;
    await recordRound(
      audit,
      state,
      phase,
      buildCommitRound({
        phase,
        committed: commit.committed,
        route: "fix",
        findings: routed.findings,
        shaAfter: commit.shaAfter,
        now: now(),
        dispositions: fixOutcome.dispositions,
      }),
    );
    phaseState.fixAttempts += 1;

    if (phase === "spec") {
      // I8 — a spec fix can break the contract acceptance already proved works.
      const accResult = await runAcceptanceLoop(state, deps);
      if (accResult) return accResult;
    }
  }
}

/**
 * Gate zero (I5): re-run acceptance before any repo build/typecheck/lint/test
 * command, skipped only when `acceptanceStatus === "disabled"`. A failure here
 * is reported as a failing `"acceptance"` gate so it short-circuits straight
 * into the gate fix loop rather than falling through to `runQualityGates`'s
 * "nothing configured" branch, which would misreport a configured-but-skipped
 * acceptance step as if nothing was configured at all.
 */
async function runGateZeroAndRepoGates(state: FinishState, deps: FinishMachineDeps): Promise<QualityGateResult> {
  const { context } = deps;
  assertNotAborted(deps);
  if (context.acceptanceStatus !== "disabled") {
    const acc = await runAcceptanceGate(state.workdir, context.groups, { timeoutMs: deps.timeouts?.acceptanceMs });
    if (!acc.passed) {
      return { passed: false, ran: ["acceptance"], failing: ["acceptance"], output: acc.output };
    }
  }
  const packageDirs = context.groups.map((g) => g.packageDir);
  const commands = await resolveGateCommands(state.workdir, packageDirs);
  return runQualityGates(state.workdir, commands, { timeoutMs: deps.timeouts?.gateMs });
}

/** Steps 6 and 7: the repo quality-gate fix-and-reverify loop. */
async function runQualityGatesLoop(state: FinishState, deps: FinishMachineDeps): Promise<FinishResult | null> {
  const { audit, now, ops, context } = deps;

  for (;;) {
    assertNotAborted(deps);
    const gates = await runGateZeroAndRepoGates(state, deps);
    state.gatesRan = gates.ran;
    const routed = routeQualityGates(gates, state.phases.gate);

    if (routed.route === "green") {
      await recordRound(audit, state, "gate", {
        ts: now(),
        phase: "gate",
        committed: false,
        outcome: "no-reviewer",
        findings: [],
        failing: [],
      });
      return null;
    }
    if (routed.route === "escalate") {
      await recordRound(audit, state, "gate", {
        ts: now(),
        phase: "gate",
        committed: false,
        outcome: "escalated",
        findings: [],
        failing: gates.failing,
      });
      return doEscalate(state, deps, routed.reason ?? "Quality gates escalated.", []);
    }

    assertNotAborted(deps);
    const fixOutcome = await ops.fix("gate", { state, failing: gates.failing, gateOutput: gates.output });
    const message = buildFixCommitMessage(
      "gate",
      state.feature,
      { gate: { failing: gates.failing, output: gates.output } },
      { workdir: state.workdir },
    );
    const commit = await commitFixes(state.workdir, message, { skipHooks: true });
    noteCommitWindow(state, commit.committed ? commit.shaBefore : null);
    // #1674 part 3 — see `FinishState.committedThisRun`'s doc comment.
    if (commit.committed) state.committedThisRun = true;
    const files = commit.committed && commit.shaAfter ? await filesInCommit(state.workdir, commit.shaAfter) : null;
    const gateRoute = gateCommitRoute(commit.committed, files, context.testFileRegex);

    // Recorded after routing (I4): the round's `route` field must reflect the
    // routing decision this classification computed.
    await recordRound(
      audit,
      state,
      "gate",
      buildCommitRound({
        phase: "gate",
        committed: commit.committed,
        route: gateRoute,
        findings: [],
        failing: gates.failing,
        shaAfter: commit.shaAfter,
        now: now(),
        dispositions: fixOutcome.dispositions,
      }),
    );
    state.phases.gate.fixAttempts += 1;

    if (gateRoute === "changed" || gateRoute === "tests-only") {
      // I4 — every committed gate fix re-enters review, test-only included.
      const qualityResult = await runReviewLoop("quality", state, deps);
      if (qualityResult) return qualityResult;
    }
  }
}

/** Step 8: promote the PR, narrate if configured, then write the terminal result. */
async function finishTerminal(state: FinishState, deps: FinishMachineDeps): Promise<FinishResult> {
  assertNotAborted(deps);
  const promoted = await deps.ops.promotePr(state);
  // Set before `narrate` runs (#1674 part 3): `narrate` gates its own
  // PR-body rewrite on whether this run opened/promoted the PR, and the
  // only place that status lives on `state` is this field.
  state.status = promoted.status;
  assertNotAborted(deps);
  if (deps.ops.narrate) {
    await deps.ops.narrate(state);
  }
  const url = promoted.url ?? state.prUrl;
  // Same ledger stamp as `doEscalate` — see its comment. This is the one
  // path that reaches a genuinely successful terminal status
  // (opened/promoted/already-ready), so it is the other half of what makes
  // the ledger's entry check meaningful.
  const sha = await headSha(state.workdir);
  const result: FinishResult = {
    feature: state.feature,
    status: promoted.status,
    branch: state.branch,
    ...(sha ? { headSha: sha } : {}),
    ...(url ? { url } : {}),
  };
  await writeResult(deps.audit, result);
  return result;
}

export async function runFinishMachine(state: FinishState, deps: FinishMachineDeps): Promise<FinishResult> {
  try {
    const pre = await runPreconditions(state, deps);
    if (pre) return pre;

    const acceptance = await runAcceptanceLoop(state, deps);
    if (acceptance) return acceptance;

    await maybeOpenDraftPr(state, deps);

    const spec = await runReviewLoop("spec", state, deps);
    if (spec) return spec;

    const quality = await runReviewLoop("quality", state, deps);
    if (quality) return quality;

    const gates = await runQualityGatesLoop(state, deps);
    if (gates) return gates;

    return await finishTerminal(state, deps);
  } catch (err) {
    return await doEscalate(state, deps, errorMessage(err), state.findings ?? []);
  }
}
