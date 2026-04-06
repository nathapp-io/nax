/**
 * Crash data serialization — write logs and event summaries
 */

import { appendFileSync } from "node:fs";
import { getSafeLogger } from "../logger";
import type { StatusWriter } from "./status-writer";

/**
 * Write fatal log entry to JSONL file
 */
export async function writeFatalLog(jsonlFilePath: string | undefined, signal: string, error?: Error): Promise<void> {
  if (!jsonlFilePath) return;

  try {
    const fatalEntry = {
      timestamp: new Date().toISOString(),
      level: "error",
      stage: "crash-recovery",
      message: error ? `Uncaught exception: ${error.message}` : `Process terminated by ${signal}`,
      data: {
        signal,
        ...(error && {
          stack: error.stack,
          name: error.name,
        }),
      },
    };

    const line = `${JSON.stringify(fatalEntry)}\n`;
    appendFileSync(jsonlFilePath, line);
  } catch (err) {
    process.stderr.write(`[crash-recovery] Failed to write fatal log: ${String(err)}\n`);
  }
}

/**
 * Write run.complete event to JSONL file
 * Called on SIGTERM to emit final run summary before exit
 */
export interface RunCompleteContext {
  jsonlFilePath?: string;
  runId?: string;
  feature?: string;
  getTotalCost: () => number;
  getIterations: () => number;
  getStartTime?: () => number;
  getTotalStories?: () => number;
  getStoriesCompleted?: () => number;
}

export async function writeRunComplete(ctx: RunCompleteContext, exitReason: string): Promise<void> {
  if (!ctx.jsonlFilePath || !ctx.runId || !ctx.feature) return;

  const logger = getSafeLogger();

  try {
    const totalCost = ctx.getTotalCost();
    const iterations = ctx.getIterations();
    const startTime = ctx.getStartTime?.() ?? Date.now();
    const durationMs = Date.now() - startTime;
    const totalStories = ctx.getTotalStories?.() ?? 0;
    const storiesCompleted = ctx.getStoriesCompleted?.() ?? 0;

    const runCompleteEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      stage: "run.complete",
      message: "Feature execution terminated",
      data: {
        runId: ctx.runId,
        feature: ctx.feature,
        success: false,
        exitReason,
        totalCost,
        iterations,
        totalStories,
        storiesCompleted,
        durationMs,
      },
    };

    const line = `${JSON.stringify(runCompleteEntry)}\n`;
    appendFileSync(ctx.jsonlFilePath, line);
    logger?.debug("crash-recovery", "run.complete event written", { exitReason });
  } catch (err) {
    process.stderr.write(`[crash-recovery] Failed to write run.complete event: ${String(err)}\n`);
  }
}

/**
 * Update status.json to "crashed" state (both project-level and feature-level)
 */
export async function updateStatusToCrashed(
  statusWriter: StatusWriter,
  totalCost: number,
  iterations: number,
  signal: string,
  featureDir?: string,
): Promise<void> {
  try {
    statusWriter.setRunStatus("crashed");
    await statusWriter.update(totalCost, iterations, {
      crashedAt: new Date().toISOString(),
      crashSignal: signal,
    });

    if (featureDir) {
      await statusWriter.writeFeatureStatus(featureDir, totalCost, iterations, {
        crashedAt: new Date().toISOString(),
        crashSignal: signal,
      });
    }
  } catch (err) {
    process.stderr.write(`[crash-recovery] Failed to update status.json: ${String(err)}\n`);
  }
}

/**
 * Write exit summary entry to JSONL
 */
export async function writeExitSummary(
  jsonlFilePath: string | undefined,
  totalCost: number,
  iterations: number,
  storiesCompleted: number,
  durationMs: number,
): Promise<void> {
  if (!jsonlFilePath) return;

  const logger = getSafeLogger();

  try {
    const summaryEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      stage: "exit-summary",
      message: "Run completed",
      data: {
        totalCost,
        iterations,
        storiesCompleted,
        durationMs,
        exitedCleanly: true,
      },
    };

    const line = `${JSON.stringify(summaryEntry)}\n`;
    appendFileSync(jsonlFilePath, line);
    logger?.debug("crash-recovery", "Exit summary written");
  } catch (err) {
    logger?.warn("crash-recovery", "Failed to write exit summary", { error: (err as Error).message });
  }
}
