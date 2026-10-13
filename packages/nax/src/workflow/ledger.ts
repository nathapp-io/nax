/**
 * The run's recovery map (spec §9). One line per event, `<storyId>: <text>`,
 * in the subagent-driven-development skill's line shapes.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { mirrorLedger } from "./run-log";
import type { WorkflowEndState, WorkflowRuling } from "./types";

export const _ledgerDeps = { appendFile, mkdir };

export function ledgerFilePath(runDir: string): string {
  return join(runDir, "ledger.md");
}

/** One line: newlines and runs of whitespace collapse to single spaces. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export const ledgerText = {
  fixRound: (round: number, max: number, summary: string): string => `fix round ${round}/${max} (${oneLine(summary)})`,
  deferredMinor: (issue: string): string => `deferred-minor: ${oneLine(issue)}`,
  ruling: (r: WorkflowRuling): string => `Ruling: ${oneLine(r.text)} — ${oneLine(r.why)} — ${oneLine(r.costIfWrong)}`,
  end: (state: WorkflowEndState, summary: string): string => `${state} (${oneLine(summary)})`,
  reviewSkipped: (what: string): string => `review-skipped (${oneLine(what)})`,
  note: (text: string): string => oneLine(text),
};

export async function ensureLedger(runDir: string, runId: string, feature: string): Promise<void> {
  const path = ledgerFilePath(runDir);
  if (await Bun.file(path).exists()) return;
  await _ledgerDeps.mkdir(runDir, { recursive: true });
  await Bun.write(path, `# Workflow ledger — run: ${runId} — feature: ${feature}\n`);
}

export interface LedgerWriteOptions {
  /** False when the log already says this fact on a step line, so the log keeps one line per fact. */
  readonly mirror?: boolean;
}

export async function appendLedger(
  runDir: string,
  storyId: string,
  text: string,
  options: LedgerWriteOptions = {},
): Promise<void> {
  await _ledgerDeps.appendFile(ledgerFilePath(runDir), `${storyId}: ${text}\n`);
  // The one mirror point: every workflow ledger write (story, feature, preflight, error path) lands here.
  if (options.mirror !== false) mirrorLedger(storyId, text);
}
