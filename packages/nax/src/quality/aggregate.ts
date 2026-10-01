import type { QualityCommandResult } from "./runner";

/**
 * Fold per-step results into one. Every step's output is included — including
 * the steps that passed — because the caller ran the whole list precisely so
 * that one read shows the full picture (nax#1990).
 */
export function aggregateResults(commandName: string, results: QualityCommandResult[]): QualityCommandResult {
  const firstFailure = results.find((r) => r.exitCode !== 0);
  return {
    commandName,
    command: results.map((r) => r.command).join(" && "),
    success: results.every((r) => r.success),
    exitCode: firstFailure?.exitCode ?? 0,
    output: results.map((r) => `\n=== ${r.command} (exit ${r.exitCode}) ===\n${r.output}`).join(""),
    durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
    timedOut: results.some((r) => r.timedOut),
  };
}
