/**
 * Tests for SpawnAcpClient — spawn-client.ts
 *
 * SEC-3: loadSession() must NOT hardcode "approve-all".
 *        It must use the client's stored permissionMode ("approve-reads" by default).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SpawnAcpClient, _spawnClientDeps } from "../../../../src/agents/acp/spawn-client";

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

describe("SpawnAcpClient — loadSession (SEC-3)", () => {
  let originalSpawn: typeof _spawnClientDeps.spawn;

  beforeEach(() => {
    originalSpawn = _spawnClientDeps.spawn;
  });

  afterEach(() => {
    _spawnClientDeps.spawn = originalSpawn;
  });

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
