/** End state (spec §6 step 8, W-R3). A red gate stays red; rulings never turn it green (D4). */
import type { GateName, GateRunResult, WorkflowEndState } from "./types";

function redGates(result: GateRunResult | undefined): GateName[] {
  if (!result) return [];
  return (Object.entries(result.states) as [GateName, string][]).filter(([, s]) => s === "red").map(([g]) => g);
}

export function deriveEndState(input: {
  costStop: boolean;
  gates?: GateRunResult;
  suite?: GateRunResult;
  rulings: number;
}): { state: WorkflowEndState; reason: string } {
  if (input.costStop) return { state: "complete-gate-open", reason: "cost-limit" };
  const red = [...redGates(input.gates), ...redGates(input.suite)];
  if (red.length > 0 || input.gates?.red || input.suite?.red) {
    return { state: "complete-gate-open", reason: `red: ${red.join(", ") || "gate"}` };
  }
  if (input.rulings > 0) return { state: "complete-with-rulings", reason: `${input.rulings} ruling(s)` };
  return { state: "complete", reason: "clean" };
}
