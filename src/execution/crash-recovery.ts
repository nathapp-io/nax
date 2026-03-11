/**
 * Crash Recovery Orchestrator
 *
 * Implements US-007:
 * - SIGTERM/SIGINT/SIGHUP handlers
 * - Uncaught exception handlers
 * - Fatal log + status.json update to "crashed"
 * - Heartbeat every 60s during agent execution
 * - Exit summary entry on normal exit
 *
 * Re-exports crash detection and writer modules.
 */

import { stopHeartbeat } from "./crash-heartbeat";
import { installSignalHandlers } from "./crash-signals";
import type { PidRegistry } from "./pid-registry";
import type { StatusWriter } from "./status-writer";

// Re-export for backward compatibility
export {
  type RunCompleteContext,
  updateStatusToCrashed,
  writeFatalLog,
  writeRunComplete,
  writeExitSummary,
} from "./crash-writer";

export { type SignalHandlerContext, installSignalHandlers } from "./crash-signals";

export { startHeartbeat, stopHeartbeat, _isHeartbeatActive } from "./crash-heartbeat";

/**
 * Crash recovery context — dependencies injected at setup
 */
export interface CrashRecoveryContext {
  statusWriter: StatusWriter;
  getTotalCost: () => number;
  getIterations: () => number;
  jsonlFilePath?: string;
  pidRegistry?: PidRegistry;
  runId?: string;
  feature?: string;
  featureDir?: string;
  getStartTime?: () => number;
  getTotalStories?: () => number;
  getStoriesCompleted?: () => number;
  emitError?: (reason: string) => void;
}

let handlersInstalled = false;

/**
 * Install crash handlers for recovery
 */
export function installCrashHandlers(ctx: CrashRecoveryContext): () => void {
  if (handlersInstalled) {
    return () => {};
  }

  const cleanup = installSignalHandlers(ctx);
  handlersInstalled = true;

  return () => {
    cleanup();
    stopHeartbeat();
    handlersInstalled = false;
  };
}

/**
 * Reset handlers (for testing)
 * @internal
 */
export function resetCrashHandlers(): void {
  handlersInstalled = false;
  stopHeartbeat();
}
