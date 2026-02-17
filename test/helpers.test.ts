import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { formatProgress, acquireLock, releaseLock } from "../src/execution/helpers";
import type { StoryCounts } from "../src/execution/helpers";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn } from "bun";

describe("formatProgress", () => {
  test("formats progress with all stories pending", () => {
    const counts: StoryCounts = {
      total: 12,
      passed: 0,
      failed: 0,
      pending: 12,
    };

    const progress = formatProgress(counts, 0, 5.0, 0, 12);

    expect(progress).toContain("0/12 stories");
    expect(progress).toContain("✅ 0 passed");
    expect(progress).toContain("❌ 0 failed");
    expect(progress).toContain("$0.00/$5.00");
    expect(progress).toContain("calculating...");
  });

  test("formats progress with some stories completed", () => {
    const counts: StoryCounts = {
      total: 12,
      passed: 5,
      failed: 1,
      pending: 6,
    };

    // 10 minutes elapsed (600000 ms), 6 stories completed
    // avg = 600000 / 6 = 100000 ms per story
    // remaining = 6 stories * 100000 = 600000 ms = 10 minutes
    const progress = formatProgress(counts, 0.45, 5.0, 600000, 12);

    expect(progress).toContain("6/12 stories");
    expect(progress).toContain("✅ 5 passed");
    expect(progress).toContain("❌ 1 failed");
    expect(progress).toContain("$0.45/$5.00");
    expect(progress).toContain("~10 min remaining");
  });

  test("formats progress when all stories are complete", () => {
    const counts: StoryCounts = {
      total: 12,
      passed: 10,
      failed: 2,
      pending: 0,
    };

    const progress = formatProgress(counts, 1.23, 5.0, 1200000, 12);

    expect(progress).toContain("12/12 stories");
    expect(progress).toContain("✅ 10 passed");
    expect(progress).toContain("❌ 2 failed");
    expect(progress).toContain("$1.23/$5.00");
    expect(progress).toContain("complete");
  });

  test("calculates ETA correctly for fast stories", () => {
    const counts: StoryCounts = {
      total: 20,
      passed: 10,
      failed: 0,
      pending: 10,
    };

    // 2 minutes elapsed (120000 ms) for 10 stories
    // avg = 120000 / 10 = 12000 ms per story
    // remaining = 10 stories * 12000 = 120000 ms = 2 minutes
    const progress = formatProgress(counts, 0.5, 10.0, 120000, 20);

    expect(progress).toContain("~2 min remaining");
  });

  test("rounds ETA to nearest minute", () => {
    const counts: StoryCounts = {
      total: 10,
      passed: 3,
      failed: 0,
      pending: 7,
    };

    // 8.5 minutes elapsed (510000 ms) for 3 stories
    // avg = 510000 / 3 = 170000 ms per story
    // remaining = 7 stories * 170000 = 1190000 ms ≈ 19.8 minutes → rounds to 20
    const progress = formatProgress(counts, 0.3, 5.0, 510000, 10);

    expect(progress).toContain("~20 min remaining");
  });

  test("includes cost information with proper formatting", () => {
    const counts: StoryCounts = {
      total: 5,
      passed: 2,
      failed: 0,
      pending: 3,
    };

    const progress = formatProgress(counts, 1.2345, 10.0, 300000, 5);

    // Should round cost to 2 decimal places
    expect(progress).toContain("$1.23/$10.00");
  });

  test("handles zero elapsed time gracefully", () => {
    const counts: StoryCounts = {
      total: 10,
      passed: 0,
      failed: 0,
      pending: 10,
    };

    const progress = formatProgress(counts, 0, 5.0, 0, 10);

    expect(progress).toContain("calculating...");
    expect(progress).not.toContain("NaN");
    expect(progress).not.toContain("Infinity");
  });

  test("includes all required emoji indicators", () => {
    const counts: StoryCounts = {
      total: 10,
      passed: 3,
      failed: 1,
      pending: 6,
    };

    const progress = formatProgress(counts, 0.5, 5.0, 300000, 10);

    expect(progress).toContain("📊"); // Progress emoji
    expect(progress).toContain("✅"); // Passed emoji
    expect(progress).toContain("❌"); // Failed emoji
    expect(progress).toContain("💰"); // Cost emoji
    expect(progress).toContain("⏱️"); // Time emoji
  });
});

describe("acquireLock and releaseLock", () => {
  const testDir = path.join(import.meta.dir, ".test-locks");
  const lockPath = path.join(testDir, "nax.lock");

  beforeEach(() => {
    // Create clean test directory
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    rmSync(testDir, { recursive: true, force: true });
  });

  test("acquires lock when no lock file exists", async () => {
    const acquired = await acquireLock(testDir);
    expect(acquired).toBe(true);

    // Verify lock file was created
    const lockFile = Bun.file(lockPath);
    expect(await lockFile.exists()).toBe(true);

    // Verify lock file contains current PID
    const lockContent = await lockFile.text();
    const lockData = JSON.parse(lockContent);
    expect(lockData.pid).toBe(process.pid);
    expect(typeof lockData.timestamp).toBe("number");

    await releaseLock(testDir);
  });

  test("fails to acquire lock when another process holds it", async () => {
    // First process acquires lock
    const acquired1 = await acquireLock(testDir);
    expect(acquired1).toBe(true);

    // Second process tries to acquire lock
    const acquired2 = await acquireLock(testDir);
    expect(acquired2).toBe(false);

    await releaseLock(testDir);
  });

  test("releases lock successfully", async () => {
    await acquireLock(testDir);
    await releaseLock(testDir);

    // Verify lock file was deleted
    const lockFile = Bun.file(lockPath);
    expect(await lockFile.exists()).toBe(false);
  });

  test("can re-acquire lock after release", async () => {
    const acquired1 = await acquireLock(testDir);
    expect(acquired1).toBe(true);

    await releaseLock(testDir);

    const acquired2 = await acquireLock(testDir);
    expect(acquired2).toBe(true);

    await releaseLock(testDir);
  });

  test("removes stale lock when process is dead", async () => {
    // Create a lock file with a fake PID that doesn't exist
    const stalePid = 999999; // Very unlikely to be a real process
    const staleLock = {
      pid: stalePid,
      timestamp: Date.now() - 60000, // 1 minute ago
    };
    await Bun.write(lockPath, JSON.stringify(staleLock));

    // Try to acquire lock - should detect stale lock and remove it
    const acquired = await acquireLock(testDir);
    expect(acquired).toBe(true);

    // Verify new lock file has current PID
    const lockFile = Bun.file(lockPath);
    const lockContent = await lockFile.text();
    const lockData = JSON.parse(lockContent);
    expect(lockData.pid).toBe(process.pid);

    await releaseLock(testDir);
  });

  test("detects stale lock from OOM-killed process", async () => {
    // Spawn a short-lived child process
    const proc = spawn({
      cmd: ["sleep", "0.1"],
      stdout: "pipe",
      stderr: "pipe",
    });

    // Get the child PID
    const childPid = proc.pid;

    // Wait for it to exit
    await proc.exited;

    // Create a lock file with the dead child's PID
    const staleLock = {
      pid: childPid,
      timestamp: Date.now() - 60000, // 1 minute ago
    };
    await Bun.write(lockPath, JSON.stringify(staleLock));

    // Now try to acquire lock - should detect child process is dead
    const acquired = await acquireLock(testDir);
    expect(acquired).toBe(true);

    // Verify new lock has current PID
    const lockFile = Bun.file(lockPath);
    const lockContent = await lockFile.text();
    const lockData = JSON.parse(lockContent);
    expect(lockData.pid).toBe(process.pid);

    await releaseLock(testDir);
  });

  test("does not remove lock when process is still alive", async () => {
    // Create lock with current process PID
    const validLock = {
      pid: process.pid,
      timestamp: Date.now() - 60000, // 1 minute ago
    };
    await Bun.write(lockPath, JSON.stringify(validLock));

    // Try to acquire lock - should NOT remove it since process is alive
    const acquired = await acquireLock(testDir);
    expect(acquired).toBe(false);

    // Verify lock still exists with same PID
    const lockFile = Bun.file(lockPath);
    const lockContent = await lockFile.text();
    const lockData = JSON.parse(lockContent);
    expect(lockData.pid).toBe(process.pid);
  });

  test("handles corrupted lock file gracefully", async () => {
    // Create invalid JSON lock file
    await Bun.write(lockPath, "not valid json");

    // Should fail to acquire but not crash
    const acquired = await acquireLock(testDir);
    expect(acquired).toBe(false);
  });

  test("handles release when lock file doesn't exist", async () => {
    // Should not throw when releasing non-existent lock
    await expect(releaseLock(testDir)).resolves.toBeUndefined();
  });
});
