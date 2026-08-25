/**
 * Tests for codex effort-suffix handling in SpawnAcpClient.
 *
 * A profile model like "gpt-5.6-luna[high]" is split three ways:
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
