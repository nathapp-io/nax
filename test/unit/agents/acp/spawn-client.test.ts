/**
 * Tests for SpawnAcpClient — spawn-client.ts
 *
 * SEC-3: loadSession() must NOT hardcode "approve-all".
 *        It must use the client's stored permissionMode ("approve-reads" by default).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SpawnAcpClient, _spawnClientDeps } from "../../../../src/agents/acp/spawn-client";
import { withDepsRestore } from "../../../helpers/deps";

// ─────────────────────────────────────────────────────────────────────────────
// Spawn mock helper
// ─────────────────────────────────────────────────────────────────────────────

function makeSpawnResult(exitCode: number, stdout = ""): ReturnType<typeof _spawnClientDeps.spawn> {
  const enc = new TextEncoder();
  const makeStream = (content: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        if (content) c.enqueue(enc.encode(content));
        c.close();
      },
    });

  return {
    stdout: makeStream(stdout),
    stderr: makeStream(""),
    stdin: { write: () => 0, end: () => {}, flush: () => {} },
    exited: Promise.resolve(exitCode),
    pid: 12345,
    kill: () => {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// PID registry mock helper
// ─────────────────────────────────────────────────────────────────────────────

function makeMockPidRegistry() {
  const registered = new Set<number>();
  return {
    registered,
    register: async (pid: number) => { registered.add(pid); },
    unregister: async (pid: number) => { registered.delete(pid); },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PID registration tests (#228)
// ─────────────────────────────────────────────────────────────────────────────

describe("SpawnAcpClient — PID registration (#228)", () => {
  withDepsRestore(_spawnClientDeps, ["spawn"]);

  test("createSession registers and unregisters PID with pidRegistry", async () => {
    _spawnClientDeps.spawn = (_cmd, _opts) => makeSpawnResult(0);

    const registry = makeMockPidRegistry();
    const client = new SpawnAcpClient("acpx claude", "/tmp", undefined, registry as never);
    await client.createSession({ agentName: "claude", permissionMode: "approve-reads" });

    // PID should be unregistered after spawn completes
    expect(registry.registered.size).toBe(0);
  });

  test("loadSession registers and unregisters PID with pidRegistry", async () => {
    _spawnClientDeps.spawn = (_cmd, _opts) => makeSpawnResult(0);

    const registry = makeMockPidRegistry();
    const client = new SpawnAcpClient("acpx claude", "/tmp", undefined, registry as never);
    await client.loadSession("test-session", "claude", "approve-reads");

    expect(registry.registered.size).toBe(0);
  });

  test("session.close registers and unregisters PID with pidRegistry", async () => {
    let callCount = 0;
    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      return makeSpawnResult(0);
    };

    const registry = makeMockPidRegistry();
    const client = new SpawnAcpClient("acpx claude", "/tmp", undefined, registry as never);
    const session = await client.createSession({ agentName: "claude", permissionMode: "approve-reads" });
    await session.close();

    // All PIDs should be unregistered after close completes
    expect(registry.registered.size).toBe(0);
  });

  test("session.cancelActivePrompt registers and unregisters PID with pidRegistry", async () => {
    let callCount = 0;
    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      return makeSpawnResult(0);
    };

    const registry = makeMockPidRegistry();
    const client = new SpawnAcpClient("acpx claude", "/tmp", undefined, registry as never);
    const session = await client.createSession({ agentName: "claude", permissionMode: "approve-reads" });
    await session.cancelActivePrompt();

    expect(registry.registered.size).toBe(0);
  });
});

describe("SpawnAcpClient — loadSession (SEC-3)", () => {
  withDepsRestore(_spawnClientDeps, ["spawn"]);

  test("loadSession returns a session when ensure succeeds", async () => {
    _spawnClientDeps.spawn = (_cmd, _opts) =>
      makeSpawnResult(0);

    const client = new SpawnAcpClient("acpx --model claude-sonnet-4-5 claude", "/tmp");
    const session = await client.loadSession("test-session", "claude");
    expect(session).not.toBeNull();
  });

  test("loadSession returns null when ensure fails", async () => {
    _spawnClientDeps.spawn = (_cmd, _opts) =>
      makeSpawnResult(1);

    const client = new SpawnAcpClient("acpx --model claude-sonnet-4-5 claude", "/tmp");
    const session = await client.loadSession("test-session", "claude");
    expect(session).toBeNull();
  });

  test("session from loadSession does not use --approve-all in prompt command (SEC-3)", async () => {
    let callCount = 0;
    let capturedCmd: string[] = [];
    const promptOutput = JSON.stringify({ result: "done" });

    _spawnClientDeps.spawn = (cmd, _opts) => {
      callCount++;
      if (callCount === 1) {
        // First call: ensure session
        return makeSpawnResult(0);
      }
      // Second call: prompt
      capturedCmd = [...cmd];
      return makeSpawnResult(0, promptOutput);
    };

    const client = new SpawnAcpClient("acpx --model claude-sonnet-4-5 claude", "/tmp");
    const session = await client.loadSession("test-session", "claude");
    expect(session).not.toBeNull();

    if (session) {
      await session.prompt("hello");
    }

    expect(capturedCmd).not.toContain("--approve-all");
  });
});
