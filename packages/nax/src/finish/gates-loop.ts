/**
 * The repo quality-gate fix-and-reverify loop. It records each gate's end
 * result in `state.gateFacts` and never ends the run: a gate that stays red
 * only keeps the PR a draft (spec §3).
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import { _guardDeps, dirtyAcceptancePaths, gateGuardPaths, guardWorthRecording, mergeGuard } from "./acceptance-guard";
import { recordRound } from "./audit";
import { writeCheckpoint } from "./checkpoint";
import { buildCommitRound, commitFixes, filesInCommit } from "./commit";
import { buildFixCommitMessage } from "./commit-message";
import { consumeIfCommitted, runFixStep } from "./fix-step";
import { runAcceptanceGate } from "./gates/acceptance";
import { resolveGateCommands, runQualityGates } from "./gates/quality";
import { assertNotAborted, type FinishMachineDeps, fixStepDeps } from "./machine-deps";
import type { ReviewLoopDeps } from "./review-loop";
import { runReviewLoop } from "./review-loop";
import { gateCommitRoute, gateFacts, MAX_REVIEW_ROUNDS, routeQualityGates } from "./route";
import type { FinishState } from "./state";
import type { QualityGateResult } from "./types";

/**
 * Gate zero: re-run acceptance before any repo command. Skipped when acceptance
 * is disabled, and when it is already red or unverified -- re-running a proven-bad
 * contract would only burn gate-fix attempts on it (A-4).
 */
async function runGateZero(state: FinishState, deps: FinishMachineDeps): Promise<QualityGateResult | null> {
  const { context } = deps;
  if (context.acceptanceStatus === "disabled") return null;
  if (state.acceptanceFact === "red" || state.acceptanceFact === "unverified") return null;
  const acc = await runAcceptanceGate(state.workdir, context.groups, { timeoutMs: deps.timeouts?.acceptanceMs });
  if (acc.passed) return null;
  return { passed: false, ran: ["acceptance"], failing: ["acceptance"], output: acc.output };
}

async function runRepoGates(state: FinishState, deps: FinishMachineDeps): Promise<QualityGateResult> {
  assertNotAborted(deps);
  const zero = await runGateZero(state, deps);
  if (zero) return zero;
  const commands = await resolveGateCommands(
    state.workdir,
    deps.context.groups.map((g) => g.packageDir),
  );
  return runQualityGates(state.workdir, commands, { timeoutMs: deps.timeouts?.gateMs });
}

async function recordGateRound(state: FinishState, deps: FinishMachineDeps, failing: string[]): Promise<void> {
  await recordRound(deps.audit, state, "gate", {
    ts: deps.now(),
    phase: "gate",
    committed: false,
    outcome: "no-reviewer",
    findings: [],
    failing,
  });
  await writeCheckpoint(deps.audit, state);
}

async function fixOnce(
  state: FinishState,
  deps: FinishMachineDeps,
  gates: QualityGateResult,
): Promise<{ committed: boolean; changed: boolean }> {
  assertNotAborted(deps);
  const paths = gateGuardPaths(gates.failing, deps.context);
  const preDirty = paths.length > 0 ? await dirtyAcceptancePaths(state.workdir, paths) : [];
  const step = await runFixStep(state, fixStepDeps(deps), "gate", {
    failing: gates.failing,
    gateOutput: gates.output,
    acceptancePaths: paths,
  });
  if (step.kind !== "done") {
    if (step.kind === "failed") {
      getSafeLogger()?.warn("finish", "Gate fix session failed; counted as used", {
        storyId: "_run",
        error: errorMessage(step.error),
      });
    }
    // Counted either way: routeQualityGates stops the loop on the attempt cap.
    state.phases.gate.fixAttempts += 1;
    return { committed: false, changed: false };
  }
  const guard = await _guardDeps.guard({
    workdir: state.workdir,
    paths: paths,
    allowed: [],
    preDirty,
  });
  if (guardWorthRecording(guard)) state.acceptanceGuard = mergeGuard(state.acceptanceGuard, guard);
  const fixOutcome = step.outcome;
  const message = buildFixCommitMessage(
    "gate",
    state.feature,
    { gate: { failing: gates.failing, output: gates.output } },
    { workdir: state.workdir },
  );
  const commit = await commitFixes(state.workdir, message, { skipHooks: true, excludeDir: deps.audit.auditDir });
  await consumeIfCommitted(state, step.continued, commit.committed);
  if (commit.committed) state.committedThisRun = true;
  const files = commit.committed && commit.shaAfter ? await filesInCommit(state.workdir, commit.shaAfter) : null;
  const route = gateCommitRoute(commit.committed, files, deps.context.testFileRegex);
  await recordRound(
    deps.audit,
    state,
    "gate",
    buildCommitRound({
      phase: "gate",
      committed: commit.committed,
      route,
      findings: [],
      failing: gates.failing,
      shaAfter: commit.shaAfter,
      now: deps.now(),
      dispositions: fixOutcome.dispositions,
    }),
  );
  state.phases.gate.fixAttempts += 1;
  if (commit.committed && commit.shaAfter) {
    state.unreviewedFixCommits = [...state.unreviewedFixCommits, commit.shaAfter];
  }
  return { committed: commit.committed, changed: route !== "unchanged" };
}

/** A gate runner that throws (not an abort) is one red gate carrying the error; a fix cannot help it. */
const CRASHED_GATE = "gates (runner crashed)";

async function runGatesOrCrash(
  state: FinishState,
  deps: FinishMachineDeps,
): Promise<{ gates: QualityGateResult; crashed: boolean }> {
  try {
    return { gates: await runRepoGates(state, deps), crashed: false };
  } catch (err) {
    assertNotAborted(deps);
    getSafeLogger()?.warn("finish", "Quality gates could not run", { storyId: "_run", error: errorMessage(err) });
    const output = errorMessage(err);
    return { gates: { passed: false, ran: [CRASHED_GATE], failing: [CRASHED_GATE], output }, crashed: true };
  }
}

export async function runGatesLoop(
  state: FinishState,
  deps: FinishMachineDeps,
  reviewDeps: ReviewLoopDeps,
): Promise<void> {
  for (;;) {
    assertNotAborted(deps);
    const { gates, crashed } = await runGatesOrCrash(state, deps);
    state.gatesRan = gates.ran;
    state.gateFacts = gateFacts(gates);
    const routed = routeQualityGates(gates, state.phases.gate);
    if (crashed || routed.route !== "fix") {
      await recordGateRound(state, deps, gates.failing);
      return;
    }
    const fixed = await fixOnce(state, deps, gates);
    // Every committed gate fix is owed a review (I4, tests-only included): one more round if any remain, else it stays unreviewed.
    if (fixed.changed && state.review.rounds < MAX_REVIEW_ROUNDS) await runReviewLoop(state, reviewDeps, 1);
  }
}
