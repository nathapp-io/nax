/**
 * Tests for SpawnAcpClient — spawn-client.ts
 *
 * SEC-3: loadSession() must NOT hardcode "approve-all".
 *        It must use the client's stored permissionMode ("approve-reads" by default).
 */

import { describe, expect, test } from "bun:test";
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

/**
 * Spawn mock where process exit resolves only after stdout starts being consumed.
 * This reproduces deadlock-prone ordering: awaiting proc.exited before draining
 * stdout can hang forever.
 */
function makeExitDependsOnStdoutRead(stdout = ""): ReturnType<typeof _spawnClientDeps.spawn> {
  const enc = new TextEncoder();
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  let opened = false;
  const stdoutStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opened) return;
      opened = true;
      resolveExit(0);
      if (stdout) controller.enqueue(enc.encode(stdout));
      controller.close();
    },
  });

  return {
    stdout: stdoutStream,
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    stdin: { write: () => 0, end: () => {}, flush: () => {} },
    exited,
    pid: 12345,
    kill: () => {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// onPidSpawned callback — Phase 3 (ADR-013)
// onPidSpawned fires for prompt() spawns only. Short-lived trackedSpawn
// operations (sessions ensure/close/cancel) complete in <1s and don't need
// crash-recovery tracking — the in-flight window is too narrow to matter.
// ─────────────────────────────────────────────────────────────────────────────

describe("SpawnAcpClient — onPidSpawned callback (#228)", () => {
  withDepsRestore(_spawnClientDeps, ["spawn"]);

  test("closeSession does not throw when close command fails", async () => {
    _spawnClientDeps.spawn = (_cmd, _opts) => makeSpawnResult(1);

    const client = new SpawnAcpClient("acpx claude", "/tmp");
    await expect(client.closeSession("missing-session", "claude")).resolves.toBeUndefined();
  });

  test("onPidSpawned does NOT fire during createSession (short-lived trackedSpawn)", async () => {
    _spawnClientDeps.spawn = (_cmd, _opts) => makeSpawnResult(0);

    const pids: number[] = [];
    const client = new SpawnAcpClient("acpx claude", "/tmp", undefined, (pid) => pids.push(pid));
    await client.createSession({ agentName: "claude", permissionMode: "approve-reads" });

    expect(pids).toHaveLength(0);
  });

  test("onPidSpawned does NOT fire during closeSession (short-lived trackedSpawn)", async () => {
    _spawnClientDeps.spawn = (_cmd, _opts) => makeSpawnResult(0);

    const pids: number[] = [];
    const client = new SpawnAcpClient("acpx claude", "/tmp", undefined, (pid) => pids.push(pid));
    await client.closeSession("test-session", "claude");

    expect(pids).toHaveLength(0);
  });
});

describe("SpawnAcpClient — prompt EPIPE resilience", () => {
  withDepsRestore(_spawnClientDeps, ["spawn"]);

  test("prompt survives EPIPE on stdin write (acpx exits before nax writes stdin)", async () => {
    let callCount = 0;
    const enc = new TextEncoder();

    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0); // ensure session

      // Second call: acpx exits immediately, stdin.write throws EPIPE
      return {
        stdout: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
        stderr: new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(enc.encode("connection failed")); c.close(); }
        }),
        stdin: {
          write: () => { throw new Error("EPIPE: broken pipe"); },
          end: () => {},
          flush: () => {},
        },
        exited: Promise.resolve(1),
        pid: 12345,
        kill: () => {},
      };
    };

    const client = new SpawnAcpClient("acpx claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    expect(session).not.toBeNull();

    // Must not throw — EPIPE is swallowed, error response from exit code returned
    const response = await session!.prompt("hello");
    expect(response.stopReason).toBe("error");
    expect(response.messages[0]?.content).toContain("connection failed");
  });

  test("prompt survives stdin.end() throwing EPIPE after successful write", async () => {
    let callCount = 0;

    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0);

      const enc = new TextEncoder();
      return {
        stdout: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
        stderr: new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(enc.encode("write error")); c.close(); }
        }),
        stdin: {
          write: () => 0,
          end: () => { throw new Error("EPIPE: broken pipe"); },
          flush: () => {},
        },
        exited: Promise.resolve(1),
        pid: 12345,
        kill: () => {},
      };
    };

    const client = new SpawnAcpClient("acpx claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    const response = await session!.prompt("hello");
    expect(response.stopReason).toBe("error");
  });
});

describe("SpawnAcpClient — stream drain resilience", () => {
  withDepsRestore(_spawnClientDeps, ["spawn", "streamDrainTimeoutMs"]);

  test("prompt returns error response when stdout stream emits an error (not throw)", async () => {
    let callCount = 0;
    const enc = new TextEncoder();

    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0); // ensure session

      // stdout emits an error mid-stream (e.g. acpx runtime crash)
      const errStream = new ReadableStream<Uint8Array>({
        start(c) { c.error(new Error("stream error")); },
      });
      const stderrStream = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(enc.encode("acpx crashed")); c.close(); },
      });
      return {
        stdout: errStream,
        stderr: stderrStream,
        stdin: { write: () => 0, end: () => {}, flush: () => {} },
        exited: Promise.resolve(1),
        pid: 12345,
        kill: () => {},
      };
    };

    const client = new SpawnAcpClient("acpx claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    expect(session).not.toBeNull();

    // .catch(() => "") guards must swallow the stream error — prompt resolves, not rejects
    const response = await session!.prompt("hello");
    expect(response.stopReason).toBe("error");
  });

  test("prompt completes within drain timeout when stdout stream never closes (Bun stream hang bug)", async () => {
    let callCount = 0;

    // Use a short drain timeout so the test doesn't take 5 s
    _spawnClientDeps.streamDrainTimeoutMs = 80;

    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0); // ensure session

      // stdout never closes — simulates Bun stream hang after SIGTERM
      const hangingStream = new ReadableStream<Uint8Array>({ start() { /* never closes */ } });
      return {
        stdout: hangingStream,
        stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
        stdin: { write: () => 0, end: () => {}, flush: () => {} },
        exited: Promise.resolve(1),
        pid: 12345,
        kill: () => {},
      };
    };

    const client = new SpawnAcpClient("acpx claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    expect(session).not.toBeNull();

    const MARGIN_MS = 500;
    const timed = Symbol("timed");
    const result = await Promise.race([
      session!.prompt("hello"),
      new Promise<typeof timed>((resolve) =>
        setTimeout(() => resolve(timed), _spawnClientDeps.streamDrainTimeoutMs + MARGIN_MS),
      ),
    ]);

    // prompt() must resolve within drain timeout — not hang indefinitely
    expect(result).not.toBe(timed);
    if (result !== timed) {
      expect(result.stopReason).toBe("error");
    }
  });
});

describe("SpawnAcpClient — loadSession (SEC-3)", () => {
  withDepsRestore(_spawnClientDeps, ["spawn"]);

  test("loadSession returns a session when ensure succeeds", async () => {
    _spawnClientDeps.spawn = (_cmd, _opts) =>
      makeSpawnResult(0);

    const client = new SpawnAcpClient("acpx --model claude-sonnet-4-5 claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    expect(session).not.toBeNull();
  });

  test("loadSession returns null when ensure fails", async () => {
    _spawnClientDeps.spawn = (_cmd, _opts) =>
      makeSpawnResult(1);

    const client = new SpawnAcpClient("acpx --model claude-sonnet-4-5 claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
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
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    expect(session).not.toBeNull();

    if (session) {
      await session.prompt("hello");
    }

    expect(capturedCmd).not.toContain("--approve-all");
  });

  test("prompt drains stdout/stderr concurrently with process exit (deadlock regression)", async () => {
    let callCount = 0;
    const promptOutput = JSON.stringify({ result: "done" });

    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) {
        // First call: ensure session
        return makeSpawnResult(0);
      }
      // Second call: prompt where exit depends on stdout consumption
      return makeExitDependsOnStdoutRead(promptOutput);
    };

    const client = new SpawnAcpClient("acpx --model claude-sonnet-4-5 claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    expect(session).not.toBeNull();

    const timed = Symbol("timed");
    const result = await Promise.race([
      session!.prompt("hello"),
      new Promise<typeof timed>((resolve) => setTimeout(() => resolve(timed), 200)),
    ]);

    expect(result).not.toBe(timed);
    if (result !== timed) {
      expect(result.stopReason).toBe("end_turn");
      expect(result.messages[0]?.content).toBe("done");
    }
  });
});
