/**
 * End state (spec §6 step 8, W-R3). A red gate stays red; rulings never turn it green (D4).
 * #2934: a `hold` ruling keeps its finding open for a human, so a held story is not finished
 * either: it closes gate-open, after the cost and red-gate reasons, which name their own cause.
 */
import type { GateName, GateRunResult, WorkflowEndState, WorkflowRuling } from "./types";

function redGates(result: GateRunResult | undefined): GateName[] {
  if (!result) return [];
  return (Object.entries(result.states) as [GateName, string][]).filter(([, s]) => s === "red").map(([g]) => g);
}

/** #2934: the reason prefix of a story closed by a hold; `repoGatesStep` reads it. */
export const HELD_REASON_PREFIX = "held for a human: ";

export function deriveEndState(input: {
  costStop: boolean;
  gates?: GateRunResult;
  suite?: GateRunResult;
  timedOut?: readonly GateName[];
  rulings: number;
  /** Finding ids of the story's `hold` rulings (#2934). */
  holds?: readonly string[];
}): { state: WorkflowEndState; reason: string } {
  if (input.costStop) return { state: "complete-gate-open", reason: "cost-limit" };
  const red = [...redGates(input.gates), ...redGates(input.suite)];
  if (red.length > 0 || input.gates?.red || input.suite?.red) {
    const timeout = red.length > 0 && red.every((gate) => input.timedOut?.includes(gate));
    return { state: "complete-gate-open", reason: `${timeout ? "gate timeout" : "red"}: ${red.join(", ") || "gate"}` };
  }
  const holds = input.holds ?? [];
  if (holds.length > 0) return { state: "complete-gate-open", reason: `${HELD_REASON_PREFIX}${holds.join(", ")}` };
  if (input.rulings > 0) return { state: "complete-with-rulings", reason: `${input.rulings} ruling(s)` };
  return { state: "complete", reason: "clean" };
}

/** #2934: the findings a `hold` ruling left open, in ruling order. */
export function heldFindings(rulings: readonly WorkflowRuling[]): string[] {
  return rulings.filter((r) => r.action === "hold").map((r) => r.findingId ?? "(no finding id)");
}
