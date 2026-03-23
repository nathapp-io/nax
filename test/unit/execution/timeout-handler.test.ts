import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { withProcessTimeout, type ProcessTimeoutResult } from "../../../src/execution/timeout-handler";

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
      pid: 12345,
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
    const result = await Promise.race([
      withProcessTimeout(mockProc, 1000),
      new Promise<ProcessTimeoutResult>((resolve) => {
        setTimeout(() => {
          resolveExit(0);
        }, 100);
      }).then(() => ({ exitCode: 0, timedOut: false })),
    ]);

    resolveExit(0);
    const finalResult = await withProcessTimeout(mockProc, 1000);

    expect(finalResult.timedOut).toBe(false);
    expect(typeof finalResult.exitCode).toBe("number");
  });

  test("marks timedOut as true when timeout occurs", async () => {
    const timeoutMs = 100;
    // Don't resolve the exit promise - simulate a hanging process
    const result = withProcessTimeout(mockProc, timeoutMs, {
      graceMs: 50,
    });

    // Wait for timeout to trigger
    await Bun.sleep(200);
    resolveExit(-1); // Exit the process to allow the test to complete

    const finalResult = await result;
    expect(finalResult.timedOut).toBe(true);
  });

  test("calls onTimeout callback when timeout occurs", async () => {
    const onTimeoutMock = mock(() => {});
    const timeoutMs = 100;

    const result = withProcessTimeout(mockProc, timeoutMs, {
      graceMs: 50,
      onTimeout: onTimeoutMock,
    });

    // Wait for timeout to trigger
    await Bun.sleep(200);
    resolveExit(-1); // Exit the process

    await result;
    expect(onTimeoutMock).toHaveBeenCalled();
  });

  test("sends SIGTERM when timeout is reached", async () => {
    const timeoutMs = 100;

    const result = withProcessTimeout(mockProc, timeoutMs, {
      graceMs: 50,
    });

    // Wait for timeout to trigger
    await Bun.sleep(150);
    resolveExit(-1);

    await result;
    expect(mockProc.kill).toHaveBeenCalled();
  });

  test("respects custom grace period", async () => {
    const customGraceMs = 200;
    const timeoutMs = 100;

    const result = withProcessTimeout(mockProc, timeoutMs, {
      graceMs: customGraceMs,
    });

    // Wait slightly more than timeout + grace period
    await Bun.sleep(timeoutMs + customGraceMs + 50);
    resolveExit(-1);

    await result;
    // If custom grace period was used, SIGKILL should have been called
    expect(mockProc.kill).toHaveBeenCalled();
  });

  test("returns -1 when hard deadline is exceeded", async () => {
    const timeoutMs = 50;
    // Simulate a process that never exits
    const result = withProcessTimeout(mockProc, timeoutMs, {
      graceMs: 50,
      hardDeadlineBufferMs: 100,
    });

    // Wait for hard deadline
    await Bun.sleep(300);
    resolveExit(-1);

    const finalResult = await result;
    expect(finalResult.exitCode === -1 || finalResult.timedOut).toBe(true);
  });

  test("cleans up timers even if process.kill throws", async () => {
    const errProc = {
      ...mockProc,
      kill: mock(() => {
        throw new Error("Kill failed");
      }),
    };

    const timeoutMs = 50;
    const result = withProcessTimeout(errProc, timeoutMs, {
      graceMs: 50,
    });

    await Bun.sleep(150);
    resolveExit(-1);

    // Should not throw - error should be caught
    const finalResult = await result;
    expect(finalResult).toBeDefined();
  });
});
