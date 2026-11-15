import type { QualityCommandResult } from "./runner";

/**
 * Fold per-step results into one. Every step's output is included — including
 * the steps that passed — because the caller ran the whole list precisely so
 * that one read shows the full picture (nax#1990).
 *
 * Interruption evidence rides independently of the aggregate's historical
 * carriers (US-006): `stopReason` is the FIRST detector reason in command order,
 * absent when no entry was stopped, and its presence — not `success`,
 * `exitCode` or `timedOut` — is what says "a detector ended this entry". A list
 * keeps the first non-zero step's exit code even when a later step was
 * interrupted, because a prior ordinary failure must not hide the interruption
 * and the interruption must not hide the failure.
 */
export function aggregateResults(commandName: string, results: QualityCommandResult[]): QualityCommandResult {
  const firstFailure = results.find((r) => r.exitCode !== 0);
  const stopReason = results.find((r) => r.stopReason !== undefined)?.stopReason;
  return {
    commandName,
    command: results.map((r) => r.command).join(" && "),
    success: results.every((r) => r.success),
    exitCode: firstFailure?.exitCode ?? 0,
    output: results.map((r) => `\n=== ${r.command} (exit ${r.exitCode}) ===\n${r.output}`).join(""),
    durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
    timedOut: results.some((r) => r.timedOut),
    // Absent, not undefined, when nothing was stopped — the same contract a
    // single command keeps.
    ...(stopReason === undefined ? {} : { stopReason }),
  };
}
