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
  /**
   * Shared abort controller (Issue 5). Signal handler calls `.abort()` on the
   * first fatal signal so in-flight agent.run and onShutdown awaits can bail.
   */
  abortController?: AbortController;
  /**
   * Called during graceful shutdown before process.exit — use to close ACP
   * sessions etc. Receives the abort signal so long-running awaits can short
   * circuit.
   */
  onShutdown?: (abortSignal?: AbortSignal) => Promise<void>;
}

// Stores the active cleanup function so a second installCrashHandlers() call
// can deregister the stale handlers before installing the new context's handlers,
// rather than returning a silent no-op that leaves the old context registered.
let activeCleanup: (() => void) | null = null;

/**
 * Install crash handlers for recovery
 */
export function installCrashHandlers(ctx: CrashRecoveryContext): () => void {
  // Deregister any previous handlers so the new context replaces stale ones
  // (guards against a prior run's cleanup never being called due to a crash).
  if (activeCleanup) {
    activeCleanup();
  }

  const cleanup = installSignalHandlers(ctx);

  activeCleanup = () => {
    cleanup();
    stopHeartbeat();
    activeCleanup = null;
  };

  return activeCleanup;
}

/**
 * Reset handlers (for testing)
 * @internal
 */
export function resetCrashHandlers(): void {
  activeCleanup = null;
  stopHeartbeat();
}
