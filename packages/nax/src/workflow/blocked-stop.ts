/**
 * US-006 (gate-config-route, #2899): a fix round that ended BLOCKED without a config change and left
 * the gates exactly as red as they were before it cannot converge, so the loop stops there and the
 * existing residual node adjudicates now instead of spending the rounds the story still had.
 *
 * The rule compares two in-memory gate runs: the pass before the round, which the loop kept in its
 * state, and the pass after it. Nothing is read back from a resumed record — a resumed story has no
 * previous pass in memory, so its first pass matches nothing and the rule cannot fire. Only
 * `gates.states` is compared (`redGateNamesOf`), as a set rather than an order or a set of findings:
 * a finding re-issued under a new id is the same red gate.
 *
 * The stop sends the story to the advisor, never to a second round, so it keeps the existing cost,
 * no-op-fix and narrower-residual rules' behaviour: the residual node's own terminal rules apply.
 */
import { redGateNamesOf } from "./config-change-absorb";
import { ledgerText } from "./ledger";
import type { StoryLoopEnv, StoryLoopState } from "./story-loop";
import type { GateName, GateRunResult, WorkflowFinding } from "./types";

export interface BlockedStopInput {
  /** The round the BLOCKED turn spent — the fix round's number. */
  readonly round: number;
  /** The turn the round ended with, as the loop recorded it, or absent when it recorded no reply. */
  readonly lastTurn: StoryLoopState["lastTurn"];
  /** The gate run of the pass *before* the round; absent is a story that has not run gates yet. */
  readonly previous: GateRunResult | undefined;
  /** The gate run of the pass after the round, whose exit this decides. */
  readonly current: GateRunResult | undefined;
  /** The findings still open after the current pass; its line names their ids. */
  readonly open: readonly WorkflowFinding[];
}

/** The same red gates, regardless of the order the two runs recorded them in. */
function sameRedGates(before: readonly GateName[], after: readonly GateName[]): boolean {
  return before.length === after.length && before.every((gate) => after.includes(gate));
}

/**
 * The ledger line that sends the story to the advisor, or `null` when the round could still converge:
 * a DONE reply, an applied config change, no red gate before the round, or a red set that moved.
 */
function unchangedBlockedNote(input: BlockedStopInput): string | null {
  // An applied change is the advisor's answer already spent on this round, so it gets another pass.
  if (input.lastTurn?.status !== "BLOCKED" || input.lastTurn.configApplied === true) return null;
  const before = redGateNamesOf(input.previous);
  if (before.length === 0) return null;
  const after = redGateNamesOf(input.current);
  if (!sameRedGates(before, after)) return null;
  const ids = input.open.map((finding) => finding.id).join(", ");
  return `fix round r${input.round} blocked with ${after.join(", ")} unchanged: ${ids} go to the advisor`;
}

/**
 * The early stop itself: ledgers the line and answers whether the pass must exit `capped`. A pass the
 * rule does not fire on writes nothing, so its ledger stays exactly what the round produced.
 */
export async function stopOnUnchangedBlock(env: StoryLoopEnv, input: BlockedStopInput): Promise<boolean> {
  const note = unchangedBlockedNote(input);
  if (note === null) return false;
  await env.sink.ledger(ledgerText.note(note));
  return true;
}
