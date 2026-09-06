/**
 * executor.ts unit tests
 *
 * Covers the timeout/kill path of executeWithTimeout, in particular that the
 * SIGTERM grace period does not leave an armed timer behind. An uncancelled
 * grace timer keeps Bun's event loop alive for the full grace period after the
 * function has already returned; the leak is asserted by spying on the global
 * timer pair, which is deterministic and independent of CI scheduling.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeSpawn, makeSpawnResult, withTimerSpy } from "@test/helpers";
import { _executorDeps, appendForceExitFlag, executeWithTimeout, normalizeEnvironment } from "@/verification";

describe("appendForceExitFlag (VER-1)", () => {
  test("inserts before a pipe, not inside the redirect tail", () => {
    expect(appendForceExitFlag("bun test 2>&1 | tee out")).toBe("bun test --forceExit 2>&1 | tee out");
  });

  test("inserts before a fd-redirect chain (> log 2>&1)", () => {
    expect(appendForceExitFlag("bun test > log 2>&1")).toBe("bun test --forceExit > log 2>&1");
  });

  test("does not split on a pipe inside a quoted argument", () => {
    expect(appendForceExitFlag("bun test -t 'a|b'")).toBe("bun test -t 'a|b' --forceExit");
  });

  test("does not split a filename that happens to end in digits before a redirect", () => {
    // Regression: a naive "back up over any preceding digits" rule treats the
    // "123" in "file123" as if it were a standalone fd number (like the "2" in
    // "2>&1"), splitting the argument into "file" and "123". Real shells only
    // treat a digit run as an fd number when it is its own token (preceded by
    // whitespace/start-of-string/an operator) — verified against bash directly:
    // `echo file123>out.txt` writes "file123" to out.txt, not to fd 123.
    expect(appendForceExitFlag("bun test file123>out.txt")).toBe("bun test file123 --forceExit >out.txt");
  });

  test("appends at the end when there is no pipe or redirect", () => {
    expect(appendForceExitFlag("bun test")).toBe("bun test --forceExit");
  });
});

describe("normalizeEnvironment", () => {
  // nax#agent-output: these three are how `bun test` (and other agent-aware
  // runners) are told to emit failures-only output. Stripping them made every
  // test command 12-240x more verbose for zero diagnostic gain — the detail
  // nax parses (failures, summary) survives agent mode intact.
  test("preserves agent-output markers by default", () => {
    const out = normalizeEnvironment({ CLAUDECODE: "1", REPL_ID: "x", AGENT: "1", PATH: "/usr/bin" });
    expect(out.CLAUDECODE).toBe("1");
    expect(out.REPL_ID).toBe("x");
    expect(out.AGENT).toBe("1");
    expect(out.PATH).toBe("/usr/bin");
  });

  test("sets AGENT=1 when the caller carries no agent-output marker", () => {
    const out = normalizeEnvironment({ PATH: "/usr/bin" });
    expect(out.AGENT).toBe("1");
  });

  test("does not add AGENT when another marker is already present", () => {
    expect(normalizeEnvironment({ CLAUDECODE: "1" }).AGENT).toBeUndefined();
    expect(normalizeEnvironment({ REPL_ID: "x" }).AGENT).toBeUndefined();
  });

  test("an explicit strip of AGENT is honoured and not re-added", () => {
    const out = normalizeEnvironment({ AGENT: "1", PATH: "/usr/bin" }, ["AGENT"]);
    expect(out.AGENT).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
  });

  test("honours an explicit strip list", () => {
    const out = normalizeEnvironment({ FOO: "1", AGENT: "1" }, ["FOO"]);
    expect(out.FOO).toBeUndefined();
    expect(out.AGENT).toBe("1");
  });
});

describe("executeWithTimeout", () => {
  // 0.1s, not 1s: `timeoutSeconds` is only ever multiplied out to ms, and what is
  // under test is the timeout->kill transition, not how long the wait was.
  test("returns a timeout result and reports the process killed", async () => {
    const result = await executeWithTimeout("sleep 30", 0.1, undefined, { gracePeriodMs: 200 });

    expect(result.timeout).toBe(true);
    expect(result.killed).toBe(true);
    expect(result.success).toBe(false);
  }, 15_000);

  test("captures output and exit code for a command that finishes in time", async () => {
    const result = await executeWithTimeout("echo hello-from-child", 10);

    expect(result.timeout).toBe(false);
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello-from-child");
  }, 15_000);

  // Regression: the grace-period timer used to be created without capturing its
  // handle, so it was never cleared. When the child dies promptly on SIGTERM the
  // race settles immediately, but the timer stayed armed and pinned Bun's event
  // loop for the full grace period — a hard delay on CLI exit.
  //
  // Asserted on the timers themselves rather than on process exit time: a
  // wall-clock assertion needs a nested runtime and is hostage to CI scheduling.
  test("clears every timer it arms on the kill path", async () => {
    const { result, leaked } = await withTimerSpy(() =>
      // Short grace/drain deliberately: the leak is structural (a timer that is
      // never passed to clearTimeout), not durational, so the assertion does not
      // need a long window — and CI cannot be relied on to make SIGTERM reap the
      // child, which would otherwise stall the test for the full grace period.
      executeWithTimeout("sleep 30", 0.1, undefined, { gracePeriodMs: 200, drainTimeoutMs: 500 }),
    );

    expect(result.timeout).toBe(true);
    expect(leaked).toEqual([]);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// BUG-2: executeWithTimeout must bound the pipe-drain waits on the SUCCESS
// path, not just the timeout path. A subprocess that exits cleanly but whose
// stdout/stderr pipes never close (orphaned grandchild holding the write-end)
// used to wedge the call indefinitely on `await Promise.all([stdout, stderr])`.
// ---------------------------------------------------------------------------

describe("executeWithTimeout — BUG-2 drain-deadlock regression", () => {
  let originalSpawn: typeof _executorDeps.spawn;

  beforeEach(() => {
    originalSpawn = _executorDeps.spawn;
  });

  afterEach(() => {
    _executorDeps.spawn = originalSpawn;
    mock.restore();
  });

  test("returns within drainTimeoutMs even when stdout/stderr pipes never close after the process exits", async () => {
    // Reproduces BUG-2: proc.exited resolves (so we take the success path, not
    // the timeout path), but the streams stay open because a grandchild
    // inherited the write-end. Pre-fix, line 167's `Promise.all([stdoutPromise,
    // stderrPromise])` waits forever. Post-fix, raceWithDeadline bounds both
    // drains with drainTimeoutMs, mirroring the timeout path (lines 147-150).
    _executorDeps.spawn = makeSpawn(() => {
      const proc = makeSpawnResult({ pid: 99999 });
      // Never enqueue, never close — a grandchild inherited the write-end.
      Object.defineProperty(proc, "stdout", { value: new ReadableStream({ start() {} }) });
      Object.defineProperty(proc, "stderr", { value: new ReadableStream({ start() {} }) });
      return proc;
    }).spawn;

    const start = Date.now();
    const result = await executeWithTimeout("ignored — spawn is mocked", 10, undefined, {
      drainTimeoutMs: 200,
    });
    const elapsed = Date.now() - start;

    // Pre-fix this would be a hard hang; the test would time out at the suite
    // default (~5s) and report a deadlock. Post-fix, raceWithDeadline caps the
    // drain at drainTimeoutMs (200ms here) and the function returns whatever it
    // managed to collect (empty in this mock).
    expect(elapsed).toBeLessThan(2_000);
    expect(result.timeout).toBe(false);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  }, 5_000);

  test("captures partial stdout when the stream closes before the drain deadline", async () => {
    // Positive control: when the stream DOES close (just not on the OS-pipe
    // schedule), the drain captures the buffered output. This guards against a
    // regression where raceWithDeadline accidentally throws away data the
    // race actually won.
    _executorDeps.spawn = makeSpawn(() => "hello-from-child\n").spawn;

    const result = await executeWithTimeout("ignored — spawn is mocked", 10, undefined, {
      drainTimeoutMs: 1_000,
    });

    expect(result.timeout).toBe(false);
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello-from-child");
  }, 5_000);
});
