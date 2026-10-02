/**
 * Status Feature Details — output sections
 *
 * Extracted from status-features.ts (cognitive-complexity drain, batch B6):
 * each function here prints ONE output section of the single-feature view
 * (`nax status -f <feature>`, US-004 display). `displayFeatureDetails` in
 * status-features.ts stays the sequencer — it loads prd.json/status.json,
 * prints the header, and calls these in the original section order.
 *
 * This module imports nothing from status-features.ts at runtime: every
 * value it needs (loaded PRD, story counts, parsed status file, the CLI
 * feature name) arrives as a parameter, so the dependency edge is strictly
 * status-features.ts -> here. The active/crashed run sections keep the
 * PID-liveness reports' known limitation documented at the top of
 * status-features.ts (PIDs are recycled; a long-dead run's PID can look
 * alive).
 */

import { isProcessAlive as isPidAlive } from "@nathapp/nax-agent/internal";
import chalk from "chalk";
import type {
  AcceptancePhaseStatus,
  NaxStatusFile,
  PostRunStatus,
  RegressionPhaseStatus,
} from "../execution/status-file";
import type { countStories, PRD } from "../prd";

/** Story counts as produced by countStories(prd) */
type StoryCounts = ReturnType<typeof countStories>;

/** Guard arm: the feature directory has no prd.json yet (plan failed or feature just created) */
export function displayNoPrdNotice(featureName: string): void {
  console.log(chalk.bold(`\n📊 ${featureName}\n`));
  console.log(chalk.dim(`No prd.json found. Run: nax plan -f ${featureName} --from <spec>`));
}

/**
 * Run status section: active run banner, crashed-run banner + recovery
 * hints, or the "no active run" note when status.json is absent.
 */
export function displayRunStatusSection(status: NaxStatusFile | null, featureName: string): void {
  if (status) {
    const pidAlive = isPidAlive(status.run.pid);

    if (status.run.status === "running" && pidAlive) {
      console.log(chalk.yellow("⚡ Active Run:"));
      console.log(chalk.dim(`   Run ID:     ${status.run.id}`));
      console.log(chalk.dim(`   PID:        ${status.run.pid}`));
      console.log(chalk.dim(`   Started:    ${status.run.startedAt}`));
      console.log(chalk.dim(`   Progress:   ${status.progress.passed}/${status.progress.total} stories`));
      console.log(chalk.dim(`   Cost:       $${status.cost.spent.toFixed(4)}`));

      if (status.current) {
        console.log(chalk.dim(`   Current:    ${status.current.storyId} - ${status.current.title}`));
      }

      console.log();
    } else if ((status.run.status === "running" && !pidAlive) || status.run.status === "crashed") {
      console.log(chalk.red("💥 Crashed Run Detected:\n"));
      console.log(chalk.dim(`   Run ID:     ${status.run.id}`));
      console.log(chalk.dim(`   PID:        ${status.run.pid} (dead)`));
      console.log(chalk.dim(`   Started:    ${status.run.startedAt}`));
      if (status.run.crashedAt) {
        console.log(chalk.dim(`   Crashed:    ${status.run.crashedAt}`));
      }
      if (status.run.crashSignal) {
        console.log(chalk.dim(`   Signal:     ${status.run.crashSignal}`));
      }
      console.log(chalk.dim(`   Progress:   ${status.progress.passed}/${status.progress.total} stories (at crash)`));
      console.log();
      console.log(chalk.yellow("💡 Recovery Hints:"));
      console.log(chalk.dim("   • Check the latest run log in runs/ directory"));
      console.log(chalk.dim("   • Review status.json for last known state"));
      console.log(chalk.dim(`   • Re-run with: nax run -f ${featureName}`));
      console.log();
    }
  } else {
    console.log(chalk.dim("No active run (status.json not found)\n"));
  }
}

/** Story counts section: branch, freshness, and the per-status tally */
export function displayProgressSection(prd: PRD, counts: StoryCounts): void {
  console.log(chalk.bold("Progress:"));
  console.log(chalk.dim(`   Branch:     ${prd.branchName}`));
  console.log(chalk.dim(`   Updated:    ${prd.updatedAt}`));
  console.log(chalk.dim(`   Total:      ${counts.total}`));
  console.log(chalk.green(`   Passed:     ${counts.passed}`));
  console.log(chalk.red(`   Failed:     ${counts.failed}`));
  console.log(chalk.dim(`   Pending:    ${counts.pending}`));
  if (counts.skipped > 0) {
    console.log(chalk.yellow(`   Skipped:    ${counts.skipped}`));
  }
  console.log();
}

/** Story table section: one line per story with a status icon and, if routed, the routing suffix */
export function displayStoriesSection(prd: PRD): void {
  console.log(chalk.bold("Stories:\n"));
  for (const story of prd.userStories) {
    const icon = story.passes ? "✅" : story.status === "failed" ? "❌" : story.status === "skipped" ? "⏭️" : "⬜";
    const routing = story.routing
      ? chalk.dim(` [${story.routing.complexity}/${story.routing.modelTier}/${story.routing.testStrategy}]`)
      : "";
    console.log(`   ${icon} ${story.id}: ${story.title}${routing}`);
  }

  console.log();
}

/** Post-run section: acceptance + regression phase statuses from status.postRun */
export function displayPostRunSection(postRun: PostRunStatus): void {
  console.log(chalk.bold("Post-Run Status:\n"));

  displayAcceptanceStatus(postRun.acceptance);
  displayRegressionStatus(postRun.regression);

  console.log();
}

/** Acceptance phase line (US-004) */
function displayAcceptanceStatus(acceptance: AcceptancePhaseStatus): void {
  // Display acceptance phase status
  if (acceptance.status === "passed") {
    const timestamp = acceptance.lastRunAt ? ` (${acceptance.lastRunAt})` : "";
    console.log(chalk.green(`   Acceptance: passed${timestamp}`));
  } else if (acceptance.status === "failed") {
    const failedInfo =
      acceptance.failedACs && acceptance.failedACs.length > 0 ? ` (${acceptance.failedACs.length} AC(s))` : "";
    console.log(chalk.red(`   Acceptance: failed${failedInfo}`));
  } else if (acceptance.status === "running") {
    console.log(chalk.yellow("   Acceptance: running"));
  } else {
    console.log(chalk.dim("   Acceptance: not-run"));
  }
}

/** Regression phase line (US-004). The failed arm's timestamp is space-separated — no parens. */
function displayRegressionStatus(regression: RegressionPhaseStatus): void {
  // Display regression phase status
  if (regression.status === "passed" && regression.skipped) {
    console.log(chalk.yellow("   Regression: skipped (smart-skip)"));
  } else if (regression.status === "passed") {
    const timestamp = regression.lastRunAt ? ` (${regression.lastRunAt})` : "";
    console.log(chalk.green(`   Regression: passed${timestamp}`));
  } else if (regression.status === "failed") {
    const ft = regression.failedTests as string[] | number | undefined;
    const failedCount = Array.isArray(ft) ? ft.length : typeof ft === "number" ? ft : 0;
    const failedInfo = failedCount > 0 ? ` (${failedCount} test(s))` : "";
    const timestamp = regression.lastRunAt ? ` ${regression.lastRunAt}` : "";
    console.log(chalk.red(`   Regression: failed${failedInfo}${timestamp}`));
  } else if (regression.status === "running") {
    console.log(chalk.yellow("   Regression: running"));
  } else {
    console.log(chalk.dim("   Regression: not-run"));
  }
}

/** Trailing last-run block: printed when a run exists and is not running */
export function displayLastRunSection(status: NaxStatusFile): void {
  console.log(chalk.dim(`Last run: ${status.run.id}`));
  console.log(chalk.dim(`Cost: $${status.cost.spent.toFixed(4)}`));
  console.log();
}
