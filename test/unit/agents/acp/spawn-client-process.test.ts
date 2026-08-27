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

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { waitForCondition } from "@test/helpers";
import { killProcessTree, runTrackedSpawn } from "@/agents/acp/spawn-client-process";

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

// ─────────────────────────────────────────────────────────────────────────────
// MEM-19 — runTrackedSpawn's normal-exit drain had no deadline. A grandchild
// inheriting the pipe fd and outliving acpx produces the same missing-EOF that
// the timeout path already handles ("Bun bug: piped streams may not close").
// The pre-fix code awaited `new Response(proc.stdout).text()` unboundedly once
// `proc.exited` resolved.
// ─────────────────────────────────────────────────────────────────────────────

describe("runTrackedSpawn — MEM-19 normal-exit drain deadline", () => {
  test("normal-exit stdout that never EOFs resolves via the drain timeout instead of hanging", async () => {
    const hangStream = new ReadableStream({ start() {} }); // never enqueues, never closes
    const closedStream = new ReadableStream({
      start(ctrl) {
        ctrl.close();
      },
    });
    const spawn = mock(() => ({
      pid: FAKE_PID,
      exited: Promise.resolve(0),
      stdout: hangStream,
      stderr: closedStream,
      kill: () => {},
    }));

    const startedAt = Date.now();
    const result = await runTrackedSpawn(
      {
        spawn,
        // Far away — the exited race must win; the DRAIN must be what bounds it.
        trackedSpawnDeadlineMs: 60_000,
        killTreeGraceMs: 1,
        streamDrainTimeoutMs: 50,
      },
      ["acpx", "echo", "hello"],
      undefined,
      undefined,
      undefined,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(""); // drain timeout won → empty output
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    // The drain path must never kill the (already exited) process tree.
    expect(killCalls).toHaveLength(0);
  });

  test("normal-exit streams that close promptly still return their full output", async () => {
    const stdoutStream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("hello stdout"));
        ctrl.close();
      },
    });
    const stderrStream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("warn stderr"));
        ctrl.close();
      },
    });
    const spawn = mock(() => ({
      pid: FAKE_PID,
      exited: Promise.resolve(0),
      stdout: stdoutStream,
      stderr: stderrStream,
      kill: () => {},
    }));

    const result = await runTrackedSpawn(
      {
        spawn,
        trackedSpawnDeadlineMs: 60_000,
        killTreeGraceMs: 1,
        streamDrainTimeoutMs: 50,
      },
      ["acpx", "echo", "hello"],
      undefined,
      undefined,
      undefined,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello stdout");
    expect(result.stderr).toBe("warn stderr");
  });
});
