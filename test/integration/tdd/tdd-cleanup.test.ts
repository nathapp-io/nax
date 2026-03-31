import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _cleanupDeps, cleanupProcessTree, getPgid } from "../../../src/tdd/cleanup";
import { withDepsRestore } from "../../helpers/deps";

withDepsRestore(_cleanupDeps, ["spawn", "sleep", "kill", "killProcessGroupFn"]);

describe("getPgid", () => {
  test("returns PGID for valid process", async () => {
    const realSpawn = _cleanupDeps.spawn;
    _cleanupDeps.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "ps" && cmd[1] === "-o" && cmd[2] === "pgid=") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("  12345\n").body,
          stderr: new Response("").body,
        };
      }
      return realSpawn(cmd, spawnOpts);
    }) as any;

    const pgid = await getPgid(12345);
    expect(pgid).toBe(12345);
  });

  test("returns null for non-existent process", async () => {
    const realSpawn = _cleanupDeps.spawn;
    _cleanupDeps.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "ps") {
        return {
          exited: Promise.resolve(1),
          stdout: new Response("").body,
          stderr: new Response("No such process\n").body,
        };
      }
      return realSpawn(cmd, spawnOpts);
    }) as any;

    const pgid = await getPgid(99999);
    expect(pgid).toBeNull();
  });

  test("returns null for invalid ps output", async () => {
    const realSpawn = _cleanupDeps.spawn;
    _cleanupDeps.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "ps") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("not-a-number\n").body,
          stderr: new Response("").body,
        };
      }
      return realSpawn(cmd, spawnOpts);
    }) as any;

    const pgid = await getPgid(12345);
    expect(pgid).toBeNull();
  });

  test("handles ps command error gracefully", async () => {
    _cleanupDeps.spawn = mock(() => {
      throw new Error("ps command failed");
    }) as any;

    const pgid = await getPgid(12345);
    expect(pgid).toBeNull();
  });
});

describe("cleanupProcessTree", () => {
  test("cleans up process group with SIGTERM then SIGKILL", async () => {
    const killCalls: Array<{ pid: number; signal: string }> = [];
    const realSpawn = _cleanupDeps.spawn;

    _cleanupDeps.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "ps") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("  12345\n").body,
          stderr: new Response("").body,
        };
      }
      return realSpawn(cmd, spawnOpts);
    }) as any;

    _cleanupDeps.killProcessGroupFn = mock((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal: String(signal) });
      return true;
    }) as any;

    _cleanupDeps.sleep = mock(async () => {}) as any;

    await cleanupProcessTree(12345);

    // Should have called killProcessGroupFn twice: SIGTERM then SIGKILL (positive PID passed in, function handles negation internally)
    expect(killCalls.length).toBe(2);
    expect(killCalls[0]).toEqual({ pid: 12345, signal: "SIGTERM" });
    expect(killCalls[1]).toEqual({ pid: 12345, signal: "SIGKILL" });
  });

  test("handles already-dead process gracefully", async () => {
    const realSpawn = _cleanupDeps.spawn;
    _cleanupDeps.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "ps") {
        return {
          exited: Promise.resolve(1),
          stdout: new Response("").body,
          stderr: new Response("No such process\n").body,
        };
      }
      return realSpawn(cmd, spawnOpts);
    }) as any;

    const killCalls: any[] = [];
    _cleanupDeps.kill = mock((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal });
      return true;
    }) as any;

    await cleanupProcessTree(12345);

    // Should not call kill if process is already dead
    expect(killCalls.length).toBe(0);
  });

  test("handles ESRCH error when sending SIGTERM", async () => {
    const realSpawn = _cleanupDeps.spawn;
    _cleanupDeps.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "ps") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("  12345\n").body,
          stderr: new Response("").body,
        };
      }
      return realSpawn(cmd, spawnOpts);
    }) as any;

    const killCalls: any[] = [];
    _cleanupDeps.killProcessGroupFn = mock((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal });
      const err = new Error("No such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }) as any;
    _cleanupDeps.sleep = mock(async () => {}) as any;

    await cleanupProcessTree(12345);

    // Should attempt SIGTERM, get ESRCH, and return early (no SIGKILL)
    expect(killCalls.length).toBe(1);
    expect(killCalls[0].signal).toBe("SIGTERM");
  });

  test("handles errors during SIGKILL gracefully", async () => {
    const killCalls: any[] = [];
    const realSpawn = _cleanupDeps.spawn;

    _cleanupDeps.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "ps") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("  12345\n").body,
          stderr: new Response("").body,
        };
      }
      return realSpawn(cmd, spawnOpts);
    }) as any;

    _cleanupDeps.killProcessGroupFn = mock((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal });
      if (signal === "SIGKILL") {
        throw new Error("Process already exited");
      }
      return true;
    }) as any;

    _cleanupDeps.sleep = mock(async () => {}) as any;

    // Should not throw despite SIGKILL error
    await cleanupProcessTree(12345);

    expect(killCalls.length).toBe(2);
    expect(killCalls[0].signal).toBe("SIGTERM");
    expect(killCalls[1].signal).toBe("SIGKILL");
  });

  test("logs warning on unexpected cleanup error", async () => {
    const realSpawn = _cleanupDeps.spawn;
    _cleanupDeps.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "ps") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("  12345\n").body,
          stderr: new Response("").body,
        };
      }
      return realSpawn(cmd, spawnOpts);
    }) as any;

    _cleanupDeps.killProcessGroupFn = mock(() => {
      const err = new Error("Unexpected error") as NodeJS.ErrnoException;
      err.code = "EUNKNOWN";
      throw err;
    }) as any;

    // Should log a warning via structured logger but not throw
    await cleanupProcessTree(12345);

    // Test passes if no exception is thrown (warning logged via structured logger)
  });
});
