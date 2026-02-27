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
import type { StatusWriter } from "./status-writer";

/**
 * Crash recovery context — dependencies injected at setup
 */
export interface CrashRecoveryContext {
  statusWriter: StatusWriter;
  totalCost: number;
  iterations: number;
  jsonlFilePath?: string;
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
async function writeFatalLog(
  jsonlFilePath: string | undefined,
  signal: string,
  error?: Error,
): Promise<void> {
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
    // Use appendFileSync from node:fs to ensure file is created if it doesn't exist
    const { appendFileSync } = await import("node:fs");
    appendFileSync(jsonlFilePath, line, "utf8");
  } catch (err) {
    console.error("[crash-recovery] Failed to write fatal log:", err);
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
 */
export function installCrashHandlers(ctx: CrashRecoveryContext): void {
  if (handlersInstalled) {
    return; // Prevent duplicate installations
  }

  const logger = getSafeLogger();

  // Signal handler
  const handleSignal = async (signal: NodeJS.Signals) => {
    logger?.error("crash-recovery", `Received ${signal}, shutting down...`, { signal });

    // Write fatal log
    await writeFatalLog(ctx.jsonlFilePath, signal);

    // Update status.json to crashed
    await updateStatusToCrashed(ctx.statusWriter, ctx.totalCost, ctx.iterations, signal);

    // Stop heartbeat
    stopHeartbeat();

    // Exit cleanly
    process.exit(128 + getSignalNumber(signal));
  };

  // Install signal handlers
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGHUP", () => handleSignal("SIGHUP"));

  // Uncaught exception handler
  process.on("uncaughtException", async (error: Error) => {
    logger?.error("crash-recovery", "Uncaught exception", {
      error: error.message,
      stack: error.stack,
    });

    // Write fatal log with stack trace
    await writeFatalLog(ctx.jsonlFilePath, "uncaughtException", error);

    // Update status.json to crashed
    await updateStatusToCrashed(ctx.statusWriter, ctx.totalCost, ctx.iterations, "uncaughtException");

    // Stop heartbeat
    stopHeartbeat();

    // Exit with error code
    process.exit(1);
  });

  // Unhandled promise rejection handler
  process.on("unhandledRejection", async (reason: unknown, promise: Promise<unknown>) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger?.error("crash-recovery", "Unhandled promise rejection", {
      error: error.message,
      stack: error.stack,
    });

    // Write fatal log
    await writeFatalLog(ctx.jsonlFilePath, "unhandledRejection", error);

    // Update status.json to crashed
    await updateStatusToCrashed(ctx.statusWriter, ctx.totalCost, ctx.iterations, "unhandledRejection");

    // Stop heartbeat
    stopHeartbeat();

    // Exit with error code
    process.exit(1);
  });

  handlersInstalled = true;
  logger?.debug("crash-recovery", "Crash handlers installed");
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
        await Bun.write(jsonlFilePath, line, { mode: "a" });
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
    // Use appendFileSync from node:fs to ensure file is created if it doesn't exist
    const { appendFileSync } = await import("node:fs");
    appendFileSync(jsonlFilePath, line, "utf8");
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
