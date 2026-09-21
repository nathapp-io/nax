/**
 * Tests for SpawnAcpClient / SpawnAcpSession argv construction and session
 * lifecycle — the codex effort-suffix handling (Task 4), the onPidSpawned /
 * onPidExited callback family (ADR-013 Phase 3), --cwd on cancel/stop (BUG-3),
 * and timeoutSeconds zero-survival (US-005).
 *
 * Effort suffix: a profile model like "gpt-5.6-luna[high]" is split three ways:
 *   - the bare id rides on every prompt via --model,
 *   - the original string stays on the agent.call_started event so headless and
 *     TUI keep showing the effort,
 *   - the effort is applied once when the session is acquired (Task 4).
 *
 * The option name applied ("reasoning_effort" vs "effort" vs "thought_level") is
 * discovered live from `acpx sessions show --format json`'s config_options
 * (matched by category "thought_level"), with EFFORT_OPTION_BY_AGENT as a
 * fallback when discovery fails. Tests that don't care about discovery reuse
 * the plain ENSURE_JSON mock, which has no config_options and so exercises the
 * fallback path implicitly; tests below assert discovery explicitly.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, withDepsRestore } from "@test/helpers";
import { _spawnClientDeps, createSpawnAcpClient, SpawnAcpClient } from "@/agents";
import { DEFAULT_ACP_TIMEOUT_SECONDS } from "@/agents/acp/spawn-client";
import { SpawnAcpSession } from "@/agents/acp/spawn-client-session";
import type { AgentStreamEvent } from "@/runtime";
import { stubProcessKill } from "./_spawn-client-test-helpers";

const ENSURE_JSON = JSON.stringify({
  action: "session_ensured",
  created: true,
  acpxRecordId: "rec-1",
  acpxSessionId: "sess-1",
  name: "s1",
});

const TURN_JSON = JSON.stringify({ result: "done", stopReason: "end_turn" });

const FIXED_PID = 54321;

/** `sessions show --format json` payload shape acpx returns; only the fields discovery reads. */
function showJson(configOptions: Array<{ id: string; category: string }>): string {
  return JSON.stringify({ acpx: { config_options: configOptions } });
}

const CODEX_SHOW_JSON = showJson([{ id: "reasoning_effort", category: "thought_level" }]);
const CLAUDE_SHOW_JSON = showJson([{ id: "effort", category: "thought_level" }]);
const PI_SHOW_JSON = showJson([{ id: "thought_level", category: "thought_level" }]);
const NO_THOUGHT_LEVEL_SHOW_JSON = showJson([{ id: "mode", category: "mode" }]);

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

/**
 * Route a spawn impl through bun:test's mock(), typed at the dep's full
 * signature so the Mock is assignable to `_spawnClientDeps.spawn` directly.
 */
function setSpawn(impl: typeof _spawnClientDeps.spawn): void {
  _spawnClientDeps.spawn = mock(impl);
}

/** Install a spawn mock that records argv and returns `stdout`. */
function installSpawn(stdout: string, exitCode = 0): void {
  setSpawn((cmd) => {
    calls.push(cmd);
    return makeSpawnResult(exitCode, stdout);
  });
}

/** Install a spawn mock that dispatches a different response per command shape. */
function installDispatchSpawn(dispatch: (cmd: string[]) => { stdout: string; exitCode?: number }): void {
  setSpawn((cmd) => {
    calls.push(cmd);
    const { stdout, exitCode } = dispatch(cmd);
    return makeSpawnResult(exitCode ?? 0, stdout);
  });
}

withDepsRestore(_spawnClientDeps, ["spawn"]);
stubProcessKill();

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

  test("issues set reasoning_effort exactly once when the session is created", async () => {
    const client = new SpawnAcpClient("acpx --model gpt-5.6-luna[high] codex", "/tmp/wd");
    await client.createSession({ agentName: "codex", permissionMode: "approve-all", sessionName: "s1" });

    const sets = calls.filter((c) => c.includes("set"));
    expect(sets).toHaveLength(1);
    expect(sets[0]).toEqual(["acpx", "--cwd", "/tmp/wd", "codex", "set", "reasoning_effort", "high", "-s", "s1"]);
  });

  test("issues set reasoning_effort when a session is loaded", async () => {
    const client = new SpawnAcpClient("acpx --model gpt-5.6-luna[medium] codex", "/tmp/wd");
    await client.loadSession("s1", "codex", "approve-all");

    const sets = calls.filter((c) => c.includes("set"));
    expect(sets).toHaveLength(1);
    expect(sets[0]?.[6]).toBe("medium");
  });

  test("issues no set call when the model carries no suffix", async () => {
    const client = new SpawnAcpClient("acpx --model opus claude", "/tmp/wd");
    await client.createSession({ agentName: "claude", permissionMode: "approve-all", sessionName: "s1" });

    expect(calls.filter((c) => c.includes("set"))).toHaveLength(0);
  });

  test("does not re-issue set on every prompt", async () => {
    const client = new SpawnAcpClient("acpx --model gpt-5.6-luna[high] codex", "/tmp/wd");
    const session = await client.createSession({
      agentName: "codex",
      permissionMode: "approve-all",
      sessionName: "s1",
    });
    expect(calls.filter((c) => c.includes("set"))).toHaveLength(1);

    installSpawn(TURN_JSON);
    await session.prompt("one");
    await session.prompt("two");

    // Still exactly the one from session creation - prompts must not re-issue it.
    expect(calls.filter((c) => c.includes("set"))).toHaveLength(1);
  });

  test("falls back to the claude-specific static option name when discovery yields nothing", async () => {
    const client = new SpawnAcpClient("acpx --model opus[high] claude", "/tmp/wd");
    await client.createSession({ agentName: "claude", permissionMode: "approve-all", sessionName: "s1" });

    const sets = calls.filter((c) => c.includes("set"));
    expect(sets).toHaveLength(1);
    expect(sets[0]).toEqual(["acpx", "--cwd", "/tmp/wd", "claude", "set", "effort", "high", "-s", "s1"]);
  });

  test("falls back to the pi-specific static option name when discovery yields nothing", async () => {
    const client = new SpawnAcpClient("acpx --model pi-model[deep] pi", "/tmp/wd");
    await client.createSession({ agentName: "pi", permissionMode: "approve-all", sessionName: "s1" });

    const sets = calls.filter((c) => c.includes("set"));
    expect(sets).toHaveLength(1);
    expect(sets[0]).toEqual(["acpx", "--cwd", "/tmp/wd", "pi", "set", "thought_level", "deep", "-s", "s1"]);
  });

  test("skips the set call for agents with no known effort option", async () => {
    const client = new SpawnAcpClient("acpx --model g[high] gemini", "/tmp/wd");
    await client.createSession({ agentName: "gemini", permissionMode: "approve-all", sessionName: "s1" });

    expect(calls.filter((c) => c.includes("set"))).toHaveLength(0);
  });

  test("session creation survives a failing set call", async () => {
    setSpawn((cmd) => {
      calls.push(cmd);
      return cmd.includes("set") ? makeSpawnResult(1, "boom") : makeSpawnResult(0, ENSURE_JSON);
    });

    const client = new SpawnAcpClient("acpx --model gpt-5.6-luna[high] codex", "/tmp/wd");
    const session = await client.createSession({
      agentName: "codex",
      permissionMode: "approve-all",
      sessionName: "s1",
    });
    expect(session).toBeDefined();
  });

  describe("live discovery via sessions show", () => {
    /** Route each acpx subcommand to its fixture: ensure/show/set/prompt. */
    function installAgentSpawn(showStdout: string): void {
      installDispatchSpawn((cmd) => {
        if (cmd.includes("show")) return { stdout: showStdout };
        if (cmd.includes("ensure")) return { stdout: ENSURE_JSON };
        return { stdout: TURN_JSON };
      });
    }

    test("uses the discovered id even when it disagrees with the static map", async () => {
      // codex's static fallback is "reasoning_effort" — prove the discovered id wins.
      installAgentSpawn(showJson([{ id: "custom_effort_id", category: "thought_level" }]));

      const client = new SpawnAcpClient("acpx --model gpt-5.6-luna[high] codex", "/tmp/wd");
      await client.createSession({ agentName: "codex", permissionMode: "approve-all", sessionName: "s1" });

      const sets = calls.filter((c) => c.includes("set"));
      expect(sets).toHaveLength(1);
      expect(sets[0]).toEqual(["acpx", "--cwd", "/tmp/wd", "codex", "set", "custom_effort_id", "high", "-s", "s1"]);
    });

    test("discovers the option id for an agent absent from the static map", async () => {
      installAgentSpawn(showJson([{ id: "reasoning_intensity", category: "thought_level" }]));

      const client = new SpawnAcpClient("acpx --model m[high] kimi", "/tmp/wd");
      await client.createSession({ agentName: "kimi", permissionMode: "approve-all", sessionName: "s1" });

      const sets = calls.filter((c) => c.includes("set"));
      expect(sets).toHaveLength(1);
      expect(sets[0]).toEqual(["acpx", "--cwd", "/tmp/wd", "kimi", "set", "reasoning_intensity", "high", "-s", "s1"]);
    });

    test("matches the correct option per agent shape (codex/claude/pi)", async () => {
      for (const [agentName, showStdout, expectedId] of [
        ["codex", CODEX_SHOW_JSON, "reasoning_effort"],
        ["claude", CLAUDE_SHOW_JSON, "effort"],
        ["pi", PI_SHOW_JSON, "thought_level"],
      ] as const) {
        calls = [];
        installAgentSpawn(showStdout);
        const client = new SpawnAcpClient(`acpx --model m[high] ${agentName}`, "/tmp/wd");
        await client.createSession({ agentName, permissionMode: "approve-all", sessionName: "s1" });

        const sets = calls.filter((c) => c.includes("set"));
        expect(sets).toHaveLength(1);
        expect(sets[0]?.[5]).toBe(expectedId);
      }
    });

    test("falls back to the static map when sessions show has no thought_level entry", async () => {
      installAgentSpawn(NO_THOUGHT_LEVEL_SHOW_JSON);

      const client = new SpawnAcpClient("acpx --model m[high] codex", "/tmp/wd");
      await client.createSession({ agentName: "codex", permissionMode: "approve-all", sessionName: "s1" });

      const sets = calls.filter((c) => c.includes("set"));
      expect(sets).toHaveLength(1);
      expect(sets[0]?.[5]).toBe("reasoning_effort");
    });

    test("falls back to the static map when sessions show fails", async () => {
      installDispatchSpawn((cmd) => {
        if (cmd.includes("show")) return { stdout: "boom", exitCode: 1 };
        if (cmd.includes("ensure")) return { stdout: ENSURE_JSON };
        return { stdout: TURN_JSON };
      });

      const client = new SpawnAcpClient("acpx --model m[high] codex", "/tmp/wd");
      await client.createSession({ agentName: "codex", permissionMode: "approve-all", sessionName: "s1" });

      const sets = calls.filter((c) => c.includes("set"));
      expect(sets).toHaveLength(1);
      expect(sets[0]?.[5]).toBe("reasoning_effort");
    });

    test("falls back to the static map when sessions show returns malformed JSON", async () => {
      installAgentSpawn("not json");

      const client = new SpawnAcpClient("acpx --model m[high] codex", "/tmp/wd");
      await client.createSession({ agentName: "codex", permissionMode: "approve-all", sessionName: "s1" });

      const sets = calls.filter((c) => c.includes("set"));
      expect(sets).toHaveLength(1);
      expect(sets[0]?.[5]).toBe("reasoning_effort");
    });

    test("skips entirely when discovery and the static map both come up empty", async () => {
      installAgentSpawn(NO_THOUGHT_LEVEL_SHOW_JSON);

      const client = new SpawnAcpClient("acpx --model m[high] gemini", "/tmp/wd");
      await client.createSession({ agentName: "gemini", permissionMode: "approve-all", sessionName: "s1" });

      expect(calls.filter((c) => c.includes("set"))).toHaveLength(0);
    });

    test("falls back to the static map when the show spawn call rejects outright", async () => {
      // Distinct from a non-zero exit code: this simulates spawn() itself throwing
      // (e.g. a transient process-launch error), which must not propagate out of
      // createSession and abort session acquisition.
      setSpawn((cmd) => {
        calls.push(cmd);
        if (cmd.includes("show")) throw new Error("spawn ENOENT");
        if (cmd.includes("ensure")) return makeSpawnResult(0, ENSURE_JSON);
        return makeSpawnResult(0, TURN_JSON);
      });

      const client = new SpawnAcpClient("acpx --model m[high] codex", "/tmp/wd");
      const session = await client.createSession({
        agentName: "codex",
        permissionMode: "approve-all",
        sessionName: "s1",
      });

      expect(session).toBeDefined();
      const sets = calls.filter((c) => c.includes("set"));
      expect(sets).toHaveLength(1);
      expect(sets[0]?.[5]).toBe("reasoning_effort");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SpawnAcpSession — onPidSpawned callback (ADR-013 Phase 3)
// ─────────────────────────────────────────────────────────────────────────────

describe("SpawnAcpSession — onPidSpawned callback", () => {
  // The file-level beforeEach installs the ENSURE default; this suite prompts
  // sessions directly, so it defaults to a TURN response instead.
  beforeEach(() => {
    _spawnClientDeps.spawn = mock(() => makeSpawnResult(0, TURN_JSON));
  });

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
    const capturedPids: number[] = [];
    const session = makeSession((pid: number) => {
      capturedPids.push(pid);
    });

    await session.prompt("test");

    expect(capturedPids[0]).toBe(FIXED_PID);
  });

  test("onPidSpawned fires BEFORE prompt() resolves", async () => {
    const order: string[] = [];
    let resolveExit!: (code: number) => void;
    const exitPromise = new Promise<number>((r) => {
      resolveExit = r;
    });

    _spawnClientDeps.spawn = mock(() => ({
      ...makeSpawnResult(0, JSON.stringify({ result: "done", stopReason: "end_turn" })),
      exited: exitPromise,
      pid: FIXED_PID,
    }));

    const session = makeSession((pid) => {
      order.push(`callback:${pid}`);
    });

    // Start prompt but resolve exit after the callback should have fired
    const promptPromise = session.prompt("test").then((r: unknown) => {
      order.push("resolved");
      return r;
    });
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
    _spawnClientDeps.spawn = mock(() => makeSpawnResult(0, JSON.stringify({ sessionId: "sess-1", recordId: "rec-1" })));
  });

  test("createSession passes onPidSpawned to the returned SpawnAcpSession", async () => {
    const pids: number[] = [];
    const client = makeClient((pid) => pids.push(pid));
    const session = await client.createSession({ agentName: "claude", permissionMode: "approve-all" });

    // createSession itself fires onPidSpawned once (tracked acpx sessions ensure)
    expect(pids).toHaveLength(1);

    // Now swap spawn to return a prompt response
    _spawnClientDeps.spawn = mock(() => makeSpawnResult(0, JSON.stringify({ result: "done", stopReason: "end_turn" })));

    await session.prompt("hello");
    // prompt() fires onPidSpawned once more
    expect(pids).toHaveLength(2);
    expect(pids[1]).toBe(FIXED_PID);
  });

  test("createSession without callback creates session without callback", async () => {
    const client = makeClient(undefined);
    const session = await client.createSession({ agentName: "claude", permissionMode: "approve-all" });

    _spawnClientDeps.spawn = mock(() => makeSpawnResult(0, JSON.stringify({ result: "ok", stopReason: "end_turn" })));

    const result = await session.prompt("test");
    expect(result.stopReason).toBe("end_turn");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createSpawnAcpClient factory — passes onPidSpawned
// ─────────────────────────────────────────────────────────────────────────────

describe("createSpawnAcpClient factory", () => {
  test("accepts onPidSpawned as fourth argument and threads it to sessions", async () => {
    _spawnClientDeps.spawn = mock(() => makeSpawnResult(0, JSON.stringify({ sessionId: "sid-99", recordId: null })));

    const pids: number[] = [];
    const client = createSpawnAcpClient("acpx --model claude-haiku claude", "/tmp/test", 30, (pid: number) => {
      pids.push(pid);
    });
    const session = await client.createSession({ agentName: "claude", permissionMode: "approve-all" });

    // createSession fires onPidSpawned once (tracked acpx sessions ensure)
    expect(pids).toHaveLength(1);

    _spawnClientDeps.spawn = mock(() => makeSpawnResult(0, JSON.stringify({ result: "done", stopReason: "end_turn" })));
    await session.prompt("go");

    // prompt() fires onPidSpawned once more
    expect(pids).toHaveLength(2);
    expect(pids[1]).toBe(FIXED_PID);
  });

  test("accepts undefined onPidSpawned without error", () => {
    expect(() => createSpawnAcpClient("acpx --model claude-haiku claude", "/tmp/test", 30, undefined)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SpawnAcpSession — --cwd on cancel/stop (BUG-3)
// ─────────────────────────────────────────────────────────────────────────────

describe("SpawnAcpSession — --cwd on cancel/stop (BUG-3)", () => {
  test("close({forceTerminate:true}) spawns `acpx --cwd <cwd> <agentName> stop`", async () => {
    const spawnedCommands: string[][] = [];
    _spawnClientDeps.spawn = (cmd, _opts) => {
      spawnedCommands.push(cmd as string[]);
      return makeSpawnResult(0);
    };

    const client = new SpawnAcpClient("acpx claude", "/tmp/my-worktree");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    assertDefined(session, "session");
    spawnedCommands.length = 0; // drop the loadSession/ensure-session spawn(s)

    await session.close({ forceTerminate: true });

    const stopCall = spawnedCommands.find((c) => c.includes("stop"));
    expect(stopCall).toEqual(["acpx", "--cwd", "/tmp/my-worktree", "claude", "stop"]);
  });

  test("cancelActivePrompt() spawns `acpx --cwd <cwd> <agentName> cancel`", async () => {
    const spawnedCommands: string[][] = [];
    _spawnClientDeps.spawn = (cmd, _opts) => {
      spawnedCommands.push(cmd as string[]);
      return makeSpawnResult(0);
    };

    const client = new SpawnAcpClient("acpx claude", "/tmp/my-worktree");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    assertDefined(session, "session");
    spawnedCommands.length = 0;

    await session.cancelActivePrompt();

    const cancelCall = spawnedCommands.find((c) => c.includes("cancel"));
    expect(cancelCall).toEqual(["acpx", "--cwd", "/tmp/my-worktree", "claude", "cancel"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SpawnAcpClient — timeoutSeconds zero-survival (US-005)
// ─────────────────────────────────────────────────────────────────────────────

describe("SpawnAcpClient — timeoutSeconds zero-survival (#US-005)", () => {
  test("AC8 (success): an explicit timeoutSeconds=0 is preserved on the client", () => {
    const client = new SpawnAcpClient("acpx claude", "/tmp", 0);
    expect(client.timeoutSeconds).toBe(0);
  });

  test("AC8 (default): omitting timeoutSeconds defaults to DEFAULT_ACP_TIMEOUT_SECONDS", () => {
    const client = new SpawnAcpClient("acpx claude", "/tmp");
    expect(client.timeoutSeconds).toBe(DEFAULT_ACP_TIMEOUT_SECONDS);
  });
});
