/**
 * Tests for SpawnAcpSession / SpawnAcpClient — ADR-013 Phase 3
 *
 * Phase 3 replaces AgentRunOptions.pidRegistry with onPidSpawned?: (pid: number) => void.
 * The adapter fires the callback immediately after spawning, before awaiting the process.
 *
 * Covered:
 *   - onPidSpawned fires when SpawnAcpSession.prompt() spawns a process
 *   - Callback receives the spawned PID
 *   - Callback fires BEFORE prompt() resolves (timing guarantee)
 *   - SpawnAcpClient.createSession() passes onPidSpawned to the session
 *   - createSpawnAcpClient factory passes onPidSpawned to the client
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { SpawnAcpClient, SpawnAcpSession, _spawnClientDeps, createSpawnAcpClient } from "../../../../src/agents/acp/spawn-client";
import { withDepsRestore } from "../../../helpers/deps";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_PID = 54321;

function makeSpawnResult(exitCode = 0, stdout = ""): ReturnType<typeof _spawnClientDeps.spawn> {
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
    pid: FIXED_PID,
    kill: () => {},
  };
}

withDepsRestore(_spawnClientDeps, ["spawn"]);

beforeEach(() => {
  _spawnClientDeps.spawn = mock(() => makeSpawnResult(0, JSON.stringify({ result: "done", stopReason: "end_turn" })));
});

afterEach(() => {
  mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// SpawnAcpSession — onPidSpawned callback
// ─────────────────────────────────────────────────────────────────────────────

describe("SpawnAcpSession — onPidSpawned callback", () => {
  function makeSession(onPidSpawned?: (pid: number) => void): SpawnAcpSession {
    return new SpawnAcpSession({
      agentName: "claude",
      sessionName: "test-session",
      cwd: "/tmp/test",
      model: "claude-haiku",
      timeoutSeconds: 30,
      promptRetries: 0,
      permissionMode: "approve-all",
      env: {},
      onPidSpawned,
    });
  }

  test("onPidSpawned fires when prompt() spawns a process", async () => {
    const pids: number[] = [];
    const session = makeSession((pid) => pids.push(pid));

    await session.prompt("do something");

    expect(pids).toHaveLength(1);
    expect(pids[0] as number).toBe(FIXED_PID);
  });

  test("onPidSpawned receives the process PID", async () => {
    let capturedPid: number | null = null;
    const session = makeSession((pid: number) => { capturedPid = pid; });

    await session.prompt("test");

    expect(capturedPid as number).toBe(FIXED_PID);
  });

  test("onPidSpawned fires BEFORE prompt() resolves", async () => {
    const order: string[] = [];
    let resolveExit!: (code: number) => void;
    const exitPromise = new Promise<number>((r) => { resolveExit = r; });

    _spawnClientDeps.spawn = mock(() => ({
      ...makeSpawnResult(0, JSON.stringify({ result: "done", stopReason: "end_turn" })),
      exited: exitPromise,
      pid: FIXED_PID,
    }));

    const session = makeSession((pid) => {
      order.push(`callback:${pid}`);
    });

    // Start prompt but resolve exit after the callback should have fired
    const promptPromise = session.prompt("test").then((r: unknown) => { order.push("resolved"); return r; });
    // Give the microtask queue a turn so spawn fires
    await Promise.resolve();
    order.push("pre-exit");
    resolveExit(0);
    await promptPromise;

    expect(order[0]).toBe(`callback:${FIXED_PID}`);
    expect(order[order.length - 1]).toBe("resolved");
  });

  test("works when onPidSpawned is undefined (no crash)", async () => {
    const session = makeSession(undefined);
    const result = await session.prompt("do something");
    expect(result.stopReason).toBe("end_turn");
  });

  test("onPidExited fires after prompt() resolves and pairs with onPidSpawned", async () => {
    const events: string[] = [];
    const session = new SpawnAcpSession({
      agentName: "claude",
      sessionName: "test-session",
      cwd: "/tmp/test",
      model: "claude-haiku",
      timeoutSeconds: 30,
      promptRetries: 0,
      permissionMode: "approve-all",
      env: {},
      onPidSpawned: (pid) => events.push(`spawn:${pid}`),
      onPidExited: (pid) => events.push(`exit:${pid}`),
    });

    await session.prompt("do something");

    expect(events).toEqual([`spawn:${FIXED_PID}`, `exit:${FIXED_PID}`]);
  });

  test("onPidExited fires exactly once even when prompt() throws", async () => {
    // Make the spawned proc fail with a non-zero exit
    _spawnClientDeps.spawn = mock(() => ({
      ...makeSpawnResult(1, ""),
      pid: FIXED_PID,
    }));

    const exits: number[] = [];
    const session = new SpawnAcpSession({
      agentName: "claude",
      sessionName: "test-session",
      cwd: "/tmp/test",
      model: "claude-haiku",
      timeoutSeconds: 30,
      promptRetries: 0,
      permissionMode: "approve-all",
      env: {},
      onPidExited: (pid) => exits.push(pid),
    });

    // prompt() with non-zero exit returns an error response (doesn't throw),
    // but we still expect the exit callback to fire exactly once.
    await session.prompt("test");
    expect(exits).toEqual([FIXED_PID]);
  });

  test("onPidExited tolerates a throwing callback without breaking prompt()", async () => {
    let exitCalls = 0;
    const session = new SpawnAcpSession({
      agentName: "claude",
      sessionName: "test-session",
      cwd: "/tmp/test",
      model: "claude-haiku",
      timeoutSeconds: 30,
      promptRetries: 0,
      permissionMode: "approve-all",
      env: {},
      onPidExited: () => {
        exitCalls++;
        throw new Error("registry write failed");
      },
    });

    // Even if onPidExited throws, prompt() must still resolve normally —
    // unregistration is best-effort.
    const result = await session.prompt("do something");
    expect(result.stopReason).toBe("end_turn");
    expect(exitCalls).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SpawnAcpClient — propagates onPidSpawned to sessions
// ─────────────────────────────────────────────────────────────────────────────

describe("SpawnAcpClient — propagates onPidSpawned to sessions", () => {
  function makeClient(onPidSpawned?: (pid: number) => void): SpawnAcpClient {
    return new SpawnAcpClient("acpx --model claude-haiku claude", "/tmp/test", 30, onPidSpawned);
  }

  beforeEach(() => {
    // Make trackedSpawn return a valid session-ensure response
    _spawnClientDeps.spawn = mock(() =>
      makeSpawnResult(0, JSON.stringify({ sessionId: "sess-1", recordId: "rec-1" })),
    );
  });

  test("createSession passes onPidSpawned to the returned SpawnAcpSession", async () => {
    const pids: number[] = [];
    const client = makeClient((pid) => pids.push(pid));
    const session = await client.createSession({ agentName: "claude", permissionMode: "approve-all" });

    // Now swap spawn to return a prompt response
    _spawnClientDeps.spawn = mock(() =>
      makeSpawnResult(0, JSON.stringify({ result: "done", stopReason: "end_turn" })),
    );

    await session.prompt("hello");
    expect(pids).toHaveLength(1);
    expect(pids[0]).toBe(FIXED_PID);
  });

  test("createSession without callback creates session without callback", async () => {
    const client = makeClient(undefined);
    const session = await client.createSession({ agentName: "claude", permissionMode: "approve-all" });

    _spawnClientDeps.spawn = mock(() =>
      makeSpawnResult(0, JSON.stringify({ result: "ok", stopReason: "end_turn" })),
    );

    const result = await session.prompt("test");
    expect(result.stopReason).toBe("end_turn");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createSpawnAcpClient factory — passes onPidSpawned
// ─────────────────────────────────────────────────────────────────────────────

describe("createSpawnAcpClient factory", () => {
  test("accepts onPidSpawned as fourth argument and threads it to sessions", async () => {
    _spawnClientDeps.spawn = mock(() =>
      makeSpawnResult(0, JSON.stringify({ sessionId: "sid-99", recordId: null })),
    );

    const pids: number[] = [];
    const client = createSpawnAcpClient(
      "acpx --model claude-haiku claude",
      "/tmp/test",
      30,
      (pid: number) => { pids.push(pid); },
    );
    const session = await client.createSession({ agentName: "claude", permissionMode: "approve-all" });

    _spawnClientDeps.spawn = mock(() =>
      makeSpawnResult(0, JSON.stringify({ result: "done", stopReason: "end_turn" })),
    );
    await session.prompt("go");

    expect(pids).toHaveLength(1);
    expect(pids[0]).toBe(FIXED_PID);
  });

  test("accepts undefined onPidSpawned without error", () => {
    expect(() =>
      createSpawnAcpClient("acpx --model claude-haiku claude", "/tmp/test", 30, undefined),
    ).not.toThrow();
  });
});
