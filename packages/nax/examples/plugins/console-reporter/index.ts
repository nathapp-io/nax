/**
 * Console Reporter Plugin
 *
 * Sample reporter plugin that demonstrates the plugin API.
 * Prints formatted output to the console for run lifecycle events.
 */

import type {
  NaxPlugin,
  IReporter,
  RunStartEvent,
  StoryCompleteEvent,
  RunEndEvent,
} from "../../../src/plugins/types";

interface ConsoleReporterConfig {
  verbose?: boolean;
}

let verboseMode = false;

/**
 * Console reporter implementation.
 */
const reporter: IReporter = {
  name: "console-reporter",

  async onRunStart(event: RunStartEvent): Promise<void> {
    console.log("\n" + "=".repeat(60));
    console.log(`🚀 Starting Run: ${event.feature}`);
    console.log(`   Run ID: ${event.runId}`);
    console.log(`   Total Stories: ${event.totalStories}`);
    console.log(`   Start Time: ${event.startTime}`);
    console.log("=".repeat(60) + "\n");

    if (verboseMode) {
      console.log("[console-reporter] Verbose mode enabled");
    }
  },

  async onStoryComplete(event: StoryCompleteEvent): Promise<void> {
    const statusIcon = event.status === "completed" ? "✓" : "✗";
    const statusColor = event.status === "completed" ? "\x1b[32m" : "\x1b[31m";
    const resetColor = "\x1b[0m";

    console.log(
      `${statusColor}${statusIcon}${resetColor} ${event.storyId} | ` +
      `Tier: ${event.tier} | ` +
      `Strategy: ${event.testStrategy} | ` +
      `Duration: ${event.durationMs}ms | ` +
      `Cost: $${event.cost.toFixed(4)}`
    );

    if (verboseMode) {
      console.log(`   [verbose] Run ID: ${event.runId}, Status: ${event.status}`);
    }
  },

  async onRunEnd(event: RunEndEvent): Promise<void> {
    console.log("\n" + "=".repeat(60));
    console.log("📊 Run Summary");
    console.log("=".repeat(60));

    const { storySummary } = event;
    const total = storySummary.completed + storySummary.failed + storySummary.skipped + storySummary.paused;

    console.log(`Run ID: ${event.runId}`);
    console.log(`\nStory Results:`);
    console.log(`  ✓ Completed: ${storySummary.completed}/${total}`);
    console.log(`  ✗ Failed:    ${storySummary.failed}/${total}`);
    console.log(`  ⊘ Skipped:   ${storySummary.skipped}/${total}`);
    console.log(`  ⏸ Paused:    ${storySummary.paused}/${total}`);
    console.log(`\nMetrics:`);
    console.log(`  Total Duration: ${(event.totalDurationMs / 1000).toFixed(2)}s`);
    console.log(`  Total Cost:     $${event.totalCost.toFixed(4)}`);
    console.log("=".repeat(60) + "\n");

    if (verboseMode) {
      console.log("[console-reporter] Run completed in verbose mode");
    }
  },
};

/**
 * Console reporter plugin export.
 */
const consoleReporterPlugin: NaxPlugin = {
  name: "console-reporter",
  version: "1.0.0",
  provides: ["reporter"],

  async setup(config: Record<string, unknown>): Promise<void> {
    const reporterConfig = config as ConsoleReporterConfig;
    verboseMode = reporterConfig.verbose ?? false;

    if (verboseMode) {
      console.log("[console-reporter] Plugin initialized with verbose mode enabled");
    }
  },

  async teardown(): Promise<void> {
    // No cleanup needed for console output
  },

  extensions: {
    reporter,
  },
};

export default consoleReporterPlugin;
