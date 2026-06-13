/**
 * Heartbeat monitoring — periodic health checks during execution
 */

import { appendFileSync } from "node:fs";
import { getSafeLogger } from "../logger";
import type { StatusWriter } from "./status-writer";

/** @internal — test use only */
export const _heartbeatDeps = {
  sleep: async (ms: number) => Bun.sleep(ms),
  getSafeLogger,
};

// Generation counter: each startHeartbeat() increments this, invalidating any
// in-flight loop on its next tick — prevents duplicate loops when startHeartbeat()
// is called again while a prior loop is mid-sleep.
let _heartbeatGen = 0;
let _heartbeatActive = false;

/**
 * Inner loop — runs while both the generation token matches and active flag is set.
 * Uses Bun.sleep so each tick fully completes before the next begins,
 * avoiding the tick-overlap issue of setInterval with async callbacks.
 */
async function heartbeatLoop(
  gen: number,
  statusWriter: StatusWriter,
  getTotalCost: () => number,
  getIterations: () => number,
  jsonlFilePath?: string,
): Promise<void> {
  const logger = _heartbeatDeps.getSafeLogger();

  while (gen === _heartbeatGen && _heartbeatActive) {
    await _heartbeatDeps.sleep(60_000);
    if (gen !== _heartbeatGen || !_heartbeatActive) break;

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
  const logger = _heartbeatDeps.getSafeLogger();

  // Increment generation to invalidate any in-flight loop, then launch a fresh one.
  _heartbeatActive = true;
  const gen = ++_heartbeatGen;
  heartbeatLoop(gen, statusWriter, getTotalCost, getIterations, jsonlFilePath).catch((err: unknown) => {
    _heartbeatDeps.getSafeLogger()?.warn("crash-recovery", "Heartbeat loop crashed; status updates stopped", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  logger?.debug("crash-recovery", "Heartbeat started (60s interval)");
}

/**
 * Stop heartbeat loop
 */
export function stopHeartbeat(): void {
  if (_heartbeatActive) {
    _heartbeatActive = false;
    _heartbeatGen++; // invalidate the running loop on its next tick
    getSafeLogger()?.debug("crash-recovery", "Heartbeat stopped");
  }
}

/**
 * Returns true if heartbeat loop is currently active.
 * @internal - test use only.
 */
export function _isHeartbeatActive(): boolean {
  return _heartbeatActive;
}
