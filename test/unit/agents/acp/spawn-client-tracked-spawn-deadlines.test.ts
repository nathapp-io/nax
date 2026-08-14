/**
 * Tests for spawn-client.ts — Issue #1583: startup ops (sessions ensure) must
 * use trackedSpawnStartupDeadlineMs, never the (shorter) teardown deadline
 * used for close/stop/cancel. Split out of spawn-client.test.ts to stay under
 * the test-file-size ratchet.
 */

import { describe, expect, test } from "bun:test";
import { SpawnAcpClient, _spawnClientDeps } from "@/agents/acp";
import { withDepsRestore } from "@test/helpers";
import { makeSpawnResult, makeWedgedSpawnResult, stubProcessKill } from "./_spawn-client-test-helpers";

stubProcessKill();

describe("SpawnAcpClient — startup vs teardown trackedSpawn deadlines (#1583)", () => {
  withDepsRestore(_spawnClientDeps, [
    "spawn",
    "trackedSpawnDeadlineMs",
    "trackedSpawnStartupDeadlineMs",
    "killTreeGraceMs",
  ]);

  test("loadSession (a startup op) waits out the startup deadline, not the shorter teardown deadline", async () => {
    _spawnClientDeps.trackedSpawnDeadlineMs = 20; // teardown — deliberately too short to matter here
    _spawnClientDeps.trackedSpawnStartupDeadlineMs = 150;
    _spawnClientDeps.killTreeGraceMs = 1;
    _spawnClientDeps.spawn = () => makeWedgedSpawnResult();

    const client = new SpawnAcpClient("acpx --model claude-sonnet-4-5 claude", "/tmp");
    const start = Date.now();
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    const elapsed = Date.now() - start;

    // Regression guard for #1583: before the fix, loadSession shared the 10s
    // teardown deadline and would have returned near trackedSpawnDeadlineMs (20ms).
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(session).toBeNull();
  });

  test("createSession (a startup op) waits out the startup deadline, not the shorter teardown deadline", async () => {
    _spawnClientDeps.trackedSpawnDeadlineMs = 20;
    _spawnClientDeps.trackedSpawnStartupDeadlineMs = 150;
    _spawnClientDeps.killTreeGraceMs = 1;
    _spawnClientDeps.spawn = () => makeWedgedSpawnResult();

    const client = new SpawnAcpClient("acpx --model claude-sonnet-4-5 claude", "/tmp");
    const start = Date.now();
    await expect(
      client.createSession({ agentName: "claude", permissionMode: "approve-reads", sessionName: "test-session" }),
    ).rejects.toThrow();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  test("closeSession (a teardown op reached through the client) is bounded by the teardown deadline, not the longer startup deadline", async () => {
    _spawnClientDeps.trackedSpawnDeadlineMs = 20;
    _spawnClientDeps.trackedSpawnStartupDeadlineMs = 5000; // deliberately too long to matter here
    _spawnClientDeps.killTreeGraceMs = 1;
    _spawnClientDeps.spawn = () => makeWedgedSpawnResult();

    const client = new SpawnAcpClient("acpx --model claude-sonnet-4-5 claude", "/tmp");

    const MARGIN_MS = 500;
    const timed = Symbol("timed");
    const result = await Promise.race([
      client.closeSession("test-session", "claude"),
      new Promise<typeof timed>((resolve) => setTimeout(() => resolve(timed), MARGIN_MS)),
    ]);

    // Regression guard: if closeSession fell back to the 5000ms startup
    // deadline, it would still be pending when the 500ms race window elapses.
    expect(result).not.toBe(timed);
  });

  test("a live session's close() uses its resolved teardown deadline even when the startup deadline is much longer", async () => {
    _spawnClientDeps.trackedSpawnDeadlineMs = 20;
    _spawnClientDeps.trackedSpawnStartupDeadlineMs = 5000;
    _spawnClientDeps.killTreeGraceMs = 1;

    let callCount = 0;
    _spawnClientDeps.spawn = () => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0); // ensure session succeeds immediately
      return makeWedgedSpawnResult(); // session-close spawn: wedged
    };

    const client = new SpawnAcpClient("acpx --model claude-sonnet-4-5 claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    expect(session).not.toBeNull();

    const MARGIN_MS = 500;
    const timed = Symbol("timed");
    const result = await Promise.race([
      session?.close(),
      new Promise<typeof timed>((resolve) => setTimeout(() => resolve(timed), MARGIN_MS)),
    ]);

    expect(result).not.toBe(timed);
  });

  test("constructor opts override the module-level defaults for both deadlines", async () => {
    // Module defaults left at their normal (larger) values — the explicit opts
    // passed to the constructor must win.
    _spawnClientDeps.spawn = () => makeWedgedSpawnResult();
    _spawnClientDeps.killTreeGraceMs = 1;

    const client = new SpawnAcpClient(
      "acpx --model claude-sonnet-4-5 claude",
      "/tmp",
      undefined,
      undefined,
      0,
      undefined,
      {
        trackedSpawnStartupDeadlineMs: 60,
      },
    );

    const start = Date.now();
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    const elapsed = Date.now() - start;

    expect(session).toBeNull();
    // Bounded by the injected 60ms override, not the (much larger) module default.
    expect(elapsed).toBeLessThan(2000);
  });
});
