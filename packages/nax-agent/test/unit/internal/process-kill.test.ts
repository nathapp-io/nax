import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { killProcessGroup } from "#src/internal/process-kill";

describe("killProcessGroup", () => {
  let originalKill: typeof process.kill;

  beforeEach(() => {
    originalKill = process.kill;
  });

  afterEach(() => {
    process.kill = originalKill;
  });

  test("kills process group (negative PID) successfully", () => {
    const killCalls: Array<{ pid: number | string; signal?: string | number }> = [];

    process.kill = ((pid, signal) => {
      killCalls.push({ pid, signal });
    }) as typeof process.kill;

    const result = killProcessGroup(1234, "SIGTERM");

    expect(result).toBe(true);
    expect(killCalls).toEqual([{ pid: -1234, signal: "SIGTERM" }]);
  });

  test("falls back to single process kill when group kill fails with ESRCH", () => {
    const killCalls: Array<{ pid: number | string; signal?: string | number }> = [];

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
    process.kill = ((_pid, _signal) => {
      const err = new Error("No such process");
      (err as NodeJS.ErrnoException).code = "ESRCH";
      throw err;
    }) as typeof process.kill;

    const result = killProcessGroup(1234, "SIGTERM");

    expect(result).toBe(false);
  });

  test("returns true when group kill succeeds", () => {
    process.kill = ((_pid, _signal) => {
      // Group kill succeeds
    }) as typeof process.kill;

    const result = killProcessGroup(1234, "SIGTERM");

    expect(result).toBe(true);
  });

  test("returns true when single process kill succeeds after group kill fails with ESRCH", () => {
    let callCount = 0;

    process.kill = ((_pid, _signal) => {
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
    process.kill = ((pid, _signal) => {
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
    const killCalls: Array<{ pid: number | string; signal?: string | number }> = [];

    process.kill = ((pid, signal) => {
      killCalls.push({ pid, signal });
    }) as typeof process.kill;

    const result = killProcessGroup(5678, "SIGKILL");

    expect(result).toBe(true);
    expect(killCalls[0]).toEqual({ pid: -5678, signal: "SIGKILL" });
  });

  test("supports numeric signal codes", () => {
    const killCalls: Array<{ pid: number | string; signal?: string | number }> = [];

    process.kill = ((pid, signal) => {
      killCalls.push({ pid, signal });
    }) as typeof process.kill;

    const result = killProcessGroup(9999, 9); // SIGKILL

    expect(result).toBe(true);
    expect(killCalls[0]).toEqual({ pid: -9999, signal: 9 });
  });
});

describe("killProcessGroup refuses a pid that would reach other processes", () => {
  test.each([0, 1, -1, -1234, Number.NaN])("pid %p signals nothing and returns false", (pid) => {
    const spy = spyOn(process, "kill").mockImplementation(() => true);
    try {
      expect(killProcessGroup(pid, "SIGKILL")).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
