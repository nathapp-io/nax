/**
 * executor.ts unit tests
 *
 * Covers the timeout/kill path of executeWithTimeout, in particular that the
 * SIGTERM grace period does not leave an armed timer behind. An uncancelled
 * grace timer keeps Bun's event loop alive for the full grace period after the
 * function has already returned; the leak is asserted by spying on the global
 * timer pair, which is deterministic and independent of CI scheduling.
 */

import { describe, expect, test } from "bun:test";
import { withTimerSpy } from "@test/helpers";
import { appendForceExitFlag, executeWithTimeout, normalizeEnvironment } from "@/verification";

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
  test("strips AI-optimized env vars by default", () => {
    const out = normalizeEnvironment({ CLAUDECODE: "1", REPL_ID: "x", AGENT: "1", PATH: "/usr/bin" });
    expect(out.CLAUDECODE).toBeUndefined();
    expect(out.REPL_ID).toBeUndefined();
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
