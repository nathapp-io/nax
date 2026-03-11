/**
 * Concurrent PID registry test — ensure register() doesn't lose PIDs on concurrent calls
 */

import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, afterEach } from "bun:test";
import { PidRegistry } from "../../../src/execution/pid-registry";

describe("PidRegistry - Concurrent Operations", () => {
  let tempDir: string;
  let registry: PidRegistry;

  afterEach(() => {
    if (tempDir && tempDir.startsWith(tmpdir())) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("concurrent register() calls do not lose PIDs", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-pid-race-test-"));
    registry = new PidRegistry(tempDir);

    // Register 50 PIDs concurrently
    const pidCount = 50;
    const pids = Array.from({ length: pidCount }, (_, i) => 1000 + i);

    const registerPromises = pids.map((pid) => registry.register(pid));
    await Promise.all(registerPromises);

    // Read the file and verify all PIDs are present
    const pidsFile = join(tempDir, ".nax-pids");
    const content = readFileSync(pidsFile, "utf-8");
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
    tempDir = mkdtempSync(join(tmpdir(), "nax-pid-seq-test-"));
    registry = new PidRegistry(tempDir);

    // Register PIDs sequentially
    for (let i = 0; i < 20; i++) {
      await registry.register(2000 + i);
    }

    // Verify all PIDs are present
    const pidsFile = join(tempDir, ".nax-pids");
    const content = readFileSync(pidsFile, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());

    expect(lines.length).toBe(20);

    const pids = lines.map((line) => JSON.parse(line).pid);
    for (let i = 0; i < 20; i++) {
      expect(pids).toContain(2000 + i);
    }
  });

  test("unregister removes only specified PID", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-pid-unregister-test-"));
    registry = new PidRegistry(tempDir);

    await registry.register(3000);
    await registry.register(3001);
    await registry.register(3002);

    // Unregister the middle one
    await registry.unregister(3001);

    // Verify only that PID is gone
    const pidsFile = join(tempDir, ".nax-pids");
    const content = readFileSync(pidsFile, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());
    const pids = lines.map((line) => JSON.parse(line).pid);

    expect(pids).toContain(3000);
    expect(pids).not.toContain(3001);
    expect(pids).toContain(3002);
  });
});
