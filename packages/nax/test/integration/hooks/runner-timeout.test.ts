/**
 * A hook that exceeds its timeout is killed together with everything it spawned.
 * Real processes: the defect only shows when a real child outlives the hook.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { fireHook, type LoadedHooksConfig } from "@/hooks/runner";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the hook's pidfile with a short bounded wait: the child may not have
 * been written yet when the hook returns, and an unbounded read surfaces ENOENT
 * as a thrown stack rather than a clean assertion. Returns the trimmed contents
 * (possibly "") once the file appears or the deadline passes.
 */
async function readPidFile(path: string): Promise<string> {
  const deadline = Date.now() + 1_000;
  for (;;) {
    const text = await Bun.file(path)
      .text()
      .catch(() => (Date.now() < deadline ? undefined : ""));
    if (text !== undefined) return text.trim();
    await Bun.sleep(25);
  }
}

describe("fireHook — timeout kills the hook's process group", () => {
  let dir = "";
  const strays: number[] = [];

  afterEach(() => {
    for (const pid of strays.splice(0)) {
      // A stray of 0 (from an empty pidfile) would be `process.kill(0, ...)`,
      // which signals the caller's whole process group. Only ever target a
      // real child pid that is still alive.
      if (!Number.isInteger(pid) || pid <= 1 || !isAlive(pid)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone: the case this test expects.
      }
    }
    cleanupTempDir(dir);
  });

  test("a background child started by the hook does not outlive the timeout", async () => {
    dir = makeTempDir();
    const pidFile = join(dir, "child.pid");
    const script = join(dir, "hook.sh");
    await Bun.write(script, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nwait\n`);
    // A global hook needs no project trust (runner-validation.test.ts AC11).
    const config: LoadedHooksConfig = {
      hooks: {},
      _global: { hooks: { "on-start": { command: `sh '${script}'`, timeout: 300 } } },
    };

    await fireHook(config, "on-start", { event: "on-start", feature: "timeout-test" }, dir);

    const childPid = Number(await readPidFile(pidFile));
    expect(Number.isInteger(childPid) && childPid > 1).toBe(true);
    strays.push(childPid);
    const deadline = Date.now() + 2_000;
    while (isAlive(childPid) && Date.now() < deadline) await Bun.sleep(50);
    expect(isAlive(childPid)).toBe(false);
  });
});
