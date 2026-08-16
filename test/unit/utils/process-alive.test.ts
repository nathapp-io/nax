import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isProcessAlive } from "@/utils/process-alive";

/** Build an errno-carrying error the way node's process.kill throws one. */
function errnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("isProcessAlive", () => {
  let originalKill: typeof process.kill;

  beforeEach(() => {
    originalKill = process.kill;
  });

  afterEach(() => {
    process.kill = originalKill;
  });

  test("probes with signal 0 so no signal is actually delivered", () => {
    const calls: Array<{ pid: number | string; signal?: string | number }> = [];
    process.kill = ((pid, signal) => {
      calls.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    expect(isProcessAlive(4321)).toBe(true);
    expect(calls).toEqual([{ pid: 4321, signal: 0 }]);
  });

  test("reports dead when the process does not exist (ESRCH)", () => {
    process.kill = (() => {
      throw errnoError("ESRCH");
    }) as typeof process.kill;

    expect(isProcessAlive(4321)).toBe(false);
  });

  test("reports ALIVE when the probe is denied (EPERM) — the process exists, we just cannot signal it", () => {
    process.kill = (() => {
      throw errnoError("EPERM");
    }) as typeof process.kill;

    expect(isProcessAlive(4321)).toBe(true);
  });

  test("reports alive for any other errno — only ESRCH proves absence", () => {
    process.kill = (() => {
      throw errnoError("EINVAL");
    }) as typeof process.kill;

    expect(isProcessAlive(4321)).toBe(true);
  });

  test("reports alive for a throw carrying no errno — an inconclusive probe must not read as absence", () => {
    process.kill = (() => {
      throw new Error("boom");
    }) as typeof process.kill;

    expect(isProcessAlive(4321)).toBe(true);
  });

  test("treats a non-positive pid as dead without probing", () => {
    let probed = false;
    process.kill = (() => {
      probed = true;
      return true;
    }) as typeof process.kill;

    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
    expect(probed).toBe(false);
  });
});
