import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { getPgid, cleanupProcessTree } from "../src/tdd/cleanup";

let originalSpawn: typeof Bun.spawn;
let originalProcessKill: typeof process.kill;

beforeEach(() => {
  originalSpawn = Bun.spawn;
  originalProcessKill = process.kill;
});

afterEach(() => {
  Bun.spawn = originalSpawn;
  process.kill = originalProcessKill;
});

describe("getPgid", () => {
  test("returns PGID for valid process", async () => {
    // Mock ps command to return a PGID
    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "ps" && cmd[1] === "-o" && cmd[2] === "pgid=") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("  12345\n").body,
          stderr: new Response("").body,
        };
      }
      return originalSpawn(cmd, spawnOpts);
    });

    const pgid = await getPgid(12345);
    expect(pgid).toBe(12345);
  });

  test("returns null for non-existent process", async () => {
    // Mock ps command to fail
    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "ps") {
        return {
          exited: Promise.resolve(1),
          stdout: new Response("").body,
          stderr: new Response("No such process\n").body,
        };
      }
      return originalSpawn(cmd, spawnOpts);
    });

    const pgid = await getPgid(99999);
    expect(pgid).toBeNull();
  });

  test("returns null for invalid ps output", async () => {
    // Mock ps command to return non-numeric output
    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "ps") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("not-a-number\n").body,
          stderr: new Response("").body,
        };
      }
      return originalSpawn(cmd, spawnOpts);
    });

    const pgid = await getPgid(12345);
    expect(pgid).toBeNull();
  });

  test("handles ps command error gracefully", async () => {
    // Mock ps command to throw an error
    // @ts-ignore — mocking global
    Bun.spawn = mock(() => {
      throw new Error("ps command failed");
    });

    const pgid = await getPgid(12345);
    expect(pgid).toBeNull();
  });
});

describe("cleanupProcessTree", () => {
  test("cleans up process group with SIGTERM then SIGKILL", async () => {
    const killCalls: Array<{ pid: number; signal: string }> = [];

    // Mock getPgid to return a valid PGID
    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "ps") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("  12345\n").body,
          stderr: new Response("").body,
        };
      }
      return originalSpawn(cmd, spawnOpts);
    });

    // Mock process.kill to track calls
    process.kill = mock((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal: String(signal) });
      return true;
    }) as any;

    // Mock Bun.sleep to avoid actual delays in tests
    const originalSleep = Bun.sleep;
    Bun.sleep = mock(async () => {}) as any;

    try {
      await cleanupProcessTree(12345);

      // Should have called kill twice: SIGTERM then SIGKILL
      expect(killCalls.length).toBe(2);
      expect(killCalls[0]).toEqual({ pid: -12345, signal: "SIGTERM" });
      expect(killCalls[1]).toEqual({ pid: -12345, signal: "SIGKILL" });
    } finally {
      Bun.sleep = originalSleep;
    }
  });

  test("handles already-dead process gracefully", async () => {
    // Mock getPgid to return null (process already dead)
    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "ps") {
        return {
          exited: Promise.resolve(1),
          stdout: new Response("").body,
          stderr: new Response("No such process\n").body,
        };
      }
      return originalSpawn(cmd, spawnOpts);
    });

    const killCalls: any[] = [];
    process.kill = mock((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal });
      return true;
    }) as any;

    await cleanupProcessTree(12345);

    // Should not call kill if process is already dead
    expect(killCalls.length).toBe(0);
  });

  test("handles ESRCH error when sending SIGTERM", async () => {
    // Mock getPgid to return a valid PGID
    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "ps") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("  12345\n").body,
          stderr: new Response("").body,
        };
      }
      return originalSpawn(cmd, spawnOpts);
    });

    // Mock process.kill to throw ESRCH on SIGTERM
    const killCalls: any[] = [];
    process.kill = mock((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal });
      const err = new Error("No such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }) as any;

    await cleanupProcessTree(12345);

    // Should attempt SIGTERM, get ESRCH, and return early (no SIGKILL)
    expect(killCalls.length).toBe(1);
    expect(killCalls[0].signal).toBe("SIGTERM");
  });

  test("handles errors during SIGKILL gracefully", async () => {
    const killCalls: any[] = [];

    // Mock getPgid to return a valid PGID
    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "ps") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("  12345\n").body,
          stderr: new Response("").body,
        };
      }
      return originalSpawn(cmd, spawnOpts);
    });

    // Mock process.kill to succeed on SIGTERM, fail on SIGKILL
    process.kill = mock((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal });
      if (signal === "SIGKILL") {
        throw new Error("Process already exited");
      }
      return true;
    }) as any;

    // Mock Bun.sleep to avoid delays
    const originalSleep = Bun.sleep;
    Bun.sleep = mock(async () => {}) as any;

    try {
      // Should not throw despite SIGKILL error
      await cleanupProcessTree(12345);

      expect(killCalls.length).toBe(2);
      expect(killCalls[0].signal).toBe("SIGTERM");
      expect(killCalls[1].signal).toBe("SIGKILL");
    } finally {
      Bun.sleep = originalSleep;
    }
  });

  test("logs warning on unexpected cleanup error", async () => {
    // Mock getPgid to return a valid PGID, then process.kill throws unexpected error
    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "ps") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("  12345\n").body,
          stderr: new Response("").body,
        };
      }
      return originalSpawn(cmd, spawnOpts);
    });

    // Mock process.kill to throw unexpected error (not ESRCH)
    process.kill = mock(() => {
      const err = new Error("Unexpected error") as NodeJS.ErrnoException;
      err.code = "EUNKNOWN";
      throw err;
    }) as any;

    // Should log a warning via structured logger but not throw
    await cleanupProcessTree(12345);

    // Test passes if no exception is thrown (warning logged via structured logger)
  });
});
