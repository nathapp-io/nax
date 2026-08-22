/**
 * Concurrent PID registry test — ensure register() doesn't lose PIDs on concurrent calls
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PidRegistry } from "@/execution/pid-registry";
import { makeTempDir } from "@test/helpers";

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
