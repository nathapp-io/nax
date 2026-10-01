import { describe, expect, mock, test } from "bun:test";
import { makeSpawn, withDepsRestore } from "@test/helpers";
import { _cleanupDeps, cleanupProcessTree, getPgid } from "@/tdd/cleanup";

withDepsRestore(_cleanupDeps, ["spawn", "sleep", "kill", "killProcessGroupFn"]);

describe("getPgid", () => {
  test("returns PGID for valid process", async () => {
    _cleanupDeps.spawn = makeSpawn(({ cmd }) => {
      if (cmd[0] === "ps" && cmd[1] === "-o" && cmd[2] === "pgid=") {
        return { stdout: "  12345\n" };
      }
      return { stdout: "" };
    }).spawn;

    const pgid = await getPgid(12345);
    expect(pgid).toBe(12345);
  });

  test("returns null for non-existent process", async () => {
    _cleanupDeps.spawn = makeSpawn(({ cmd }) => {
      if (cmd[0] === "ps") {
        return { stdout: "", stderr: "No such process\n", exitCode: 1 };
      }
      return { stdout: "" };
    }).spawn;

    const pgid = await getPgid(99999);
    expect(pgid).toBeNull();
  });

  test("returns null for invalid ps output", async () => {
    _cleanupDeps.spawn = makeSpawn(({ cmd }) => {
      if (cmd[0] === "ps") {
        return { stdout: "not-a-number\n" };
      }
      return { stdout: "" };
    }).spawn;

    const pgid = await getPgid(12345);
    expect(pgid).toBeNull();
  });

  test("handles ps command error gracefully", async () => {
    _cleanupDeps.spawn = makeSpawn(() => {
      throw new Error("ps command failed");
    }).spawn;

    const pgid = await getPgid(12345);
    expect(pgid).toBeNull();
  });
});

describe("cleanupProcessTree", () => {
  test("cleans up process group with SIGTERM then SIGKILL", async () => {
    const killCalls: Array<{ pid: number; signal: string }> = [];

    _cleanupDeps.spawn = makeSpawn(({ cmd }) => {
      if (cmd[0] === "ps") {
        return { stdout: "  12345\n" };
      }
      return { stdout: "" };
    }).spawn;

    _cleanupDeps.killProcessGroupFn = mock((pid: number, signal: string | number) => {
      killCalls.push({ pid, signal: String(signal) });
      return true;
    });

    _cleanupDeps.sleep = mock(async () => {});

    await cleanupProcessTree(12345);

    // Should have called killProcessGroupFn twice: SIGTERM then SIGKILL (positive PID passed in, function handles negation internally)
    expect(killCalls.length).toBe(2);
    expect(killCalls[0]).toEqual({ pid: 12345, signal: "SIGTERM" });
    expect(killCalls[1]).toEqual({ pid: 12345, signal: "SIGKILL" });
  });

  test("handles already-dead process gracefully", async () => {
    _cleanupDeps.spawn = makeSpawn(({ cmd }) => {
      if (cmd[0] === "ps") {
        return { stdout: "", stderr: "No such process\n", exitCode: 1 };
      }
      return { stdout: "" };
    }).spawn;

    const killCalls: Array<{ pid: number; signal: string | number }> = [];
    const killImpl: typeof _cleanupDeps.kill = (pid: number, signal?: NodeJS.Signals | number) => {
      killCalls.push({ pid, signal: signal ?? 0 });
      return true;
    };
    _cleanupDeps.kill = mock(killImpl);

    await cleanupProcessTree(12345);

    // Should not call kill if process is already dead
    expect(killCalls.length).toBe(0);
  });

  test("handles ESRCH error when sending SIGTERM", async () => {
    _cleanupDeps.spawn = makeSpawn(({ cmd }) => {
      if (cmd[0] === "ps") {
        return { stdout: "  12345\n" };
      }
      return { stdout: "" };
    }).spawn;

    const killCalls: Array<{ pid: number; signal: string | number }> = [];
    _cleanupDeps.killProcessGroupFn = mock((pid: number, signal: string | number) => {
      killCalls.push({ pid, signal });
      const err = new Error("No such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    _cleanupDeps.sleep = mock(async () => {});

    await cleanupProcessTree(12345);

    // Should attempt SIGTERM, get ESRCH, and return early (no SIGKILL)
    expect(killCalls.length).toBe(1);
    expect(killCalls[0].signal).toBe("SIGTERM");
  });

  test("handles errors during SIGKILL gracefully", async () => {
    const killCalls: Array<{ pid: number; signal: string | number }> = [];

    _cleanupDeps.spawn = makeSpawn(({ cmd }) => {
      if (cmd[0] === "ps") {
        return { stdout: "  12345\n" };
      }
      return { stdout: "" };
    }).spawn;

    _cleanupDeps.killProcessGroupFn = mock((pid: number, signal: string | number) => {
      killCalls.push({ pid, signal });
      if (signal === "SIGKILL") {
        throw new Error("Process already exited");
      }
      return true;
    });

    _cleanupDeps.sleep = mock(async () => {});

    // Should not throw despite SIGKILL error
    await cleanupProcessTree(12345);

    expect(killCalls.length).toBe(2);
    expect(killCalls[0].signal).toBe("SIGTERM");
    expect(killCalls[1].signal).toBe("SIGKILL");
  });

  test("logs warning on unexpected cleanup error", async () => {
    _cleanupDeps.spawn = makeSpawn(({ cmd }) => {
      if (cmd[0] === "ps") {
        return { stdout: "  12345\n" };
      }
      return { stdout: "" };
    }).spawn;

    _cleanupDeps.killProcessGroupFn = mock((): boolean => {
      const err = new Error("Unexpected error") as NodeJS.ErrnoException;
      err.code = "EUNKNOWN";
      throw err;
    });

    // Should log a warning via structured logger but not throw
    await cleanupProcessTree(12345);

    // Test passes if no exception is thrown (warning logged via structured logger)
  });
});
