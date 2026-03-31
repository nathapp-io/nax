import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { killProcessGroup } from "../../../src/utils/process-kill";

describe("killProcessGroup", () => {
  let originalKill: typeof process.kill;

  beforeEach(() => {
    originalKill = process.kill;
  });

  afterEach(() => {
    process.kill = originalKill;
  });

  test("kills process group (negative PID) successfully", () => {
    let killCalls: Array<{ pid: number | string; signal?: NodeJS.Signals | number }> = [];

    process.kill = ((pid, signal) => {
      killCalls.push({ pid, signal });
    }) as typeof process.kill;

    const result = killProcessGroup(1234, "SIGTERM");

    expect(result).toBe(true);
    expect(killCalls).toEqual([{ pid: -1234, signal: "SIGTERM" }]);
  });

  test("falls back to single process kill when group kill fails with ESRCH", () => {
    let killCalls: Array<{ pid: number | string; signal?: NodeJS.Signals | number }> = [];

    process.kill = ((pid, signal) => {
      killCalls.push({ pid, signal });
      // First call (group kill) fails with ESRCH
      if (killCalls.length === 1) {
        const err = new Error("No such process");
        (err as NodeJS.ErrnoException).code = "ESRCH";
        throw err;
      }
    }) as typeof process.kill;

    const result = killProcessGroup(1234, "SIGTERM");

    expect(result).toBe(true);
    expect(killCalls.length).toBe(2);
    expect(killCalls[0]).toEqual({ pid: -1234, signal: "SIGTERM" });
    expect(killCalls[1]).toEqual({ pid: 1234, signal: "SIGTERM" });
  });

  test("returns false when both group and process kill fail with ESRCH", () => {
    process.kill = ((pid, signal) => {
      const err = new Error("No such process");
      (err as NodeJS.ErrnoException).code = "ESRCH";
      throw err;
    }) as typeof process.kill;

    const result = killProcessGroup(1234, "SIGTERM");

    expect(result).toBe(false);
  });

  test("returns true when group kill succeeds", () => {
    process.kill = ((pid, signal) => {
      // Group kill succeeds
    }) as typeof process.kill;

    const result = killProcessGroup(1234, "SIGTERM");

    expect(result).toBe(true);
  });

  test("returns true when single process kill succeeds after group kill fails with ESRCH", () => {
    let callCount = 0;

    process.kill = ((pid, signal) => {
      callCount++;
      if (callCount === 1) {
        // Group kill fails
        const err = new Error("No such process");
        (err as NodeJS.ErrnoException).code = "ESRCH";
        throw err;
      }
      // Single process kill succeeds
    }) as typeof process.kill;

    const result = killProcessGroup(1234, "SIGTERM");

    expect(result).toBe(true);
  });

  test("returns true for non-ESRCH errors in group kill", () => {
    process.kill = ((pid, signal) => {
      if (pid === -1234) {
        // Group kill fails with different error (EPERM, etc.)
        const err = new Error("Operation not permitted");
        (err as NodeJS.ErrnoException).code = "EPERM";
        throw err;
      }
    }) as typeof process.kill;

    const result = killProcessGroup(1234, "SIGTERM");

    expect(result).toBe(true);
  });

  test("supports SIGKILL signal", () => {
    let killCalls: Array<{ pid: number | string; signal?: NodeJS.Signals | number }> = [];

    process.kill = ((pid, signal) => {
      killCalls.push({ pid, signal });
    }) as typeof process.kill;

    const result = killProcessGroup(5678, "SIGKILL");

    expect(result).toBe(true);
    expect(killCalls[0]).toEqual({ pid: -5678, signal: "SIGKILL" });
  });

  test("supports numeric signal codes", () => {
    let killCalls: Array<{ pid: number | string; signal?: NodeJS.Signals | number }> = [];

    process.kill = ((pid, signal) => {
      killCalls.push({ pid, signal });
    }) as typeof process.kill;

    const result = killProcessGroup(9999, 9); // SIGKILL

    expect(result).toBe(true);
    expect(killCalls[0]).toEqual({ pid: -9999, signal: 9 });
  });

  test("handles zero PID gracefully", () => {
    let killCalls: Array<{ pid: number | string; signal?: NodeJS.Signals | number }> = [];

    process.kill = ((pid, signal) => {
      killCalls.push({ pid, signal });
    }) as typeof process.kill;

    const result = killProcessGroup(0, "SIGTERM");

    expect(result).toBe(true);
    // Note: -0 === 0 in JavaScript, so we just check that it's called with a zero-like pid
    expect(killCalls[0]?.signal).toBe("SIGTERM");
    expect(Object.is(killCalls[0]?.pid, -0) || killCalls[0]?.pid === 0).toBe(true);
  });

  test("handles negative PID (already negative process group ID)", () => {
    let killCalls: Array<{ pid: number | string; signal?: NodeJS.Signals | number }> = [];

    process.kill = ((pid, signal) => {
      killCalls.push({ pid, signal });
    }) as typeof process.kill;

    // Note: killProcessGroup receives positive PID and negates it
    // But if given negative, it tries -(−pid) = pid (which becomes positive)
    const result = killProcessGroup(-1234, "SIGTERM");

    expect(result).toBe(true);
    // Should negate: -(-1234) = 1234
    expect(killCalls[0]).toEqual({ pid: 1234, signal: "SIGTERM" });
  });
});
