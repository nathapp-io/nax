/**
 * Heartbeat monitoring — periodic health checks during execution
 */

import { appendFileSync } from "node:fs";
import { getSafeLogger } from "../logger";
import type { StatusWriter } from "./status-writer";

let heartbeatTimer: Timer | null = null;

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

  stopHeartbeat();

  heartbeatTimer = setInterval(() => {
    (async () => {
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
          appendFileSync(jsonlFilePath, line);
        }

        await statusWriter.update(getTotalCost(), getIterations(), {
          lastHeartbeat: new Date().toISOString(),
        });
      } catch (err) {
        logger?.warn("crash-recovery", "Failed during heartbeat", { error: (err as Error).message });
      }
    })().catch(() => {});
  }, 60_000);

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
 * Returns true if heartbeat timer is currently active.
 * @internal - test use only.
 */
export function _isHeartbeatActive(): boolean {
  return heartbeatTimer !== null;
}
