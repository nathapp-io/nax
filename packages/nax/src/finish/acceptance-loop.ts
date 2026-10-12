/**
 * The acceptance fix-and-reverify loop. It records what acceptance proved in
 * `state.acceptanceFact` and never ends the run: a red or unverified contract
 * only keeps the PR a draft (spec §3).
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import { recordRound } from "./audit";
import { buildCommitRound, commitFixes } from "./commit";
import { buildFixCommitMessage } from "./commit-message";
import { runFixStep } from "./fix-step";
import { runAcceptanceGate } from "./gates/acceptance";
import { assertNotAborted, type FinishMachineDeps, fixStepDeps } from "./machine-deps";
import { routeAcceptance } from "./route";
import type { FinishState } from "./state";
import type { AcceptanceGateResult } from "./types";

/** `crashed` when the gate runner itself threw (not an abort): the contract is unproven and a fix cannot help. */
async function runGate(
  state: FinishState,
  deps: FinishMachineDeps,
): Promise<{ result: AcceptanceGateResult; crashed: boolean }> {
  try {
    const result = await runAcceptanceGate(state.workdir, deps.context.groups, {
      timeoutMs: deps.timeouts?.acceptanceMs,
    });
    return { result, crashed: false };
  } catch (err) {
    assertNotAborted(deps);
    getSafeLogger()?.warn("finish", "Acceptance gate could not run", { storyId: "_run", error: errorMessage(err) });
    const output = `acceptance gate could not run: ${errorMessage(err)}`;
    return { result: { passed: false, ran: 0, missing: [], output }, crashed: true };
  }
}

async function recordGateOutcome(state: FinishState, deps: FinishMachineDeps): Promise<void> {
  await recordRound(deps.audit, state, "acceptance", {
    ts: deps.now(),
    phase: "acceptance",
    committed: false,
    outcome: "no-reviewer",
    findings: [],
  });
}

async function fixOnce(state: FinishState, deps: FinishMachineDeps, output: string): Promise<void> {
  assertNotAborted(deps);
  const step = await runFixStep(state, fixStepDeps(deps), "acceptance", { acceptanceOutput: output });
  if (step.kind !== "done") {
    if (step.kind === "failed") {
      getSafeLogger()?.warn("finish", "Acceptance fix session failed; counted as used", {
        storyId: "_run",
        error: errorMessage(step.error),
      });
    }
    state.phases.acceptance.fixAttempts += 1;
    return;
  }
  const fixOutcome = step.outcome;
  const message = buildFixCommitMessage(
    "acceptance",
    state.feature,
    { acceptance: { output } },
    { workdir: state.workdir },
  );
  const commit = await commitFixes(state.workdir, message, { skipHooks: true });
  if (commit.committed) {
    state.committedThisRun = true;
    if (commit.shaAfter) state.unreviewedFixCommits = [...state.unreviewedFixCommits, commit.shaAfter];
  }
  await recordRound(
    deps.audit,
    state,
    "acceptance",
    buildCommitRound({
      phase: "acceptance",
      committed: commit.committed,
      route: "fix",
      findings: [],
      shaAfter: commit.shaAfter,
      now: deps.now(),
      dispositions: fixOutcome.dispositions,
    }),
  );
  state.phases.acceptance.fixAttempts += 1;
}

export async function runAcceptanceLoop(state: FinishState, deps: FinishMachineDeps): Promise<void> {
  if (deps.context.acceptanceStatus === "disabled") {
    state.acceptanceFact = "not-configured";
    return;
  }
  for (;;) {
    assertNotAborted(deps);
    const { result, crashed } = await runGate(state, deps);
    const routed = routeAcceptance(result, state.phases.acceptance, deps.context.acceptanceStatus);
    state.acceptanceFact = routed.fact;
    if (crashed || routed.route !== "fix") {
      await recordGateOutcome(state, deps);
      return;
    }
    await fixOnce(state, deps, result.output);
  }
}
