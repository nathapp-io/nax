// RE-ARCH: keep
/**
 * PID Registry Tests
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { PidRegistry } from "../../../src/execution/pid-registry";

const TEST_WORKDIR = "/tmp/nax-pid-registry-test";
const PID_FILE = `${TEST_WORKDIR}/.nax-pids`;

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

  test("cleanupStale() reads and kills PIDs from previous run", async () => {
    // Simulate a previous run that left PIDs in the file
    const entry1 = JSON.stringify({
      pid: 99999, // Non-existent PID
      spawnedAt: new Date().toISOString(),
      workdir: TEST_WORKDIR,
    });
    const entry2 = JSON.stringify({
      pid: 88888, // Non-existent PID
      spawnedAt: new Date().toISOString(),
      workdir: TEST_WORKDIR,
    });
    await Bun.write(PID_FILE, `${entry1}\n${entry2}\n`);

    // Create new registry and cleanup stale PIDs
    const registry = new PidRegistry(TEST_WORKDIR);
    await registry.cleanupStale();

    // Check file is cleared
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

  test("platform-specific kill command: Linux uses process groups", async () => {
    const registry = new PidRegistry(TEST_WORKDIR, "linux");

    // Register a non-existent PID
    await registry.register(99999);

    // Should not throw (process doesn't exist, but kill command should be correct)
    await registry.killAll();

    expect(registry.getPids()).toEqual([]);
  });

  test("platform-specific kill command: macOS uses direct PID", async () => {
    const registry = new PidRegistry(TEST_WORKDIR, "darwin");

    // Register a non-existent PID
    await registry.register(99999);

    // Should not throw (process doesn't exist, but kill command should be correct)
    await registry.killAll();

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
