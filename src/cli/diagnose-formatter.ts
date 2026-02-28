/**
 * Diagnose Report Formatter
 *
 * Extracted from diagnose.ts: human-readable output formatting for the diagnosis report.
 */

import chalk from "chalk";
import type { DiagnosisReport } from "./diagnose";

/** Format diagnosis report as human-readable text */
export function formatReport(report: DiagnosisReport, verbose: boolean): string {
  const lines: string[] = [];

  lines.push(chalk.bold(`\nDiagnosis Report: ${report.runSummary.feature}\n`));

  if (!report.dataSources.eventsFound) {
    lines.push(chalk.yellow("[WARN] events.jsonl not found -- diagnosis limited to PRD + git log\n"));
  }

  // Run Summary
  lines.push(chalk.bold("Run Summary\n"));
  if (report.runSummary.lastRunTime) {
    lines.push(chalk.dim(`   Last Run:    ${report.runSummary.lastRunTime}`));
  }
  lines.push(chalk.dim(`   Status:      ${report.runSummary.status}`));
  lines.push(chalk.green(`   Passed:      ${report.runSummary.storiesPassed}`));
  lines.push(chalk.red(`   Failed:      ${report.runSummary.storiesFailed}`));
  lines.push(chalk.dim(`   Pending:     ${report.runSummary.storiesPending}`));
  if (report.runSummary.cost !== undefined) {
    lines.push(chalk.dim(`   Cost:        $${report.runSummary.cost.toFixed(4)}`));
  }
  lines.push(chalk.dim(`   Commits:     ${report.runSummary.commitsProduced}`));
  lines.push("");

  // Story Breakdown (verbose only)
  if (verbose && report.storyBreakdown.length > 0) {
    lines.push(chalk.bold("Story Breakdown\n"));
    for (const story of report.storyBreakdown) {
      const icon = story.status === "passed" ? "[OK]" : story.status === "failed" ? "[FAIL]" : "[ ]";
      const pattern = story.pattern !== "UNKNOWN" ? chalk.yellow(` [${story.pattern}]`) : "";
      lines.push(`   ${icon} ${story.storyId}: ${story.title}${pattern}`);
      if (verbose && story.tier) {
        lines.push(chalk.dim(`      Tier: ${story.tier}, Strategy: ${story.strategy}, Attempts: ${story.attempts}`));
      }
    }
    lines.push("");
  }

  // Failure Analysis
  if (report.failureAnalysis.length > 0) {
    lines.push(chalk.bold("Failure Analysis\n"));
    for (const failure of report.failureAnalysis) {
      const level = failure.pattern === "AUTO_RECOVERED" ? chalk.green("INFO") : chalk.red("ERROR");
      lines.push(`   ${level} ${failure.storyId}: ${failure.title}`);
      lines.push(chalk.dim(`      Pattern:     ${failure.pattern}`));
      if (failure.symptom) {
        lines.push(chalk.dim(`      Symptom:     ${failure.symptom}`));
      }
      if (failure.fixSuggestion) {
        lines.push(chalk.yellow(`      Fix:         ${failure.fixSuggestion}`));
      }
      lines.push("");
    }
  }

  // Lock Check
  lines.push(chalk.bold("Lock Check\n"));
  if (!report.lockCheck.lockPresent) {
    lines.push(chalk.dim("   No lock file present\n"));
  } else if (report.lockCheck.pidAlive === false) {
    lines.push(chalk.red(`   [FAIL] Stale lock detected (PID ${report.lockCheck.pid} is dead)`));
    lines.push(chalk.yellow(`   Fix: ${report.lockCheck.fixCommand}\n`));
  } else {
    lines.push(chalk.green(`   [OK] Active lock (PID ${report.lockCheck.pid})\n`));
  }

  // Recommendations
  if (report.recommendations.length > 0) {
    lines.push(chalk.bold("Recommendations\n"));
    for (let i = 0; i < report.recommendations.length; i++) {
      lines.push(`   ${i + 1}. ${report.recommendations[i]}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
