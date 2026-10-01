/**
 * Shared low-level spawn-result stubs for spawn-client*.test.ts files.
 * Local (underscore-prefixed) helper, not test/helpers/ — these mock the raw
 * Bun.spawn() result shape used only by the ACP spawn-client test suite, not
 * one of the domain types (IAgentManager, NaxConfig, ...) test/helpers/ covers.
 */

import { afterEach, beforeEach } from "bun:test";
import type { _spawnClientDeps } from "@/agents/acp";

/**
 * SAFETY: cancelActivePrompt()/close() call killProcessGroup, which hits the
 * REAL process.kill(-pid, signal) unless stubbed. Several tests in this suite
 * exercise these paths with fake PIDs — without this stub, any test lacking
 * its own local override can send a real signal to the host. Stub
 * process.kill for every test in the calling file, unconditionally, and
 * restore the true original after each test.
 */
export function stubProcessKill(): void {
  let original: typeof process.kill;

  beforeEach(() => {
    original = process.kill;
    process.kill = ((_pid: number | string, _signal?: NodeJS.Signals | number) => true) as typeof process.kill;
  });

  afterEach(() => {
    process.kill = original;
  });
}

export function makeSpawnResult(exitCode: number, stdout = ""): ReturnType<typeof _spawnClientDeps.spawn> {
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

/** Spawn mock that never exits — simulates a wedged/slow acpx subprocess. */
export function makeWedgedSpawnResult(): ReturnType<typeof _spawnClientDeps.spawn> {
  return {
    stdout: new ReadableStream<Uint8Array>({ start() {} }),
    stderr: new ReadableStream<Uint8Array>({ start() {} }),
    stdin: { write: () => 0, end: () => {}, flush: () => {} },
    exited: new Promise<number>(() => {}),
    pid: 99999999,
    kill: () => {},
  };
}
