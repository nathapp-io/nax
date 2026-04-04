/**
 * Crash detection — Signal and exception handlers
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
  /** Called during graceful shutdown (signal/exception) before process.exit — use to close ACP sessions etc. */
  onShutdown?: () => Promise<void>;
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
 * Create signal handler
 */
function createSignalHandler(ctx: SignalHandlerContext): (signal: NodeJS.Signals) => Promise<void> {
  return async (signal: NodeJS.Signals) => {
    const hardDeadline = setTimeout(() => {
      process.exit(128 + getSignalNumber(signal));
    }, 10_000);
    if (hardDeadline.unref) hardDeadline.unref();

    const logger = getSafeLogger();
    logger?.error("crash-recovery", `Received ${signal}, shutting down...`, { signal });

    // Close ACP sessions gracefully first (spawns are tracked by pidRegistry)
    if (ctx.onShutdown) {
      await ctx.onShutdown().catch(() => {});
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
 * Create uncaught exception handler
 */
function createUncaughtExceptionHandler(ctx: SignalHandlerContext): (error: Error) => Promise<void> {
  return async (error: Error) => {
    process.stderr.write(`\n[nax crash] Uncaught exception: ${error.message}\n${error.stack ?? ""}\n`);
    const logger = getSafeLogger();
    logger?.error("crash-recovery", "Uncaught exception", {
      error: error.message,
      stack: error.stack,
    });

    // Close ACP sessions gracefully first (spawns are tracked by pidRegistry)
    if (ctx.onShutdown) {
      await ctx.onShutdown().catch(() => {});
    }

    // Kill any remaining processes (including hung session-close spawns)
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
 * Create unhandled promise rejection handler
 */
function createUnhandledRejectionHandler(ctx: SignalHandlerContext): (reason: unknown) => Promise<void> {
  return async (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    process.stderr.write(`\n[nax crash] Unhandled rejection: ${error.message}\n${error.stack ?? ""}\n`);
    const logger = getSafeLogger();
    logger?.error("crash-recovery", "Unhandled promise rejection", {
      error: error.message,
      stack: error.stack,
    });

    // Close ACP sessions gracefully first (spawns are tracked by pidRegistry)
    if (ctx.onShutdown) {
      await ctx.onShutdown().catch(() => {});
    }

    // Kill any remaining processes (including hung session-close spawns)
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
 * Install signal and exception handlers, return cleanup function
 */
export function installSignalHandlers(ctx: SignalHandlerContext): () => void {
  const logger = getSafeLogger();

  const signalHandler = createSignalHandler(ctx);
  const uncaughtExceptionHandler = createUncaughtExceptionHandler(ctx);
  const unhandledRejectionHandler = createUnhandledRejectionHandler(ctx);

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
