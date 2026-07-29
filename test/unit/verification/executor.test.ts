/**
 * executor.ts unit tests
 *
 * Covers the timeout/kill path of executeWithTimeout, in particular that the
 * SIGTERM grace period does not leave an armed timer behind. An uncancelled
 * grace timer keeps Bun's event loop alive for the full grace period after the
 * function has already returned, so the regression is asserted on the *process
 * exit time* of a child that does nothing else — the only place the leak is
 * observable.
 */

import { describe, expect, test } from "bun:test";
import { executeWithTimeout, normalizeEnvironment } from "@/verification";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;

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
  // race settles immediately, but the timer stayed armed and pinned the event
  // loop for the full grace period — a hard delay on CLI exit.
  test("does not keep the event loop alive after the grace period race settles", async () => {
    const gracePeriodMs = 4000;
    const child = `
      const { executeWithTimeout } = await import(${JSON.stringify(`${REPO_ROOT}src/verification/executor.ts`)});
      const t0 = Date.now();
      await executeWithTimeout("sleep 30", 1, undefined, { gracePeriodMs: ${gracePeriodMs} });
      const returned = Date.now() - t0;
      process.on("exit", () => {
        process.stdout.write(JSON.stringify({ returned, exited: Date.now() - t0 }));
      });
    `;

    const proc = Bun.spawn(["bun", "-e", child], { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const { returned, exited } = JSON.parse(stdout) as { returned: number; exited: number };
    const linger = exited - returned;

    // "sleep 30" dies immediately on SIGTERM, so the grace race settles at once.
    // With the leak, linger === gracePeriodMs. Allow generous slack for CI noise.
    expect(linger).toBeLessThan(gracePeriodMs / 2);
  }, 30_000);
});
