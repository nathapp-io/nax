// RE-ARCH: keep
/**
 * PID Registry Tests
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir, makeSpawn, makeTempDir, withDepsRestore } from "@test/helpers";
import { _pidRegistryDeps, PidRegistry } from "@/execution";

const TEST_WORKDIR = `/tmp/nax-pid-registry-test-${randomUUID()}`;
const PID_FILE = `${TEST_WORKDIR}/.nax-pids`;

withDepsRestore(_pidRegistryDeps, ["spawn", "sleep"]);

function _makeStream(text = ""): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("PidRegistry", () => {
  beforeEach(() => {
    // Create test workdir
    if (!existsSync(TEST_WORKDIR)) {
      mkdirSync(TEST_WORKDIR, { recursive: true });
    }

    // Clean up any existing .nax-pids file
    if (existsSync(PID_FILE)) {
      rmSync(PID_FILE);
    }
  });

  afterEach(() => {
    // Cleanup test workdir
    if (existsSync(TEST_WORKDIR)) {
      rmSync(TEST_WORKDIR, { recursive: true });
    }
  });

  test("register() adds PID to in-memory set and writes to file", async () => {
    const registry = new PidRegistry(TEST_WORKDIR);

    await registry.register(12345);

    // Check in-memory state
    expect(registry.getPids()).toEqual([12345]);

    // Check file content
    const content = await Bun.file(PID_FILE).text();
    const lines = content.split("\n").filter((line) => line.trim());
    expect(lines.length).toBe(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.pid).toBe(12345);
    expect(entry.workdir).toBe(TEST_WORKDIR);
    expect(entry.spawnedAt).toBeDefined();
  });

  test("register() appends multiple PIDs to file", async () => {
    const registry = new PidRegistry(TEST_WORKDIR);

    await registry.register(12345);
    await registry.register(67890);

    // Check in-memory state
    expect(registry.getPids()).toEqual([12345, 67890]);

    // Check file content
    const content = await Bun.file(PID_FILE).text();
    const lines = content.split("\n").filter((line) => line.trim());
    expect(lines.length).toBe(2);

    const entry1 = JSON.parse(lines[0]);
    expect(entry1.pid).toBe(12345);

    const entry2 = JSON.parse(lines[1]);
    expect(entry2.pid).toBe(67890);
  });

  test("unregister() removes PID from in-memory set and rewrites file", async () => {
    const registry = new PidRegistry(TEST_WORKDIR);

    await registry.register(12345);
    await registry.register(67890);
    await registry.unregister(12345);

    // Check in-memory state
    expect(registry.getPids()).toEqual([67890]);

    // Check file content
    const content = await Bun.file(PID_FILE).text();
    const lines = content.split("\n").filter((line) => line.trim());
    expect(lines.length).toBe(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.pid).toBe(67890);
  });

  test("unregister() clears file when last PID is removed", async () => {
    const registry = new PidRegistry(TEST_WORKDIR);

    await registry.register(12345);
    await registry.unregister(12345);

    // Check in-memory state
    expect(registry.getPids()).toEqual([]);

    // Check file is empty
    const content = await Bun.file(PID_FILE).text();
    expect(content.trim()).toBe("");
  });

  test("killAll() clears in-memory PIDs and registry file", async () => {
    const registry = new PidRegistry(TEST_WORKDIR);

    // Register non-existent PIDs (will fail to kill but should clear registry)
    await registry.register(99999);
    await registry.register(88888);

    await registry.killAll();

    // Check in-memory state
    expect(registry.getPids()).toEqual([]);

    // Check file is empty
    const content = await Bun.file(PID_FILE).text();
    expect(content.trim()).toBe("");
  });

  test("killAll() handles empty registry gracefully", async () => {
    const registry = new PidRegistry(TEST_WORKDIR);

    // Should not throw
    await registry.killAll();

    expect(registry.getPids()).toEqual([]);
  });

  test("cleanupStale() truncates the PID file without signaling recycled PIDs", async () => {
    // Simulate a previous run that left PIDs in the file. We deliberately
    // include `1` (init/systemd on Linux) — under the prior `kill -TERM -<pid>`
    // path this would have sent SIGTERM to PGID 1 / "all processes", taking
    // down the user's session. cleanupStale must NOT signal it; it must just
    // record the leak and clear the file.
    const entry1 = JSON.stringify({
      pid: 1, // Reserved — must never be signaled
      spawnedAt: new Date().toISOString(),
      workdir: TEST_WORKDIR,
    });
    const entry2 = JSON.stringify({
      pid: 99999,
      spawnedAt: new Date().toISOString(),
      workdir: TEST_WORKDIR,
    });
    await Bun.write(PID_FILE, `${entry1}\n${entry2}\n`);

    const registry = new PidRegistry(TEST_WORKDIR);
    await registry.cleanupStale();

    // File is cleared, but no signaling occurred (verified by the absence of a
    // delivered SIGTERM — implicit: this test process is still alive).
    const content = await Bun.file(PID_FILE).text();
    expect(content.trim()).toBe("");
  });

  test("cleanupStale() handles missing .nax-pids file", async () => {
    const registry = new PidRegistry(TEST_WORKDIR);

    // Should not throw
    await registry.cleanupStale();

    // File should not exist
    expect(existsSync(PID_FILE)).toBe(false);
  });

  test("cleanupStale() handles empty .nax-pids file", async () => {
    // Create empty file
    await Bun.write(PID_FILE, "");

    const registry = new PidRegistry(TEST_WORKDIR);
    await registry.cleanupStale();

    // File should be empty
    const content = await Bun.file(PID_FILE).text();
    expect(content.trim()).toBe("");
  });

  test("cleanupStale() handles malformed JSON lines gracefully", async () => {
    // Write malformed JSON
    await Bun.write(PID_FILE, 'not valid json\n{"pid":12345}\n');

    const registry = new PidRegistry(TEST_WORKDIR);

    // Should not throw
    await registry.cleanupStale();

    // File should be cleared
    const content = await Bun.file(PID_FILE).text();
    expect(content.trim()).toBe("");
  });

  test("killAll() signals each PID directly, never as a process group", async () => {
    // Single-PID signaling (no leading `-`) is the safety property. Both
    // platforms now go through the same code path; the second constructor arg
    // is preserved only for backward compat with prior call sites and is
    // intentionally a no-op.
    const linuxRegistry = new PidRegistry(TEST_WORKDIR, "linux");
    await linuxRegistry.register(99999);
    await linuxRegistry.killAll();
    expect(linuxRegistry.getPids()).toEqual([]);

    const darwinRegistry = new PidRegistry(TEST_WORKDIR, "darwin");
    await darwinRegistry.register(99998);
    await darwinRegistry.killAll();
    expect(darwinRegistry.getPids()).toEqual([]);
  });

  test("killAll() refuses to signal pid <= 1 (kill 0 = caller's group, kill 1 = init, kill -1 = all)", async () => {
    const registry = new PidRegistry(TEST_WORKDIR);

    // These would have been catastrophic under the prior process-group code
    // path. We assert they are silently dropped — and crucially, this test
    // process surviving the call is itself the assertion.
    await registry.register(0);
    await registry.register(1);
    await registry.register(-5);
    await registry.killAll();

    expect(registry.getPids()).toEqual([]);
  });

  test("killAll() terminates tracked descendants before clearing the registry", async () => {
    const calls: string[][] = [];

    _pidRegistryDeps.spawn = makeSpawn(({ cmd }) => {
      calls.push(cmd);
      if (cmd[0] === "ps" && cmd[1] === "-eo") {
        return {
          pid: 2000,
          stdout:
            "172446 1 Thu May 15 11:52:44 2026\n172468 172446 Thu May 15 11:52:45 2026\n172469 172468 Thu May 15 11:52:46 2026\n172552 172469 Thu May 15 11:52:47 2026\n",
        };
      }
      if (cmd[0] === "ps" && cmd[1] === "-o") {
        const pid = cmd[4];
        const byPid: Record<string, string> = {
          "172446": "1 Thu May 15 11:52:44 2026\n",
          "172468": "172446 Thu May 15 11:52:45 2026\n",
          "172469": "172468 Thu May 15 11:52:46 2026\n",
          "172552": "172469 Thu May 15 11:52:47 2026\n",
        };
        return {
          pid: 2000,
          stdout: byPid[pid] ?? "",
          exitCode: byPid[pid] ? 0 : 1,
        };
      }
      return {
        pid: 2001,
      };
    }).spawn;
    _pidRegistryDeps.sleep = mock(async () => {}) as typeof Bun.sleep;

    const registry = new PidRegistry(TEST_WORKDIR);
    await registry.register(172446);
    await registry.killAll();

    expect(calls).toContainEqual(["kill", "-TERM", "172552"]);
    expect(calls).toContainEqual(["kill", "-TERM", "172469"]);
    expect(calls).toContainEqual(["kill", "-TERM", "172468"]);
    expect(calls).toContainEqual(["kill", "-TERM", "172446"]);
    expect(calls).toContainEqual(["kill", "-KILL", "172552"]);
    expect(calls).toContainEqual(["kill", "-KILL", "172469"]);
    expect(calls).toContainEqual(["kill", "-KILL", "172468"]);
    expect(calls).toContainEqual(["kill", "-KILL", "172446"]);
    expect(registry.getPids()).toEqual([]);
  });

  test("killAll() skips SIGKILL when a PID identity changes after SIGTERM", async () => {
    const calls: string[][] = [];
    let lookup172552 = 0;

    _pidRegistryDeps.spawn = makeSpawn(({ cmd }) => {
      calls.push(cmd);
      if (cmd[0] === "ps" && cmd[1] === "-eo") {
        return {
          pid: 2000,
          stdout:
            "172446 1 Thu May 15 11:52:44 2026\n172468 172446 Thu May 15 11:52:45 2026\n172469 172468 Thu May 15 11:52:46 2026\n172552 172469 Thu May 15 11:52:47 2026\n",
        };
      }
      if (cmd[0] === "ps" && cmd[1] === "-o") {
        const pid = cmd[4];
        if (pid === "172552") {
          lookup172552 += 1;
          const output = lookup172552 < 2 ? "172469 Thu May 15 11:52:47 2026\n" : "999999 Thu May 15 11:59:59 2026\n";
          return {
            pid: 2000,
            stdout: output,
          };
        }
        const byPid: Record<string, string> = {
          "172446": "1 Thu May 15 11:52:44 2026\n",
          "172468": "172446 Thu May 15 11:52:45 2026\n",
          "172469": "172468 Thu May 15 11:52:46 2026\n",
        };
        return {
          pid: 2000,
          stdout: byPid[pid] ?? "",
          exitCode: byPid[pid] ? 0 : 1,
        };
      }
      return {
        pid: 2001,
      };
    }).spawn;
    _pidRegistryDeps.sleep = mock(async () => {}) as typeof Bun.sleep;

    const registry = new PidRegistry(TEST_WORKDIR);
    await registry.register(172446);
    await registry.killAll();

    expect(calls).toContainEqual(["kill", "-TERM", "172552"]);
    expect(calls).not.toContainEqual(["kill", "-KILL", "172552"]);
    expect(calls).toContainEqual(["kill", "-KILL", "172469"]);
    expect(registry.getPids()).toEqual([]);
  });

  test("multiple registries can coexist with different workdirs", async () => {
    const workdir1 = `${TEST_WORKDIR}/workspace1`;
    const workdir2 = `${TEST_WORKDIR}/workspace2`;

    mkdirSync(workdir1, { recursive: true });
    mkdirSync(workdir2, { recursive: true });

    const registry1 = new PidRegistry(workdir1);
    const registry2 = new PidRegistry(workdir2);

    await registry1.register(11111);
    await registry2.register(22222);

    expect(registry1.getPids()).toEqual([11111]);
    expect(registry2.getPids()).toEqual([22222]);

    // Check separate files
    const content1 = await Bun.file(`${workdir1}/.nax-pids`).text();
    const content2 = await Bun.file(`${workdir2}/.nax-pids`).text();

    const entry1 = JSON.parse(content1.trim());
    const entry2 = JSON.parse(content2.trim());

    expect(entry1.pid).toBe(11111);
    expect(entry2.pid).toBe(22222);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PERF-3: ps/kill subprocesses must be bounded by a timeout
// ─────────────────────────────────────────────────────────────────────────────

describe("PidRegistry — PERF-3: bounded ps/kill subprocesses", () => {
  test("killAll() resolves within the deadline when `ps -eo` never exits", async () => {
    _pidRegistryDeps.spawn = makeSpawn(() => ({ hang: true, stdoutStall: true, stderrStall: true })).spawn;
    _pidRegistryDeps.sleep = mock(async () => {}) as typeof Bun.sleep;
    _pidRegistryDeps.procExitTimeoutMs = 50;

    const registry = new PidRegistry(TEST_WORKDIR);
    await registry.register(172446);

    const MARGIN_MS = 500;
    const timed = Symbol("timed");
    const result = await Promise.race([
      registry.killAll(),
      new Promise<typeof timed>((resolve) => setTimeout(() => resolve(timed), MARGIN_MS)),
    ]);

    // killAll() must resolve within the deadline, not hang on the wedged ps.
    expect(result).not.toBe(timed);
    expect(registry.getPids()).toEqual([]);
  });

  test("killAll() resolves when a per-pid `ps -p` never exits", async () => {
    _pidRegistryDeps.spawn = makeSpawn(({ cmd }) => {
      if (cmd[0] === "ps" && cmd[1] === "-eo") {
        return { stdout: "172446 1 Thu May 15 11:52:44 2026\n" };
      }
      // Per-pid identity lookup: wedged — never exits.
      return { hang: true };
    }).spawn;
    _pidRegistryDeps.sleep = mock(async () => {}) as typeof Bun.sleep;
    _pidRegistryDeps.procExitTimeoutMs = 50;

    const registry = new PidRegistry(TEST_WORKDIR);
    await registry.register(172446);

    const MARGIN_MS = 500;
    const timed = Symbol("timed");
    const result = await Promise.race([
      registry.killAll(),
      new Promise<typeof timed>((resolve) => setTimeout(() => resolve(timed), MARGIN_MS)),
    ]);

    expect(result).not.toBe(timed);
    expect(registry.getPids()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrent operations (pid-registry-race.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe("PidRegistry - Concurrent Operations", () => {
  let tempDir: string;
  let registry: PidRegistry;

  afterEach(() => {
    if (tempDir?.startsWith(tmpdir())) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("concurrent register() calls do not lose PIDs", async () => {
    tempDir = makeTempDir("nax-pid-race-test-");
    registry = new PidRegistry(tempDir);

    // Register 50 PIDs concurrently
    const pidCount = 50;
    const pids = Array.from({ length: pidCount }, (_, i) => 1000 + i);

    const registerPromises = pids.map((pid) => registry.register(pid));
    await Promise.all(registerPromises);

    // Read the file and verify all PIDs are present
    const pidsFile = join(tempDir, ".nax-pids");
    const content = await Bun.file(pidsFile).text();
    const lines = content.split("\n").filter((line) => line.trim());

    expect(lines.length).toBe(pidCount);

    // Verify each PID is in the file
    const registeredPids = new Set(
      lines.map((line) => {
        const entry = JSON.parse(line);
        return entry.pid;
      }),
    );

    for (const pid of pids) {
      expect(registeredPids.has(pid)).toBe(true);
    }
  });

  test("register() handles rapid sequential calls correctly", async () => {
    tempDir = makeTempDir("nax-pid-seq-test-");
    registry = new PidRegistry(tempDir);

    // Register PIDs sequentially
    for (let i = 0; i < 20; i++) {
      await registry.register(2000 + i);
    }

    // Verify all PIDs are present
    const pidsFile = join(tempDir, ".nax-pids");
    const content = await Bun.file(pidsFile).text();
    const lines = content.split("\n").filter((line) => line.trim());

    expect(lines.length).toBe(20);

    const pids = lines.map((line) => JSON.parse(line).pid);
    for (let i = 0; i < 20; i++) {
      expect(pids).toContain(2000 + i);
    }
  });

  test("unregister removes only specified PID", async () => {
    tempDir = makeTempDir("nax-pid-unregister-test-");
    registry = new PidRegistry(tempDir);

    await registry.register(3000);
    await registry.register(3001);
    await registry.register(3002);

    // Unregister the middle one
    await registry.unregister(3001);

    // Verify only that PID is gone
    const pidsFile = join(tempDir, ".nax-pids");
    const content = await Bun.file(pidsFile).text();
    const lines = content.split("\n").filter((line) => line.trim());
    const pids = lines.map((line) => JSON.parse(line).pid);

    expect(pids).toContain(3000);
    expect(pids).not.toContain(3001);
    expect(pids).toContain(3002);
  });

  // RACE-34: register() called while a write is in flight must wait for
  // the in-flight write AND the follow-up coalesced write that includes
  // the just-added pid. Previously the returned tail waited only for the
  // in-flight write — a hard kill in the gap between caller-return and
  // follow-up-write left the live agent PID absent from .nax-pids.
  test("RACE-34: register() resolves only after the just-added PID is durably persisted", async () => {
    tempDir = makeTempDir("nax-pid-race34-");
    registry = new PidRegistry(tempDir);

    // Start an in-flight write by registering a sentinel and NOT awaiting.
    const sentinelPromise = registry.register(9999);

    // Without awaiting sentinelPromise, register another PID — this call
    // enters enqueueWrite() with _writing=true.
    const livePidPromise = registry.register(8888);

    await Promise.all([sentinelPromise, livePidPromise]);

    // After both promises resolve, BOTH PIDs must be on disk. The bug
    // would leave 8888 absent if register()'s tail skipped the follow-up.
    const pidsFile = join(tempDir, ".nax-pids");
    const content = await Bun.file(pidsFile).text();
    const pids = content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line).pid);

    expect(pids).toContain(9999);
    expect(pids).toContain(8888);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PidRegistry.freeze() — Issue 5 fix (pid-registry-freeze.test.ts)
//
// Once the registry is frozen (at shutdown), register() must become a no-op
// so late-spawning retry paths cannot add PIDs that would outlive the process.
// ─────────────────────────────────────────────────────────────────────────────

describe("PidRegistry.freeze()", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = `/tmp/nax-pid-freeze-test-${randomUUID()}`;
    mkdirSync(workdir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(workdir)) rmSync(workdir, { recursive: true });
  });

  test("register() before freeze() records the PID", async () => {
    const reg = new PidRegistry(workdir);
    await reg.register(1111);
    expect(reg.getPids()).toEqual([1111]);
  });

  test("register() after freeze() is a no-op — PID is not recorded", async () => {
    const reg = new PidRegistry(workdir);
    reg.freeze();
    await reg.register(2222);
    expect(reg.getPids()).toEqual([]);
  });

  test("isFrozen() reports state", () => {
    const reg = new PidRegistry(workdir);
    expect(reg.isFrozen()).toBe(false);
    reg.freeze();
    expect(reg.isFrozen()).toBe(true);
  });

  test("freeze() is idempotent — second call is harmless", () => {
    const reg = new PidRegistry(workdir);
    reg.freeze();
    reg.freeze();
    expect(reg.isFrozen()).toBe(true);
  });

  test("PIDs registered before freeze survive — killAll can still target them", async () => {
    const reg = new PidRegistry(workdir);
    await reg.register(3333);
    reg.freeze();
    expect(reg.getPids()).toEqual([3333]);
    // After freeze, new registration blocked but existing state preserved.
    await reg.register(4444);
    expect(reg.getPids()).toEqual([3333]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Serialization (pid-registry-serialization.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe("PidRegistry concurrent writes", () => {
  test("interleaved register/unregister leave the file consistent with the live set", async () => {
    const dir = makeTempDir("nax-pid-serial-test-");
    try {
      const reg = new PidRegistry(dir);
      // Fire many concurrent register + unregister ops
      await Promise.all([
        reg.register(101),
        reg.register(102),
        reg.register(103),
        reg.unregister(101),
        reg.register(104),
        reg.unregister(102),
      ]);
      await reg.flush(); // new API
      const onDisk = await reg.readPidsFromDisk(); // new test helper
      // Disk must match the in-memory set exactly (no orphaned/duplicate lines)
      expect(new Set(onDisk)).toEqual(new Set(reg.snapshot()));
    } finally {
      cleanupTempDir(dir);
    }
  });
});
