import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { withProcessTimeout } from "../../../src/execution/timeout-handler";
import { waitForCondition } from "../../helpers/timeout";

const SHORT_DELAY_MS = 25;
const TIMEOUT_MS = 75;
const GRACE_MS = 50;
const HARD_DEADLINE_BUFFER_MS = 50;
const CUSTOM_GRACE_MS = 120;

describe("withProcessTimeout", () => {
  let mockProc: {
    pid: number;
    exited: Promise<number>;
    kill(signal?: NodeJS.Signals | number): void;
  };

  let resolveExit: (code: number) => void;
  let exitPromise: Promise<number>;

  beforeEach(() => {
    resolveExit = () => {};
    exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });

    mockProc = {
      pid: 99_999_999,
      exited: exitPromise,
      kill: mock(() => {}),
    };
  });

  afterEach(() => {
    mock.restore();
    // Clear any pending timers
    Bun.gc(true);
  });

  test("returns exit code when process exits normally before timeout", async () => {
    setTimeout(() => resolveExit(0), SHORT_DELAY_MS);
    const finalResult = await withProcessTimeout(mockProc, 1000);

    expect(finalResult.timedOut).toBe(false);
    expect(finalResult.exitCode).toBe(0);
  });

  test("marks timedOut as true when timeout occurs", async () => {
    let onTimeoutResolve = () => {};
    const onTimeoutReached = new Promise<void>((resolve) => {
      onTimeoutResolve = resolve;
    });

    const timeoutMs = TIMEOUT_MS;
    // Don't resolve the exit promise - simulate a hanging process
    const result = withProcessTimeout(mockProc, timeoutMs, {
      graceMs: GRACE_MS,
      onTimeout: onTimeoutResolve,
    });

    await onTimeoutReached;
    resolveExit(-1); // Exit the process to allow the test to complete

    const finalResult = await result;
    expect(finalResult.timedOut).toBe(true);
  });

  test("calls onTimeout callback when timeout occurs", async () => {
    const onTimeoutMock = mock(() => {});
    const timeoutMs = TIMEOUT_MS;

    const result = withProcessTimeout(mockProc, timeoutMs, {
      graceMs: GRACE_MS,
      onTimeout: onTimeoutMock,
    });

    await waitForCondition(() => onTimeoutMock.mock.calls.length > 0);
    resolveExit(-1); // Exit the process

    await result;
    expect(onTimeoutMock).toHaveBeenCalled();
  });

  test("sends SIGTERM via process group kill when timeout is reached", async () => {
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const killFn = mock((proc: { pid: number }, signal: NodeJS.Signals) => {
      killCalls.push({ pid: proc.pid, signal });
    });
    const timeoutMs = TIMEOUT_MS;

    const result = withProcessTimeout(mockProc, timeoutMs, {
      graceMs: GRACE_MS,
      killFn,
    });

    await waitForCondition(() => killCalls.some((call) => call.signal === "SIGTERM"));
    resolveExit(-1);

    await result;
    expect(killFn).toHaveBeenCalled();
    expect(killCalls.some((call) => call.pid === mockProc.pid && call.signal === "SIGTERM")).toBe(true);
  });

  test("respects custom grace period", async () => {
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const killFn = mock((proc: { pid: number }, signal: NodeJS.Signals) => {
      killCalls.push({ pid: proc.pid, signal });
    });
    const customGraceMs = CUSTOM_GRACE_MS;
    const timeoutMs = TIMEOUT_MS;

    const result = withProcessTimeout(mockProc, timeoutMs, {
      graceMs: customGraceMs,
      killFn,
    });

    await waitForCondition(() => killCalls.some((call) => call.signal === "SIGTERM"));
    await waitForCondition(() => killCalls.some((call) => call.signal === "SIGKILL"));
    resolveExit(-1);

    await result;
    expect(killCalls.some((call) => call.pid === mockProc.pid && call.signal === "SIGTERM")).toBe(true);
    expect(killCalls.some((call) => call.pid === mockProc.pid && call.signal === "SIGKILL")).toBe(true);
  });

  test("returns -1 when hard deadline is exceeded", async () => {
    const timeoutMs = TIMEOUT_MS;
    // Simulate a process that never exits
    const finalResult = await withProcessTimeout(mockProc, timeoutMs, {
      graceMs: GRACE_MS,
      hardDeadlineBufferMs: HARD_DEADLINE_BUFFER_MS,
    });

    expect(finalResult.exitCode).toBe(-1);
    expect(finalResult.timedOut).toBe(true);
  });

  test("cleans up timers even if process.kill throws", async () => {
    const timeoutMs = TIMEOUT_MS;
    const result = withProcessTimeout(mockProc, timeoutMs, {
      graceMs: GRACE_MS,
      hardDeadlineBufferMs: HARD_DEADLINE_BUFFER_MS,
      killFn: mock(() => {
        throw new Error("Kill failed");
      }),
    });

    // Should not throw - error should be caught
    const finalResult = await result;
    expect(finalResult).toBeDefined();
  });
});
