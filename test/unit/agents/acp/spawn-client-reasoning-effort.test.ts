/**
 * Tests for codex effort-suffix handling in SpawnAcpClient.
 *
 * A profile model like "gpt-5.6-luna[high]" is split three ways:
 *   - the bare id rides on every prompt via --model,
 *   - the original string stays on the agent.call_started event so headless and
 *     TUI keep showing the effort,
 *   - the effort is applied once when the session is acquired (Task 4).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { SpawnAcpClient, _spawnClientDeps } from "@/agents";
import type { AgentStreamEvent } from "@/runtime";
import { withDepsRestore } from "@test/helpers";

const ENSURE_JSON = JSON.stringify({
  action: "session_ensured",
  created: true,
  acpxRecordId: "rec-1",
  acpxSessionId: "sess-1",
  name: "s1",
});

const TURN_JSON = JSON.stringify({ result: "done", stopReason: "end_turn" });

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
    pid: 4321,
    kill: () => {},
  } as ReturnType<typeof _spawnClientDeps.spawn>;
}

/**
 * Every argv array passed to spawn, in order.
 *
 * Captured explicitly rather than read off `mock.calls`: no other test in this
 * repo relies on `mock.calls`, and an explicit array keeps accumulating across a
 * mid-test mock reassignment, which the "not per prompt" test depends on.
 */
let calls: string[][] = [];

/** Install a spawn mock that records argv and returns `stdout`. */
function installSpawn(stdout: string, exitCode = 0): void {
  _spawnClientDeps.spawn = mock((cmd: string[]) => {
    calls.push(cmd);
    return makeSpawnResult(exitCode, stdout);
  }) as unknown as typeof _spawnClientDeps.spawn;
}

withDepsRestore(_spawnClientDeps, ["spawn"]);

beforeEach(() => {
  calls = [];
  installSpawn(ENSURE_JSON);
});

afterEach(() => {
  mock.restore();
});

describe("SpawnAcpClient - effort suffix", () => {
  test("sends the bare model id on prompts, not the bracket form", async () => {
    const client = new SpawnAcpClient("acpx --model gpt-5.6-luna[high] codex", "/tmp/wd");
    const session = await client.createSession({
      agentName: "codex",
      permissionMode: "approve-all",
      sessionName: "s1",
    });

    installSpawn(TURN_JSON);
    await session.prompt("hello");

    const promptCall = calls.find((c) => c.includes("prompt"));
    expect(promptCall).toBeDefined();
    const modelIdx = (promptCall as string[]).indexOf("--model");
    expect((promptCall as string[])[modelIdx + 1]).toBe("gpt-5.6-luna");
  });

  test("keeps the effort on the call_started event for headless and TUI", async () => {
    const events: AgentStreamEvent[] = [];
    const client = new SpawnAcpClient(
      "acpx --model gpt-5.6-luna[high] codex",
      "/tmp/wd",
      undefined,
      undefined,
      undefined,
      undefined,
      { onStreamActivity: (e: AgentStreamEvent) => events.push(e) },
    );
    const session = await client.createSession({
      agentName: "codex",
      permissionMode: "approve-all",
      sessionName: "s1",
    });

    installSpawn(TURN_JSON);
    await session.prompt("hello");

    const started = events.find((e) => e.kind === "agent.call_started");
    expect(started).toBeDefined();
    expect((started as { model: string }).model).toBe("gpt-5.6-luna[high]");
  });

  test("leaves a suffix-free model untouched in both argv and event", async () => {
    const events: AgentStreamEvent[] = [];
    const client = new SpawnAcpClient(
      "acpx --model opus claude",
      "/tmp/wd",
      undefined,
      undefined,
      undefined,
      undefined,
      { onStreamActivity: (e: AgentStreamEvent) => events.push(e) },
    );
    const session = await client.createSession({
      agentName: "claude",
      permissionMode: "approve-all",
      sessionName: "s1",
    });

    installSpawn(TURN_JSON);
    await session.prompt("hello");

    const promptCall = calls.find((c) => c.includes("prompt")) as string[];
    expect(promptCall[promptCall.indexOf("--model") + 1]).toBe("opus");
    const started = events.find((e) => e.kind === "agent.call_started");
    expect((started as { model: string }).model).toBe("opus");
  });
});
