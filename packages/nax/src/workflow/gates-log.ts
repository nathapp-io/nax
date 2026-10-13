/**
 * The gates' voice in the run log (nax#2491 P7): ONE line per gate run. Green reads
 * `US-004 gates lint ✓ 2.1s · typecheck ✓ 1.3s · scoped tests ✓ 4.7s (12 tests)`; a red run is
 * expanded, a header naming the red gates and one line per gate with the failing gate's findings.
 * The quality runner's own per-command Running/completed records are demoted to debug meanwhile
 * (`runQualityQuietly`), so this line replaces them rather than adding to them.
 */
import { EMOJI, formatDuration } from "@/log-format";
import { describeFindings, logWorkflow } from "./run-log";
import type { GateName, GateState, WorkflowFindingDraft } from "./types";

export interface GateReport {
  readonly name: GateName;
  readonly state: GateState;
  readonly ms: number;
  /** Shown after the time when green, e.g. `(4 tests)`. */
  readonly note?: string;
  readonly findings: readonly WorkflowFindingDraft[];
}

const LABEL: Readonly<Record<GateName, string>> = {
  lint: "lint",
  typecheck: "typecheck",
  scoped: "scoped tests",
  "full-suite": "full suite",
};

function glyph(state: GateState): string {
  return state === "green" ? EMOJI.success : state === "red" ? EMOJI.failure : EMOJI.skip;
}

function oneGate(g: GateReport): string {
  if (g.state === "skipped") return `${LABEL[g.name]} ${glyph(g.state)} skipped`;
  const note = g.note ? ` ${g.note}` : "";
  return `${LABEL[g.name]} ${glyph(g.state)} ${formatDuration(g.ms)}${note}`;
}

function expanded(g: GateReport): string {
  const found = g.state === "red" && g.findings.length > 0 ? ` - ${describeFindings(g.findings)}` : "";
  return `${oneGate(g)}${found}`;
}

export function logGates(storyId: string, reports: readonly GateReport[]): void {
  const red = reports.filter((g) => g.state === "red");
  if (red.length === 0) {
    logWorkflow(storyId, `${storyId} gates ${reports.map(oneGate).join(" · ")}`, { step: "gates" });
    return;
  }
  logWorkflow(storyId, `${storyId} gates red (${red.map((g) => g.name).join(", ")})`, { step: "gates" });
  for (const g of reports) logWorkflow(storyId, `${storyId} gate ${expanded(g)}`, { step: "gates", gate: g.name });
}
