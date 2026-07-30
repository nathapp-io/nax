/**
 * Real-subprocess tests for the nax-finish flow's exec layer.
 *
 * Every other test under `test/unit/flows/nax-finish/` injects `_deps`, so no
 * test ever executed `spawnCapture` itself — which is why `Bun.spawn` shipped
 * in a module that only ever runs inside acpx's Node process, and failed there
 * with `ReferenceError: Bun is not defined`. These tests spawn for real so the
 * exec layer's own behaviour is covered.
 *
 * The Bun-global regression is guarded statically by
 * `scripts/check-flows-no-bun.ts` — this suite runs under Bun, where a `Bun.*`
 * call would resolve fine and prove nothing.
 */
import { describe, expect, test } from "bun:test";
import { runArgv, runShell } from "@flows/nax-finish/exec";

const CWD = process.cwd();

describe("runArgv", () => {
  test("captures stdout and a zero exit code", async () => {
    const res = await runArgv(["echo", "hello"], { cwd: CWD });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hello");
    expect(res.timedOut).toBeUndefined();
  });

  test("captures stderr and a non-zero exit code", async () => {
    const res = await runArgv(["/bin/sh", "-c", "echo boom >&2; exit 3"], { cwd: CWD });
    expect(res.exitCode).toBe(3);
    expect(res.stderr.trim()).toBe("boom");
  });

  test("runs in the requested cwd", async () => {
    const res = await runArgv(["pwd"], { cwd: "/tmp" });
    // /tmp is a symlink to /private/tmp on macOS — match either.
    expect(res.stdout.trim()).toMatch(/\/tmp$/);
  });

  test("does not interpret shell metacharacters in argv", async () => {
    const res = await runArgv(["echo", "a && b > c"], { cwd: CWD });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("a && b > c");
  });

  test("reports a missing binary as exit 127 instead of throwing", async () => {
    const res = await runArgv(["nax-definitely-not-a-real-binary"], { cwd: CWD });
    expect(res.exitCode).toBe(127);
    expect(res.stderr).not.toBe("");
  });

  test("kills an overrunning process and reports exit 124", async () => {
    const res = await runArgv(["/bin/sh", "-c", "sleep 30"], { cwd: CWD, timeoutMs: 200 });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(124);
    expect(res.stderr).toContain("killed after 200ms timeout");
  });

  test("drains output larger than a pipe buffer without deadlocking", async () => {
    const res = await runArgv(["/bin/sh", "-c", "yes nax | head -c 200000"], { cwd: CWD });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.length).toBe(200_000);
  });
});

describe("runShell", () => {
  test("preserves shell semantics in a configured command string", async () => {
    const res = await runShell("echo one && echo two", { cwd: CWD });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim().split("\n")).toEqual(["one", "two"]);
  });

  test("propagates the exit code of a failing gate command", async () => {
    const res = await runShell("exit 7", { cwd: CWD });
    expect(res.exitCode).toBe(7);
  });
});
