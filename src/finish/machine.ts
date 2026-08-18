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
import { errorMessage } from "../utils/errors";
import { type AuditTarget, recordRound, writeResult } from "./audit";
import { buildCommitRound, commitFixes, filesInCommit } from "./commit";
import { buildFixCommitMessage } from "./commit-message";
import type { FinishContext } from "./context";
import { runAcceptanceGate } from "./gates/acceptance";
import { resolveGateCommands, runQualityGates } from "./gates/quality";
import type { FinishOps } from "./ops";
import { gateCommitRoute, routeAcceptance, routeQualityGates, routeReview } from "./route";
import type { FinishState } from "./state";
import type { Finding, FinishPhase, FinishResult, FinishTimeouts, QualityGateResult } from "./types";

export interface FinishMachineDeps {
  context: FinishContext;
  ops: FinishOps;
  audit: AuditTarget;
  signal?: AbortSignal;
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
  const { url, deliveryError } = await deps.ops.escalate(state, reason, findings);
  const result: FinishResult = {
    feature: state.feature,
    status: "escalated",
    escalationReason: reason,
    findings,
    ...(url ? { url } : {}),
    ...(deliveryError ? { deliveryError } : {}),
  };
  await writeResult(deps.audit, result);
  return result;
}

/** Step 1: the context-resolution route decided before the machine started. */
async function runPreconditions(state: FinishState, deps: FinishMachineDeps): Promise<FinishResult | null> {
  assertNotAborted(deps);
  const { context } = deps;
  if (context.route === "escalate") {
    return doEscalate(state, deps, context.reason ?? "Finish context could not be resolved.", []);
  }
  if (context.route === "nothing-to-finish") {
    state.status = "nothing-to-finish";
    const result: FinishResult = { feature: state.feature, status: "nothing-to-finish" };
    await writeResult(deps.audit, result);
    return result;
  }
  return null;
}

/**
 * Step 2: the acceptance fix-and-reverify loop. Also step 6's "gate zero"
 * reuses this when the acceptance status is not `disabled` — no, gate zero
 * runs the gate raw (see `runGateZero`); this function owns the *looped*
 * acceptance gate used at step 2 and again from step 4's spec-fix branch (I8).
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
    const routed = routeReview(phase, outcome, phaseState);

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
    const gates = await runGateZeroAndRepoGates(state, deps);
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
  assertNotAborted(deps);
  if (deps.ops.narrate) {
    await deps.ops.narrate(state);
  }
  state.status = promoted.status;
  const url = promoted.url ?? state.prUrl;
  const result: FinishResult = { feature: state.feature, status: promoted.status, ...(url ? { url } : {}) };
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
