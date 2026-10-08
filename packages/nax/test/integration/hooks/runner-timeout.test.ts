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

describe("fireHook — timeout kills the hook's process group", () => {
  let dir = "";
  const strays: number[] = [];

  afterEach(() => {
    for (const pid of strays.splice(0)) {
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

    const childPid = Number((await Bun.file(pidFile).text()).trim());
    strays.push(childPid);
    const deadline = Date.now() + 2_000;
    while (isAlive(childPid) && Date.now() < deadline) await Bun.sleep(50);
    expect(isAlive(childPid)).toBe(false);
  });
});
