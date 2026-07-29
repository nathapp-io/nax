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
import { executeWithTimeout, normalizeEnvironment } from "@/verification";

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
  test("returns a timeout result and reports the process killed", async () => {
    const result = await executeWithTimeout("sleep 30", 1, undefined, { gracePeriodMs: 200 });

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
      executeWithTimeout("sleep 30", 1, undefined, { gracePeriodMs: 200, drainTimeoutMs: 500 }),
    );

    expect(result.timeout).toBe(true);
    expect(leaked).toEqual([]);
  }, 20_000);
});
