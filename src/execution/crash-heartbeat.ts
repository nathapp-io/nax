/**
 * Heartbeat monitoring — periodic health checks during execution
 */

import { appendFileSync } from "node:fs";
import { getSafeLogger } from "../logger";
import type { StatusWriter } from "./status-writer";

let heartbeatActive = false;

/**
 * Inner loop — runs while heartbeatActive is true.
 * Uses Bun.sleep so each tick fully completes before the next begins,
 * avoiding the tick-overlap issue of setInterval with async callbacks.
 */
async function heartbeatLoop(
  statusWriter: StatusWriter,
  getTotalCost: () => number,
  getIterations: () => number,
  jsonlFilePath?: string,
): Promise<void> {
  const logger = getSafeLogger();

  while (heartbeatActive) {
    await Bun.sleep(60_000);
    if (!heartbeatActive) break;

    try {
      logger?.debug("crash-recovery", "Heartbeat");

      if (jsonlFilePath) {
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
        // appendFileSync: Bun has no built-in async append API (Bun.write overwrites).
        // Synchronous append is acceptable here since this loop ticks every 60s.
        appendFileSync(jsonlFilePath, line);
      }

      await statusWriter.update(getTotalCost(), getIterations(), {
        lastHeartbeat: new Date().toISOString(),
      });
    } catch (err) {
      logger?.warn("crash-recovery", "Failed during heartbeat", { error: (err as Error).message });
    }
  }
}

/**
 * Start heartbeat loop (60s interval)
 */
export function startHeartbeat(
  statusWriter: StatusWriter,
  getTotalCost: () => number,
  getIterations: () => number,
  jsonlFilePath?: string,
): void {
  const logger = getSafeLogger();

  stopHeartbeat();

  heartbeatActive = true;
  heartbeatLoop(statusWriter, getTotalCost, getIterations, jsonlFilePath).catch(() => {});

  logger?.debug("crash-recovery", "Heartbeat started (60s interval)");
}

/**
 * Stop heartbeat loop
 */
export function stopHeartbeat(): void {
  if (heartbeatActive) {
    heartbeatActive = false;
    getSafeLogger()?.debug("crash-recovery", "Heartbeat stopped");
  }
}

/**
 * Returns true if heartbeat loop is currently active.
 * @internal - test use only.
 */
export function _isHeartbeatActive(): boolean {
  return heartbeatActive;
}
