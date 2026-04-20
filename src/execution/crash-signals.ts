/**
 * Crash detection — Signal and exception handlers
 *
 * Idempotency contract (fix for v0.63.0-canary.8 Issue 5):
 *   The first fatal signal/exception wins. Subsequent signals log once and
 *   no-op until the process exits. Without this, a cascading SIGINT → SIGTERM
 *   → SIGHUP sequence (common when Ctrl+C is hit in a terminal that then
 *   hangs the child) would run the full shutdown path once per signal,
 *   writing duplicate `run.complete` events, killing PIDs repeatedly, and
 *   racing against in-flight ACP retry loops that spawn new processes mid
 *   shutdown.
 *
 * AbortController contract:
 *   On first signal the handler aborts `ctx.abortController` (if present) so
 *   long-running awaits in onShutdown/agent.run can bail instead of spawning
 *   new work during teardown.
 */

import { getSafeLogger } from "../logger";
import { type RunCompleteContext, updateStatusToCrashed, writeFatalLog, writeRunComplete } from "./crash-writer";
import type { PidRegistry } from "./pid-registry";
import type { StatusWriter } from "./status-writer";

/**
 * Handler context for signal/exception management
 */
export interface SignalHandlerContext extends RunCompleteContext {
  statusWriter: StatusWriter;
  pidRegistry?: PidRegistry;
  featureDir?: string;
  emitError?: (reason: string) => void;
  /**
   * Shared abort controller. The signal handler calls `.abort()` on the first
   * fatal signal; consumers (onShutdown, in-flight agent.run) can observe
   * `.signal.aborted` to stop issuing new work. Caller owns creation.
   */
  abortController?: AbortController;
  /**
   * Called during graceful shutdown (signal/exception) before process.exit —
   * use to close ACP sessions, flush buffers, etc. The abort signal is passed
   * through so long-running awaits can short-circuit.
   */
  onShutdown?: (abortSignal?: AbortSignal) => Promise<void>;
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
 * Create signal handler.
 *
 * Returns a per-install handler that is idempotent: once a shutdown path has
 * started, subsequent signals log and no-op.
 */
function createSignalHandler(
  ctx: SignalHandlerContext,
  state: { shuttingDown: boolean },
): (signal: NodeJS.Signals) => Promise<void> {
  return async (signal: NodeJS.Signals) => {
    const logger = getSafeLogger();

    if (state.shuttingDown) {
      logger?.warn("crash-recovery", `${signal} ignored — shutdown already in progress`, { signal });
      return;
    }
    state.shuttingDown = true;

    const hardDeadline = setTimeout(() => {
      process.exit(128 + getSignalNumber(signal));
    }, 10_000);
    if (hardDeadline.unref) hardDeadline.unref();

    logger?.error("crash-recovery", `Received ${signal}, shutting down...`, { signal });

    // Abort in-flight awaits so onShutdown / agent.run can bail fast.
    ctx.abortController?.abort();

    // Freeze the PID registry so retry paths cannot register new processes
    // during teardown.
    ctx.pidRegistry?.freeze?.();

    // Close ACP sessions gracefully first (spawns are tracked by pidRegistry)
    if (ctx.onShutdown) {
      await ctx.onShutdown(ctx.abortController?.signal).catch(() => {});
    }

    // Kill any remaining processes (including hung session-close spawns)
    if (ctx.pidRegistry) {
      await ctx.pidRegistry.killAll();
    }

    ctx.emitError?.(signal.toLowerCase());

    await writeFatalLog(ctx.jsonlFilePath, signal);
    await writeRunComplete(ctx, signal.toLowerCase());
    await updateStatusToCrashed(ctx.statusWriter, ctx.getTotalCost(), ctx.getIterations(), signal, ctx.featureDir);

    clearTimeout(hardDeadline);
    process.exit(128 + getSignalNumber(signal));
  };
}

/**
 * Create uncaught exception handler.
 *
 * Shares the idempotency flag with signal handlers so an uncaughtException
 * that follows (or precedes) a signal does not re-run the shutdown path.
 */
function createUncaughtExceptionHandler(
  ctx: SignalHandlerContext,
  state: { shuttingDown: boolean },
): (error: Error) => Promise<void> {
  return async (error: Error) => {
    process.stderr.write(`\n[nax crash] Uncaught exception: ${error.message}\n${error.stack ?? ""}\n`);
    const logger = getSafeLogger();

    if (state.shuttingDown) {
      logger?.warn("crash-recovery", "Uncaught exception during shutdown — ignored", { error: error.message });
      return;
    }
    state.shuttingDown = true;

    logger?.error("crash-recovery", "Uncaught exception", {
      error: error.message,
      stack: error.stack,
    });

    ctx.abortController?.abort();
    ctx.pidRegistry?.freeze?.();

    if (ctx.onShutdown) {
      await ctx.onShutdown(ctx.abortController?.signal).catch(() => {});
    }

    if (ctx.pidRegistry) {
      await ctx.pidRegistry.killAll();
    }

    ctx.emitError?.("uncaughtException");
    await writeFatalLog(ctx.jsonlFilePath, "uncaughtException", error);
    await updateStatusToCrashed(
      ctx.statusWriter,
      ctx.getTotalCost(),
      ctx.getIterations(),
      "uncaughtException",
      ctx.featureDir,
    );

    process.exit(1);
  };
}

/**
 * Create unhandled promise rejection handler.
 *
 * Shares the idempotency flag with signal handlers.
 */
function createUnhandledRejectionHandler(
  ctx: SignalHandlerContext,
  state: { shuttingDown: boolean },
): (reason: unknown) => Promise<void> {
  return async (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    process.stderr.write(`\n[nax crash] Unhandled rejection: ${error.message}\n${error.stack ?? ""}\n`);
    const logger = getSafeLogger();

    if (state.shuttingDown) {
      logger?.warn("crash-recovery", "Unhandled rejection during shutdown — ignored", { error: error.message });
      return;
    }
    state.shuttingDown = true;

    logger?.error("crash-recovery", "Unhandled promise rejection", {
      error: error.message,
      stack: error.stack,
    });

    ctx.abortController?.abort();
    ctx.pidRegistry?.freeze?.();

    if (ctx.onShutdown) {
      await ctx.onShutdown(ctx.abortController?.signal).catch(() => {});
    }

    if (ctx.pidRegistry) {
      await ctx.pidRegistry.killAll();
    }

    ctx.emitError?.("unhandledRejection");
    await writeFatalLog(ctx.jsonlFilePath, "unhandledRejection", error);
    await updateStatusToCrashed(
      ctx.statusWriter,
      ctx.getTotalCost(),
      ctx.getIterations(),
      "unhandledRejection",
      ctx.featureDir,
    );

    process.exit(1);
  };
}

/**
 * Install signal and exception handlers, return cleanup function.
 *
 * All fatal handlers share a single `shuttingDown` flag: the first one to
 * fire runs the full teardown path, subsequent ones log and no-op. This
 * prevents duplicate `run.complete` events and race-registered PIDs when a
 * cascade of signals (SIGINT → SIGTERM → SIGHUP) arrives during shutdown.
 */
export function installSignalHandlers(ctx: SignalHandlerContext): () => void {
  const logger = getSafeLogger();
  const state = { shuttingDown: false };

  const signalHandler = createSignalHandler(ctx, state);
  const uncaughtExceptionHandler = createUncaughtExceptionHandler(ctx, state);
  const unhandledRejectionHandler = createUnhandledRejectionHandler(ctx, state);

  const sigtermHandler = () => signalHandler("SIGTERM");
  const sigintHandler = () => signalHandler("SIGINT");
  const sighupHandler = () => signalHandler("SIGHUP");
  // SIGPIPE: Bun (unlike Node.js) does not set SIG_IGN for SIGPIPE at startup.
  // Writing to a broken pipe — e.g. acpx exits before nax writes its stdin —
  // would otherwise kill nax silently before any crash handler runs.
  const sigpipeHandler = () => {
    getSafeLogger()?.warn("crash-recovery", "Received SIGPIPE (subprocess exited before stdin write — suppressed)");
  };

  process.on("SIGTERM", sigtermHandler);
  process.on("SIGINT", sigintHandler);
  process.on("SIGHUP", sighupHandler);
  process.on("SIGPIPE", sigpipeHandler);
  process.on("uncaughtException", uncaughtExceptionHandler);
  const rejectionWrapper = (reason: unknown) => unhandledRejectionHandler(reason);
  process.on("unhandledRejection", rejectionWrapper);

  logger?.debug("crash-recovery", "Signal handlers installed");

  return () => {
    process.removeListener("SIGTERM", sigtermHandler);
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGHUP", sighupHandler);
    process.removeListener("SIGPIPE", sigpipeHandler);
    process.removeListener("uncaughtException", uncaughtExceptionHandler);
    process.removeListener("unhandledRejection", rejectionWrapper);
    logger?.debug("crash-recovery", "Signal handlers unregistered");
  };
}
