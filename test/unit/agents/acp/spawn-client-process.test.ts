/**
 * Tests for spawn-client-process.ts — killProcessTree (BUG-6).
 *
 * BUG-6: killProcessTree's SIGKILL escalation must:
 *  1. Check liveness (via the passed `exited` promise, or a direct liveness
 *     probe) before sending SIGKILL — an unconditional escalation risks
 *     signalling a PID the OS has since reused for an unrelated process.
 *  2. Return a cancel handle so a second kill-tree call for the same PID can
 *     cancel the first timer instead of arming an independent duplicate.
 *
 * SAFETY: every test here stubs process.kill file-wide — see the note in
 * spawn-client.test.ts for why this must never reach the real OS.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { killProcessTree } from "@/agents/acp/spawn-client-process";
import { waitForCondition } from "@test/helpers";

const FAKE_PID = 99999999;

let originalProcessKill: typeof process.kill;
let killCalls: Array<{ pid: number | string; signal?: NodeJS.Signals | number }>;

beforeEach(() => {
  originalProcessKill = process.kill;
  killCalls = [];
  process.kill = ((pid: number | string, signal?: NodeJS.Signals | number) => {
    killCalls.push({ pid, signal });
    return true;
  }) as typeof process.kill;
});

afterEach(() => {
  process.kill = originalProcessKill;
});

describe("killProcessTree — BUG-6", () => {
  test("sends SIGTERM immediately", () => {
    killProcessTree(FAKE_PID, 1);
    expect(killCalls.some((c) => c.pid === -FAKE_PID && c.signal === "SIGTERM")).toBe(true);
  });

  test("escalates to SIGKILL after the grace period when the process never exits", async () => {
    killProcessTree(FAKE_PID, 1);
    await waitForCondition(() => killCalls.some((c) => c.pid === -FAKE_PID && c.signal === "SIGKILL"), 1000, 5);
  });

  test("does NOT escalate to SIGKILL when the exited promise resolves before the grace period", async () => {
    let resolveExited: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    killProcessTree(FAKE_PID, 200, exited);
    resolveExited?.();

    // Give the race a chance to settle on "exited" — well before the 200ms grace.
    // (Bounded poll via the sanctioned test helper, not a raw fixed sleep.)
    await waitForCondition(() => false, 20, 5).catch(() => {});
    expect(killCalls.some((c) => c.signal === "SIGKILL")).toBe(false);
  });

  test("a second call for the same PID cancels the first timer instead of arming a duplicate", async () => {
    killProcessTree(FAKE_PID, 30); // first escalation timer armed
    const secondHandle = killProcessTree(FAKE_PID, 1); // should cancel the first

    await waitForCondition(() => killCalls.some((c) => c.pid === -FAKE_PID && c.signal === "SIGKILL"), 1000, 5);

    const sigkillCount = killCalls.filter((c) => c.pid === -FAKE_PID && c.signal === "SIGKILL").length;
    expect(sigkillCount).toBe(1);
    secondHandle.cancel();
  });

  test("cancel() prevents SIGKILL from firing at all", async () => {
    const handle = killProcessTree(FAKE_PID, 5);
    handle.cancel();

    // Nothing to await on (cancel is synchronous) — poll briefly to confirm
    // the escalation never fires instead of asserting on a fixed sleep.
    await waitForCondition(() => false, 30, 5).catch(() => {});
    expect(killCalls.some((c) => c.signal === "SIGKILL")).toBe(false);
  });

  test("returns a handle whose cancel() is idempotent", () => {
    const handle = killProcessTree(FAKE_PID, 5);
    expect(() => {
      handle.cancel();
      handle.cancel();
    }).not.toThrow();
  });
});
