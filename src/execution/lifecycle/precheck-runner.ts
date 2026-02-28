/**
 * Precheck Runner
 *
 * Handles precheck validation execution before the main run starts.
 * Validates project state, dependencies, and configuration.
 * Blocks execution on Tier 1 failures, warns on Tier 2 failures.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import type { NaxConfig } from "../../config";
import { getSafeLogger } from "../../logger";
import type { PRD } from "../../prd/types";
import type { StatusWriter } from "../status-writer";

export interface PrecheckContext {
  config: NaxConfig;
  prd: PRD;
  workdir: string;
  logFilePath?: string;
  statusWriter: StatusWriter;
  headless: boolean;
  formatterMode: "quiet" | "normal" | "verbose" | "json";
}

/**
 * Run precheck validations before execution starts
 *
 * @throws Error if precheck blockers are found (Tier 1 failures)
 */
export async function runPrecheckValidation(ctx: PrecheckContext): Promise<void> {
  const logger = getSafeLogger();
  logger?.info("precheck", "Running precheck validations...");

  const { runPrecheck } = await import("../../precheck");
  const precheckResult = await runPrecheck(ctx.config, ctx.prd, {
    workdir: ctx.workdir,
    format: "human",
  });

  // Log precheck results to JSONL
  if (ctx.logFilePath) {
    // Ensure directory exists
    mkdirSync(path.dirname(ctx.logFilePath), { recursive: true });

    const precheckLog = {
      type: "precheck",
      timestamp: new Date().toISOString(),
      passed: precheckResult.output.passed,
      blockers: precheckResult.output.blockers.map((b) => ({ name: b.name, message: b.message })),
      warnings: precheckResult.output.warnings.map((w) => ({ name: w.name, message: w.message })),
      summary: precheckResult.output.summary,
    };
    appendFileSync(ctx.logFilePath, `${JSON.stringify(precheckLog)}\n`, "utf8");
  }

  // Handle blockers (Tier 1 failures)
  if (!precheckResult.output.passed) {
    logger?.error("precheck", "Precheck failed - execution blocked", {
      blockers: precheckResult.output.blockers.length,
      failedChecks: precheckResult.output.blockers.map((b) => b.name),
    });

    // Update status file with precheck-failed status
    ctx.statusWriter.setRunStatus("precheck-failed");
    ctx.statusWriter.setCurrentStory(null);
    await ctx.statusWriter.update(0, 0);

    // Log detailed error message to console
    console.error("");
    console.error(chalk.red("❌ PRECHECK FAILED"));
    console.error(chalk.red("─".repeat(60)));
    for (const blocker of precheckResult.output.blockers) {
      console.error(chalk.red(`✗ ${blocker.name}: ${blocker.message}`));
    }
    console.error(chalk.red("─".repeat(60)));
    console.error(chalk.yellow("\nRun 'nax precheck' for detailed information"));
    console.error(chalk.dim("Use --skip-precheck to bypass (not recommended)\n"));

    throw new Error(`Precheck failed: ${precheckResult.output.blockers.map((b) => b.name).join(", ")}`);
  }

  // Handle warnings (Tier 2 failures) - log but continue
  if (precheckResult.output.warnings.length > 0) {
    logger?.warn("precheck", "Precheck passed with warnings", {
      warnings: precheckResult.output.warnings.length,
      issues: precheckResult.output.warnings.map((w) => w.name),
    });

    if (ctx.headless && ctx.formatterMode !== "json") {
      console.log(chalk.yellow("\n⚠️  Precheck warnings:"));
      for (const warning of precheckResult.output.warnings) {
        console.log(chalk.yellow(`  ⚠ ${warning.name}: ${warning.message}`));
      }
      console.log("");
    }
  } else {
    logger?.info("precheck", "All precheck validations passed");
  }
}
