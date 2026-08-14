/**
 * MEM-1: stderr buffering cap in SpawnAcpClient
 *
 * Full stderr was buffered via `new Response(proc.stderr).text()` and became
 * the response content on failure. A verbose agent can emit many MB — the
 * buffered stderr must be capped to a rolling tail so failure responses stay
 * bounded.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SpawnAcpClient, _spawnClientDeps } from "@/agents/acp";
import { withDepsRestore } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// SAFETY: file-scope process.kill stub (mirrors spawn-client.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

let _originalProcessKill: typeof process.kill;

beforeEach(() => {
  _originalProcessKill = process.kill;
  process.kill = ((_pid: number | string, _signal?: NodeJS.Signals | number) => true) as typeof process.kill;
});

afterEach(() => {
  process.kill = _originalProcessKill;
});

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
    pid: 99999999,
    kill: () => {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("SpawnAcpClient — MEM-1: stderr buffering cap", () => {
  withDepsRestore(_spawnClientDeps, ["spawn"]);

  test("caps buffered stderr on failure responses (rolling tail, not full buffer)", async () => {
    let callCount = 0;
    const enc = new TextEncoder();

    const hugeStderr = "verbose agent noise line\n".repeat(20_000); // ~460KB

    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0); // ensure session

      return {
        stdout: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
        stderr: new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(enc.encode(hugeStderr)); c.close(); },
        }),
        stdin: { write: () => 0, end: () => {}, flush: () => {} },
        exited: Promise.resolve(1),
        pid: 99999999,
        kill: () => {},
      };
    };

    const client = new SpawnAcpClient("acpx claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    const response = await session!.prompt("hello");

    expect(response.stopReason).toBe("error");
    const content = response.messages[0]?.content ?? "";
    expect(content.length).toBeLessThan(hugeStderr.length);
    // Rolling tail: the final bytes (the actual error) survive.
    expect(content.endsWith("verbose agent noise line\n")).toBe(true);
  });

  test("small stderr passes through unchanged", async () => {
    let callCount = 0;
    const enc = new TextEncoder();

    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0); // ensure session

      return {
        stdout: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
        stderr: new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(enc.encode("connection refused")); c.close(); },
        }),
        stdin: { write: () => 0, end: () => {}, flush: () => {} },
        exited: Promise.resolve(1),
        pid: 99999999,
        kill: () => {},
      };
    };

    const client = new SpawnAcpClient("acpx claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    const response = await session!.prompt("hello");
    expect(response.messages[0]?.content).toBe("connection refused");
  });
});
