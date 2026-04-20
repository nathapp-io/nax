/**
 * crash-signals — idempotency + AbortController (Issue 5 fix).
 *
 * Ensures that once a shutdown path has started, subsequent fatal signals
 * log and no-op. Also verifies that `abortController` is aborted on first
 * signal and `onShutdown` receives the signal.
 *
 * Signals are not fired via `process.kill` (that would kill the test
 * runner). Instead we invoke the listener directly — same code path, no
 * process exit because we mock `process.exit`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type SignalHandlerContext,
  installSignalHandlers,
} from "../../../src/execution/crash-signals";
import type { StatusWriter } from "../../../src/execution/status-writer";

const noopStatusWriter = {
  setRunStatus: () => {},
  update: async () => {},
} as unknown as StatusWriter;

/** Invoke every SIGTERM listener registered on `process`. */
async function fireSignal(signal: NodeJS.Signals): Promise<void> {
  const listeners = process.listeners(signal) as Array<() => Promise<void> | void>;
  for (const fn of listeners) {
    await fn();
  }
}

describe("crash-signals idempotency", () => {
  let cleanup: (() => void) | undefined;
  let originalExit: typeof process.exit;
  let exitCalls: number[] = [];

  beforeEach(() => {
    originalExit = process.exit;
    exitCalls = [];
    // Prevent the real process.exit from killing the test runner.
    (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
      exitCalls.push(code ?? 0);
      // biome-ignore lint/correctness/noPrecisionLoss: no-op in tests
      return undefined as never;
    }) as typeof process.exit;
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    process.exit = originalExit;
  });

  test("second signal after shutdown has started is ignored (no duplicate onShutdown/killAll)", async () => {
    const onShutdown = mock(async () => {});
    const killAll = mock(async () => {});
    const abortController = new AbortController();

    const ctx: SignalHandlerContext = {
      statusWriter: noopStatusWriter,
      getTotalCost: () => 0,
      getIterations: () => 0,
      onShutdown,
      pidRegistry: {
        killAll,
        register: async () => {},
        unregister: async () => {},
        cleanupStale: async () => {},
        freeze: () => {},
        isFrozen: () => false,
        getPids: () => [],
      } as never,
      abortController,
    };

    cleanup = installSignalHandlers(ctx);

    // First SIGINT fires the full path.
    await fireSignal("SIGINT");

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(killAll).toHaveBeenCalledTimes(1);
    expect(abortController.signal.aborted).toBe(true);

    // Second fatal signal must NOT re-run onShutdown / killAll.
    await fireSignal("SIGTERM");

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(killAll).toHaveBeenCalledTimes(1);
  });

  test("first signal aborts the shared AbortController", async () => {
    const abortController = new AbortController();
    const ctx: SignalHandlerContext = {
      statusWriter: noopStatusWriter,
      getTotalCost: () => 0,
      getIterations: () => 0,
      abortController,
    };

    cleanup = installSignalHandlers(ctx);

    expect(abortController.signal.aborted).toBe(false);
    await fireSignal("SIGINT");
    expect(abortController.signal.aborted).toBe(true);
  });

  test("onShutdown receives the abort signal so it can short-circuit long awaits", async () => {
    let received: AbortSignal | undefined;
    const abortController = new AbortController();

    const ctx: SignalHandlerContext = {
      statusWriter: noopStatusWriter,
      getTotalCost: () => 0,
      getIterations: () => 0,
      abortController,
      onShutdown: async (signal) => {
        received = signal;
      },
    };

    cleanup = installSignalHandlers(ctx);
    await fireSignal("SIGINT");

    expect(received).toBeDefined();
    expect(received?.aborted).toBe(true);
  });

  test("pidRegistry.freeze() is called on first signal", async () => {
    const freeze = mock(() => {});
    const ctx: SignalHandlerContext = {
      statusWriter: noopStatusWriter,
      getTotalCost: () => 0,
      getIterations: () => 0,
      pidRegistry: {
        freeze,
        killAll: async () => {},
        register: async () => {},
        unregister: async () => {},
        cleanupStale: async () => {},
        isFrozen: () => false,
        getPids: () => [],
      } as never,
    };

    cleanup = installSignalHandlers(ctx);
    await fireSignal("SIGINT");

    expect(freeze).toHaveBeenCalledTimes(1);
  });
});
