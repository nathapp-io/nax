import { appendFileSync } from "node:fs";
/**
 * Crash Recovery — Signal handlers, heartbeat, and exit summary
 *
 * Implements US-007:
 * - SIGTERM/SIGINT/SIGHUP handlers
 * - Uncaught exception handlers
 * - Fatal log + status.json update to "crashed"
 * - Heartbeat every 60s during agent execution
 * - Exit summary entry on normal exit
 */

import { getSafeLogger } from "../logger";
import type { PidRegistry } from "./pid-registry";
import type { StatusWriter } from "./status-writer";

/**
 * Crash recovery context — dependencies injected at setup
 * (BUG-1 fix: use getters to avoid capturing stale closure values)
 */
export interface CrashRecoveryContext {
  statusWriter: StatusWriter;
  getTotalCost: () => number;
  getIterations: () => number;
  jsonlFilePath?: string;
  pidRegistry?: PidRegistry;
  // BUG-017: Additional context for run.complete event on SIGTERM
  runId?: string;
  feature?: string;
  getStartTime?: () => number;
  getTotalStories?: () => number;
  getStoriesCompleted?: () => number;
}

/**
 * Heartbeat timer handle (for cleanup)
 */
let heartbeatTimer: Timer | null = null;

/**
 * Track whether crash handlers have been installed
 */
let handlersInstalled = false;

/**
 * Write fatal log entry to JSONL file
 */
async function writeFatalLog(jsonlFilePath: string | undefined, signal: string, error?: Error): Promise<void> {
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
    // Use Bun.write with append: true
    appendFileSync(jsonlFilePath, line);
  } catch (err) {
    console.error("[crash-recovery] Failed to write fatal log:", err);
  }
}

/**
 * Write run.complete event to JSONL file (BUG-017)
 * Called on SIGTERM to emit final run summary before exit
 */
async function writeRunComplete(ctx: CrashRecoveryContext, exitReason: string): Promise<void> {
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
    console.error("[crash-recovery] Failed to write run.complete event:", err);
  }
}

/**
 * Update status.json to "crashed" state
 */
async function updateStatusToCrashed(
  statusWriter: StatusWriter,
  totalCost: number,
  iterations: number,
  signal: string,
): Promise<void> {
  try {
    statusWriter.setRunStatus("crashed");
    await statusWriter.update(totalCost, iterations, {
      crashedAt: new Date().toISOString(),
      crashSignal: signal,
    });
  } catch (err) {
    console.error("[crash-recovery] Failed to update status.json:", err);
  }
}

/**
 * Install signal handlers for crash recovery
 * (MEM-1 fix: return cleanup function to unregister handlers)
 */
export function installCrashHandlers(ctx: CrashRecoveryContext): () => void {
  if (handlersInstalled) {
    return () => {}; // Prevent duplicate installations
  }

  const logger = getSafeLogger();

  // Signal handler
  const handleSignal = async (signal: NodeJS.Signals) => {
    // Hard deadline: force exit if any async operation hangs (FIX-H5)
    const hardDeadline = setTimeout(() => {
      process.exit(128 + getSignalNumber(signal));
    }, 10_000);
    if (hardDeadline.unref) hardDeadline.unref();

    logger?.error("crash-recovery", `Received ${signal}, shutting down...`, { signal });

    // Kill all spawned agent processes
    if (ctx.pidRegistry) {
      await ctx.pidRegistry.killAll();
    }

    // Write fatal log
    await writeFatalLog(ctx.jsonlFilePath, signal);

    // Write run.complete event (BUG-017)
    await writeRunComplete(ctx, signal.toLowerCase());

    // Update status.json to crashed
    await updateStatusToCrashed(ctx.statusWriter, ctx.getTotalCost(), ctx.getIterations(), signal);

    // Stop heartbeat
    stopHeartbeat();

    clearTimeout(hardDeadline);
    // Exit cleanly
    process.exit(128 + getSignalNumber(signal));
  };

  const sigtermHandler = () => handleSignal("SIGTERM");
  const sigintHandler = () => handleSignal("SIGINT");
  const sighupHandler = () => handleSignal("SIGHUP");

  // Install signal handlers
  process.on("SIGTERM", sigtermHandler);
  process.on("SIGINT", sigintHandler);
  process.on("SIGHUP", sighupHandler);

  // Uncaught exception handler
  const uncaughtExceptionHandler = async (error: Error) => {
    logger?.error("crash-recovery", "Uncaught exception", {
      error: error.message,
      stack: error.stack,
    });

    // Kill all spawned agent processes
    if (ctx.pidRegistry) {
      await ctx.pidRegistry.killAll();
    }

    // Write fatal log with stack trace
    await writeFatalLog(ctx.jsonlFilePath, "uncaughtException", error);

    // Update status.json to crashed
    await updateStatusToCrashed(ctx.statusWriter, ctx.getTotalCost(), ctx.getIterations(), "uncaughtException");

    // Stop heartbeat
    stopHeartbeat();

    // Exit with error code
    process.exit(1);
  };
  process.on("uncaughtException", uncaughtExceptionHandler);

  // Unhandled promise rejection handler
  const unhandledRejectionHandler = async (reason: unknown, promise: Promise<unknown>) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger?.error("crash-recovery", "Unhandled promise rejection", {
      error: error.message,
      stack: error.stack,
    });

    // Kill all spawned agent processes
    if (ctx.pidRegistry) {
      await ctx.pidRegistry.killAll();
    }

    // Write fatal log
    await writeFatalLog(ctx.jsonlFilePath, "unhandledRejection", error);

    // Update status.json to crashed
    await updateStatusToCrashed(ctx.statusWriter, ctx.getTotalCost(), ctx.getIterations(), "unhandledRejection");

    // Stop heartbeat
    stopHeartbeat();

    // Exit with error code
    process.exit(1);
  };
  process.on("unhandledRejection", unhandledRejectionHandler);

  handlersInstalled = true;
  logger?.debug("crash-recovery", "Crash handlers installed");

  // Return cleanup function
  return () => {
    process.removeListener("SIGTERM", sigtermHandler);
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGHUP", sighupHandler);
    process.removeListener("uncaughtException", uncaughtExceptionHandler);
    process.removeListener("unhandledRejection", unhandledRejectionHandler);
    handlersInstalled = false;
    logger?.debug("crash-recovery", "Crash handlers unregistered");
  };
}

/**
 * Start heartbeat timer (60s interval)
 */
export function startHeartbeat(
  statusWriter: StatusWriter,
  getTotalCost: () => number,
  getIterations: () => number,
  jsonlFilePath?: string,
): void {
  const logger = getSafeLogger();

  // Stop any existing heartbeat first
  stopHeartbeat();

  heartbeatTimer = setInterval(async () => {
    logger?.debug("crash-recovery", "Heartbeat");

    // Write heartbeat to JSONL
    if (jsonlFilePath) {
      try {
        const heartbeatEntry = {
          timestamp: new Date().toISOString(),
          level: "debug",
          stage: "heartbeat",
          message: "Process alive",
          data: {
            pid: process.pid,
            memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          },
        };
        const line = `${JSON.stringify(heartbeatEntry)}\n`;
        appendFileSync(jsonlFilePath, line);
      } catch (err) {
        logger?.warn("crash-recovery", "Failed to write heartbeat", { error: (err as Error).message });
      }
    }

    // Update status.json (no-op if nothing changed, but keeps lastHeartbeat fresh)
    try {
      await statusWriter.update(getTotalCost(), getIterations(), {
        lastHeartbeat: new Date().toISOString(),
      });
    } catch (err) {
      logger?.warn("crash-recovery", "Failed to update status during heartbeat", {
        error: (err as Error).message,
      });
    }
  }, 60_000); // 60 seconds

  logger?.debug("crash-recovery", "Heartbeat started (60s interval)");
}

/**
 * Stop heartbeat timer
 */
export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    getSafeLogger()?.debug("crash-recovery", "Heartbeat stopped");
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
    // Use Bun.write with append: true
    appendFileSync(jsonlFilePath, line);
    logger?.debug("crash-recovery", "Exit summary written");
  } catch (err) {
    logger?.warn("crash-recovery", "Failed to write exit summary", { error: (err as Error).message });
  }
}

/**
 * Get numeric signal number for exit code
 */
function getSignalNumber(signal: NodeJS.Signals): number {
  const signalMap: Record<string, number> = {
    SIGTERM: 15,
    SIGINT: 2,
    SIGHUP: 1,
  };
  return signalMap[signal] ?? 15;
}

/**
 * Reset handlers (for testing)
 * @internal
 */
export function resetCrashHandlers(): void {
  handlersInstalled = false;
  stopHeartbeat();
}
