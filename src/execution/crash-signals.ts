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
 * How long a fatal handler may spend in teardown before the process is killed
 * anyway.
 *
 * BUG-37: only the signal path used to arm this. The uncaughtException and
 * unhandledRejection paths ran the same `performTeardown` — which awaits
 * `onShutdown`, a PID sweep, and four artifact writes — with no ceiling. Worse,
 * all three handlers share one `shuttingDown` flag, so once a crash wedged
 * teardown the SIGINT handler returned early and Ctrl+C stopped working: the
 * user was left with a printed crash and an unkillable process.
 */
export const FATAL_TEARDOWN_DEADLINE_MS = 10_000;

/** Cancels an armed deadline. Returned by `armDeadline` in place of a raw timer
 * handle, so no caller — production or test — has to model one. */
type CancelDeadline = () => void;

/**
 * Injectable seams for the fatal paths.
 *
 * `armDeadline` owns the timer end to end (create, unref, cancel), so a test can
 * drive the deadline by swapping one function instead of patching globals.
 */
export const _crashSignalsDeps: {
  exit: (code: number) => void;
  armDeadline: (fn: () => void, ms: number) => CancelDeadline;
} = {
  exit: (code: number): void => {
    process.exit(code);
  },
  armDeadline: (fn: () => void, ms: number): CancelDeadline => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/**
 * Arm the hard exit deadline shared by every fatal handler.
 *
 * The timer is unref'd, so it never by itself keeps the loop alive — this is a
 * backstop for a teardown that hangs, not a reason to stay running.
 */
function armTeardownDeadline(exitCode: number): CancelDeadline {
  return _crashSignalsDeps.armDeadline(() => {
    _crashSignalsDeps.exit(exitCode);
  }, FATAL_TEARDOWN_DEADLINE_MS);
}

/**
 * Shared teardown sequence used by every fatal handler (signal, uncaught
 * exception, unhandled rejection).
 *
 * BUG-11: `freeze()` must run AFTER `onShutdown()` completes, not before.
 * `onShutdown` itself spawns new processes (e.g. `acpx sessions close`/`stop`)
 * — freezing the registry first meant `register()` silently dropped those
 * PIDs, so a hung `acpx stop` was never reachable by the `killAll()` sweep
 * that follows. Freezing here (after onShutdown, before killAll) preserves
 * both invariants: teardown-spawned PIDs get registered normally, and the
 * registry is still locked before killAll() enumerates its target list, so
 * nothing can register after the sweep has started.
 */
export async function performTeardown(ctx: SignalHandlerContext): Promise<void> {
  // Abort in-flight awaits so onShutdown / agent.run can bail fast.
  ctx.abortController?.abort();

  // Close ACP sessions gracefully first (spawns are tracked by pidRegistry).
  if (ctx.onShutdown) {
    await ctx.onShutdown(ctx.abortController?.signal).catch(() => {});
  }

  // Freeze the PID registry now that onShutdown-spawned PIDs have had a
  // chance to register — subsequent retry paths cannot register new
  // processes once the kill sweep below has enumerated its target list.
  ctx.pidRegistry?.freeze?.();

  // Kill any remaining processes (including hung session-close spawns).
  if (ctx.pidRegistry) {
    await ctx.pidRegistry.killAll();
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

    const cancelDeadline = armTeardownDeadline(128 + getSignalNumber(signal));

    logger?.error("crash-recovery", `Received ${signal}, shutting down...`, { signal });

    await performTeardown(ctx);

    ctx.emitError?.(signal.toLowerCase());

    await writeFatalLog(ctx.jsonlFilePath, signal);
    await writeRunComplete(ctx, signal.toLowerCase());
    await updateStatusToCrashed(ctx.statusWriter, ctx.getTotalCost(), ctx.getIterations(), signal, ctx.featureDir);

    cancelDeadline();
    _crashSignalsDeps.exit(128 + getSignalNumber(signal));
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

    const cancelDeadline = armTeardownDeadline(1);

    logger?.error("crash-recovery", "Uncaught exception", {
      error: error.message,
      stack: error.stack,
    });

    await performTeardown(ctx);

    ctx.emitError?.("uncaughtException");
    await writeFatalLog(ctx.jsonlFilePath, "uncaughtException", error);
    await updateStatusToCrashed(
      ctx.statusWriter,
      ctx.getTotalCost(),
      ctx.getIterations(),
      "uncaughtException",
      ctx.featureDir,
    );

    cancelDeadline();
    _crashSignalsDeps.exit(1);
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

    const cancelDeadline = armTeardownDeadline(1);

    logger?.error("crash-recovery", "Unhandled promise rejection", {
      error: error.message,
      stack: error.stack,
    });

    await performTeardown(ctx);

    ctx.emitError?.("unhandledRejection");
    await writeFatalLog(ctx.jsonlFilePath, "unhandledRejection", error);
    await updateStatusToCrashed(
      ctx.statusWriter,
      ctx.getTotalCost(),
      ctx.getIterations(),
      "unhandledRejection",
      ctx.featureDir,
    );

    cancelDeadline();
    _crashSignalsDeps.exit(1);
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
