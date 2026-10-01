import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeSpawn,
  makeTempDir,
  waitForCondition,
  waitForFile,
  withDepsRestore,
  withTimeout,
} from "@test/helpers";
import { _argvExecDeps, runArgv } from "@/utils/argv-exec";

describe("runArgv", () => {
  test("returns exit code and stdout without a shell", async () => {
    const result = await runArgv({ argv: ["echo", "hello"], cwd: process.cwd(), timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.timedOut).toBe(false);
  });

  test("does not interpret shell metacharacters", async () => {
    // With a shell this would print "a" and run `echo b`. Without one, the
    // whole string is a single argument to echo.
    const result = await runArgv({ argv: ["echo", "a; echo b"], cwd: process.cwd(), timeoutMs: 5000 });
    expect(result.stdout.trim()).toBe("a; echo b");
  });

  test("reports timedOut and a non-zero exit when the deadline passes", async () => {
    const result = await runArgv({ argv: ["sleep", "5"], cwd: process.cwd(), timeoutMs: 250 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test("applies the env overlay to the child", async () => {
    const result = await runArgv({
      argv: ["sh", "-c", "printenv NAX_TEST_OVERLAY || true"],
      cwd: process.cwd(),
      timeoutMs: 5000,
      env: { NAX_TEST_OVERLAY: "on" },
    });
    expect(result.stdout.trim()).toBe("on");
  });

  test("strips the named environment variables from the child", async () => {
    process.env.NAX_TEST_SECRET = "leaked";
    try {
      const result = await runArgv({
        argv: ["sh", "-c", "printenv NAX_TEST_SECRET || true"],
        cwd: process.cwd(),
        timeoutMs: 5000,
        stripEnvVars: ["NAX_TEST_SECRET"],
      });
      expect(result.stdout).not.toContain("leaked");
    } finally {
      process.env.NAX_TEST_SECRET = undefined;
    }
  });
});

describe("US-001 runArgv abort & drain", () => {
  withDepsRestore(_argvExecDeps);

  let root: string;
  beforeEach(() => {
    root = makeTempDir("argv-exec-");
  });
  afterEach(() => cleanupTempDir(root));

  function survivors(marker: string): string {
    const r = Bun.spawnSync(["/bin/sh", "-c", `ps -e -o args | grep '${marker}' | grep -v grep || true`]);
    return r.stdout.toString().trim();
  }

  test("US-001 AC1-AC4: a background process holding stdout is drained — orphansKilled, not timedOut, started, under 5 s, no survivor", async () => {
    const started = Date.now();
    const result = await withTimeout(
      runArgv({ argv: ["sh", "-c", "sleep 4712 & echo started"], cwd: root, timeoutMs: 1500 }),
      5_000,
      "US-001 drain settle",
    );
    expect(result.stdout).toContain("started");
    expect(result.orphansKilled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    await waitForCondition(() => survivors("sleep 4712") === "", 3_000, 50);
  }, 20_000);

  test("US-001 AC5-AC6: aborting during a long command SIGKILLs the group and resolves aborted with no survivor", async () => {
    const controller = new AbortController();
    const pidFile = join(root, "pid");
    const runPromise = runArgv({
      argv: ["sh", "-c", `echo $$ > ${pidFile}; sleep 4713`],
      cwd: root,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await waitForFile(pidFile, 5_000);
    controller.abort();
    const result = await withTimeout(runPromise, 5_000, "US-001 abort settle");
    expect(result.aborted).toBe(true);
    await waitForCondition(() => survivors("sleep 4713") === "", 3_000, 50);
  }, 20_000);

  test("US-001 AC7: an already-aborted signal never spawns and resolves aborted with exitCode -1", async () => {
    const stub = makeSpawn();
    _argvExecDeps.spawn = stub.spawn;
    const controller = new AbortController();
    controller.abort();
    const result = await runArgv({
      argv: ["echo", "hi"],
      cwd: root,
      timeoutMs: 5000,
      signal: controller.signal,
    });
    expect(stub.calls).toHaveLength(0);
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBe(-1);
  });

  test("US-001 AC8: a command writing 256 KiB to stdout and exiting is fully drained with orphansKilled false", async () => {
    const result = await runArgv({
      argv: ["awk", 'BEGIN { for (i = 0; i < 262144; i++) printf "x" }'],
      cwd: root,
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(262144);
    expect(result.orphansKilled).toBe(false);
  });

  test("US-001 AC9: a deadline timeout resolves timedOut true and aborted false", async () => {
    const result = await runArgv({ argv: ["sleep", "5"], cwd: root, timeoutMs: 250 });
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
  });

  test("a deadline that expires while background output is draining reports a timeout", async () => {
    const result = await runArgv({
      argv: ["sh", "-c", "sleep 4715 & echo started"],
      cwd: root,
      timeoutMs: 250,
    });
    expect(result.stdout).toContain("started");
    expect(result.timedOut).toBe(true);
    await waitForCondition(() => survivors("sleep 4715") === "", 3_000, 50);
  });

  test("US-001 AC10: runArgv removes its abort listener when it settles on a never-aborted signal", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    let removals = 0;
    const originalRemove = signal.removeEventListener.bind(signal);
    signal.removeEventListener = (type, callback, options) => {
      if (type === "abort") removals += 1;
      return originalRemove(type, callback, options);
    };
    const result = await runArgv({ argv: ["echo", "hi"], cwd: root, timeoutMs: 5000, signal });
    expect(result.exitCode).toBe(0);
    expect(removals).toBeGreaterThan(0);
  });
});
