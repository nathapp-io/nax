/**
 * runAgentHook — one agent hook execution (US-003).
 *
 * Almost every case spawns a real script: the unit under test IS the spawn
 * pattern (argv with no shell, the payload on stdin, the cwd, the process-group
 * deadline, the bounded drain) plus the exit-code → AgentHookRun mapping, and a
 * mocked subprocess would assert the mock rather than that pattern. The trust
 * cases stub `_runAgentHookDeps.assertTrusted`, because the test preload trusts
 * the filesystem root and no real refusal is reachable from a temp dir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, waitForCondition, withDebugSpy, withDepsRestore } from "@test/helpers";
import { NaxError } from "@/errors";
import {
  _runAgentHookDeps,
  AGENT_HOOK_DRAIN_MS,
  AGENT_HOOK_HANDLER_MARGIN_MS,
  AGENT_HOOK_KILL_GRACE_MS,
  type AgentHookEntry,
  type AgentHookRun,
  runAgentHook,
} from "@/hooks";

/** A payload shaped like the native loop's (US-004/US-005 build the real one). */
const PAYLOAD = {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "ls -la" },
} as const;

let dir = "";

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(() => cleanupTempDir(dir));

/** A global entry, so no trust check is involved unless a case asks for one. */
function makeEntry(overrides: Partial<AgentHookEntry> = {}): AgentHookEntry {
  return { command: "true", scope: ["chat", "run"], timeoutMs: 30_000, origin: "global", ...overrides };
}

/** Write an executable /bin/sh script into the test dir and return its path. */
function scriptFile(body: string, name = "hook.sh"): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** The argv-mode command line that runs `path`; quoted, since a temp path may contain a space. */
function runScript(path: string, args = ""): string {
  return `'${path}'${args ? ` ${args}` : ""}`;
}

/** Is `pid` still a live process? Signal 0 probes without delivering anything. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read the pid a script wrote to `path`, asserting it looks like a real child pid. */
async function readPid(path: string): Promise<number> {
  const pid = Number((await Bun.file(path).text()).trim());
  expect(Number.isInteger(pid) && pid > 1).toBe(true);
  return pid;
}

/** The stdout of an `ok` run, failing the test if the run was anything else. */
function okStdout(run: AgentHookRun): string {
  if (run.kind !== "ok") throw new Error(`expected an ok run, got ${run.kind}: ${run.reason}`);
  return run.stdout;
}

/** The reason of a `block` run, failing the test if the run was anything else. */
function blockReason(run: AgentHookRun): string {
  if (run.kind !== "block") throw new Error(`expected a block run, got ${run.kind}`);
  return run.reason;
}

/** The reason of an `error` run, failing the test if the run was anything else. */
function errorReason(run: AgentHookRun): string {
  if (run.kind !== "error") throw new Error(`expected an error run, got ${run.kind}`);
  return run.reason;
}

describe("runAgentHook — stdin, cwd and exit 0", () => {
  test("AC-1: the payload reaches the hook on stdin as JSON", async () => {
    const out = join(dir, "payload.json");
    const run = await runAgentHook({
      entry: makeEntry({ command: runScript(scriptFile(`cat > '${out}'`)) }),
      payload: PAYLOAD,
      cwd: dir,
    });

    expect(run.kind).toBe("ok");
    expect(JSON.parse(await Bun.file(out).text())).toEqual(PAYLOAD);
  });

  test("AC-2: the hook runs in the given cwd", async () => {
    const run = await runAgentHook({
      entry: makeEntry({ command: runScript(scriptFile("pwd")) }),
      payload: PAYLOAD,
      cwd: dir,
    });

    expect(realpathSync(okStdout(run))).toBe(realpathSync(dir));
  });

  test("AC-3: exit 0 trims stdout and parses no json out of plain text", async () => {
    const run = await runAgentHook({
      entry: makeEntry({ command: runScript(scriptFile("echo '  hello  '")) }),
      payload: PAYLOAD,
      cwd: dir,
    });

    expect(run).toEqual({ kind: "ok", stdout: "hello" });
  });

  test("AC-4: a JSON object on stdout becomes the run's json", async () => {
    const run = await runAgentHook({
      entry: makeEntry({ command: runScript(scriptFile(`printf '{"decision":"block","reason":"r"}'`)) }),
      payload: PAYLOAD,
      cwd: dir,
    });

    expect(run.kind).toBe("ok");
    expect(run.kind === "ok" ? run.json : undefined).toEqual({ decision: "block", reason: "r" });
  });

  test("AC-5: a JSON array on stdout is not parsed as json", async () => {
    const run = await runAgentHook({
      entry: makeEntry({ command: runScript(scriptFile("printf '[1,2]'")) }),
      payload: PAYLOAD,
      cwd: dir,
    });

    expect(run).toEqual({ kind: "ok", stdout: "[1,2]" });
  });
});

describe("runAgentHook — exit codes", () => {
  test("AC-6: exit 2 blocks with the trimmed stderr as the reason", async () => {
    const body = "printf 'not allowed\\n' >&2\nexit 2";
    const run = await runAgentHook({
      entry: makeEntry({ command: runScript(scriptFile(body)) }),
      payload: PAYLOAD,
      cwd: dir,
    });

    expect(run).toEqual({ kind: "block", reason: "not allowed" });
  });

  test("AC-7: exit 2 with empty stderr names the command in the reason", async () => {
    const script = scriptFile("exit 2");
    const run = await runAgentHook({
      entry: makeEntry({ command: runScript(script) }),
      payload: PAYLOAD,
      cwd: dir,
    });

    expect(run.kind).toBe("block");
    expect(blockReason(run)).toContain(script);
  });

  test("AC-8: another exit code is an error naming the command, the code and stderr", async () => {
    const body = "printf 'boom\\n' >&2\nexit 1";
    const script = scriptFile(body);
    const run = await runAgentHook({
      entry: makeEntry({ command: runScript(script) }),
      payload: PAYLOAD,
      cwd: dir,
    });

    expect(run.kind).toBe("error");
    const reason = errorReason(run);
    expect(reason).toContain(script);
    expect(reason).toContain("1");
    expect(reason).toContain("boom");
  });
});

describe("runAgentHook — deadline and drain", () => {
  withDepsRestore(_runAgentHookDeps, ["killGraceMs", "drainMs"]);

  /**
   * Every case here inherits `--timeout` from the suite (5 s in
   * `scripts/run-tests-phases.ts`) unless it says otherwise, and 5 s is not a
   * behavioural bound for a test that spawns `/bin/sh`, waits out a deadline,
   * a kill grace AND a drain (2 s by default) before it asserts anything. When
   * the blanket budget did cut one off, bun printed `(fail) <name>` BEFORE the
   * detail line — the reverse of an assertion failure — so the suite read the
   * record as "no assertion message captured" and attributed a bare timeout to
   * this file. Each test below already bounds its own wall clock (the
   * `toBeLessThan` assertions); this budget only stops the runner from killing
   * the spawn before those assertions can be reached.
   */
  const SPAWN_TEST_TIMEOUT_MS = 20_000;

  test(
    "AC-9: a hook over its timeout resolves fast with a timed-out reason",
    async () => {
      const run = await runAgentHook({
        entry: makeEntry({ command: runScript(scriptFile("sleep 5")), timeoutMs: 100 }),
        payload: PAYLOAD,
        cwd: dir,
      });

      expect(run.kind).toBe("error");
      expect(errorReason(run)).toContain("timed out after 100ms");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "AC-9 continued: the timed-out call resolves in under 2s",
    async () => {
      const startedAt = performance.now();
      await runAgentHook({
        entry: makeEntry({ command: runScript(scriptFile("sleep 5")), timeoutMs: 100 }),
        payload: PAYLOAD,
        cwd: dir,
      });

      expect(performance.now() - startedAt).toBeLessThan(2000);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  /**
   * The two cases that read the child's own pid need a deadline the child can
   * actually reach its first line within: under the nax sandbox a spawn costs
   * ~110-500 ms before `/bin/sh` runs anything, so a 100 ms deadline kills the
   * script before it can write its pidfile (measured on this host). AC-9/AC-16
   * assert the deadline itself and keep `timeoutMs: 100`; these two carry no
   * bound on how long the call takes, so a generous deadline is free. The
   * elapsed bound below is what still fails if the deadline kills nothing.
   */
  const PID_REPORTING_TIMEOUT_MS = 1500;
  const PID_REPORTING_ELAPSED_MAX_MS = 4000;

  test(
    "AC-10: the timed-out hook's process no longer exists",
    async () => {
      const pidFile = join(dir, "hook.pid");
      const startedAt = performance.now();
      const run = await runAgentHook({
        entry: makeEntry({
          command: runScript(scriptFile(`echo $$ > '${pidFile}'\nsleep 5`)),
          timeoutMs: PID_REPORTING_TIMEOUT_MS,
        }),
        payload: PAYLOAD,
        cwd: dir,
      });

      // The elapsed bound is what makes this fail if the deadline does not kill:
      // an unkilled `sleep 5` still ends, so only its duration distinguishes it.
      expect(performance.now() - startedAt).toBeLessThan(PID_REPORTING_ELAPSED_MAX_MS);
      expect(run.kind).toBe("error");
      expect(errorReason(run)).toContain(`timed out after ${PID_REPORTING_TIMEOUT_MS}ms`);
      expect(isAlive(await readPid(pidFile))).toBe(false);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "AC-16: a SIGTERM-trapping hook is terminated by the SIGKILL escalation",
    async () => {
      _runAgentHookDeps.killGraceMs = 200;
      const startedAt = performance.now();
      const run = await runAgentHook({
        entry: makeEntry({ command: runScript(scriptFile("trap '' TERM\nsleep 5")), timeoutMs: 100 }),
        payload: PAYLOAD,
        cwd: dir,
      });

      expect(performance.now() - startedAt).toBeLessThan(2000);
      expect(run.kind).toBe("error");
      expect(errorReason(run)).toContain("timed out after 100ms");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "AC-16 continued: a descendant that ignores SIGTERM is escalated after the leader exits",
    async () => {
      _runAgentHookDeps.killGraceMs = 200;
      _runAgentHookDeps.drainMs = 200;
      const childPidFile = join(dir, "child.pid");
      // The leader dies on SIGTERM (default disposition); the descendant it
      // started ignores it. Only the SIGKILL escalation can end the descendant,
      // and it must still run after `proc.exited` resolves for the leader.
      const script = scriptFile(
        [`sh -c 'trap "" TERM; echo $$ > "${childPidFile}"; sleep 10' &`, "sleep 10"].join("\n"),
      );
      const startedAt = performance.now();
      const run = await runAgentHook({
        entry: makeEntry({ command: runScript(script), timeoutMs: PID_REPORTING_TIMEOUT_MS }),
        payload: PAYLOAD,
        cwd: dir,
      });

      expect(performance.now() - startedAt).toBeLessThan(4000);
      expect(run.kind).toBe("error");
      expect(errorReason(run)).toContain(`timed out after ${PID_REPORTING_TIMEOUT_MS}ms`);

      const childPid = await readPid(childPidFile);
      await waitForCondition(() => !isAlive(childPid), 1000);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "AC-17: the SIGTERM-trapping hook's process no longer exists",
    async () => {
      _runAgentHookDeps.killGraceMs = 200;
      const pidFile = join(dir, "hook.pid");
      const startedAt = performance.now();
      const run = await runAgentHook({
        entry: makeEntry({
          command: runScript(scriptFile(`trap '' TERM\necho $$ > '${pidFile}'\nsleep 5`)),
          timeoutMs: PID_REPORTING_TIMEOUT_MS,
        }),
        payload: PAYLOAD,
        cwd: dir,
      });

      // Same reasoning as AC-10: only the elapsed bound distinguishes a killed
      // process from one that would have ended by itself.
      expect(performance.now() - startedAt).toBeLessThan(PID_REPORTING_ELAPSED_MAX_MS);
      expect(run.kind).toBe("error");
      expect(errorReason(run)).toContain(`timed out after ${PID_REPORTING_TIMEOUT_MS}ms`);
      expect(isAlive(await readPid(pidFile))).toBe(false);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "AC-18: a background child holding stdout does not extend the drain",
    async () => {
      _runAgentHookDeps.drainMs = 200;
      const startedAt = performance.now();
      const run = await runAgentHook({
        entry: makeEntry({ command: runScript(scriptFile("printf 'partial'\nsleep 10 &\nexit 0")) }),
        payload: PAYLOAD,
        cwd: dir,
      });

      expect(performance.now() - startedAt).toBeLessThan(2000);
      expect(run).toEqual({ kind: "ok", stdout: "partial" });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("runAgentHook — command validation", () => {
  test("AC-11: the timing constants have their documented defaults", () => {
    expect(AGENT_HOOK_KILL_GRACE_MS).toBe(5000);
    expect(AGENT_HOOK_DRAIN_MS).toBe(2000);
    expect(AGENT_HOOK_HANDLER_MARGIN_MS).toBe(1000);
  });

  test("AC-12: a dangerous command is rejected without being started", async () => {
    const run = await runAgentHook({
      entry: makeEntry({ command: "eval rm", origin: "project" }),
      payload: PAYLOAD,
      cwd: dir,
    });

    expect(run.kind).toBe("error");
    const reason = errorReason(run);
    expect(reason).toContain("\\beval\\s+");
    expect(reason).not.toContain("could not be started");
  });

  test("AC-13: an executable that does not exist is an error, not a rejection", async () => {
    const run = await runAgentHook({
      entry: makeEntry({ command: "nax-no-such-executable-xyz" }),
      payload: PAYLOAD,
      cwd: dir,
    });

    expect(run.kind).toBe("error");
    expect(errorReason(run)).toContain("nax-no-such-executable-xyz");
  });

  test("AC-14: a whitespace-only command is an error with reason empty command", async () => {
    const run = await runAgentHook({
      entry: makeEntry({ command: "  \t " }),
      payload: PAYLOAD,
      cwd: dir,
    });

    expect(run).toEqual({ kind: "error", reason: "empty command" });
  });

  test("AC-15: the command is split into argv, with no shell in between", async () => {
    const script = scriptFile(`printf '%s\\n' "$#" "$1" "$2"`);
    const run = await runAgentHook({
      entry: makeEntry({ command: runScript(script, "'a b' c") }),
      payload: PAYLOAD,
      cwd: dir,
    });

    expect(okStdout(run).split("\n")).toEqual(["2", "a b", "c"]);
  });
});

describe("runAgentHook — project trust", () => {
  withDepsRestore(_runAgentHookDeps, ["assertTrusted"]);

  /** Install an `assertTrusted` that refuses the way the real one does. */
  function refuseTrust(): void {
    _runAgentHookDeps.assertTrusted = () =>
      Promise.reject(
        new NaxError("[trust] refusing to run agent-hooks in an untrusted project: /repo", "PROJECT_UNTRUSTED", {
          stage: "trust",
          surface: "agent-hooks",
        }),
      );
  }

  test("AC-19: a refused project entry is an error whose reason mentions trust", async () => {
    refuseTrust();
    const run = await runAgentHook({
      entry: makeEntry({ command: runScript(scriptFile("exit 0")), origin: "project" }),
      payload: PAYLOAD,
      cwd: dir,
    });

    expect(run.kind).toBe("error");
    expect(errorReason(run)).toMatch(/trust/i);
  });

  test("AC-20: a refused project entry spawns no process", async () => {
    refuseTrust();
    const marker = join(dir, "spawned");
    const run = await runAgentHook({
      entry: makeEntry({ command: `touch '${marker}'`, origin: "project" }),
      payload: PAYLOAD,
      cwd: dir,
    });

    expect(run.kind).toBe("error");
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("AC-20 control: the same marker command does spawn for a global entry", async () => {
    refuseTrust();
    const marker = join(dir, "spawned");
    const run = await runAgentHook({
      entry: makeEntry({ command: `touch '${marker}'` }),
      payload: PAYLOAD,
      cwd: dir,
    });

    expect(run.kind).toBe("ok");
    expect(await Bun.file(marker).exists()).toBe(true);
  });

  test("AC-21: the trust check is asked about the cwd on the agent-hooks surface", async () => {
    const calls: [string, string][] = [];
    _runAgentHookDeps.assertTrusted = async (path, surface) => {
      calls.push([path, surface]);
    };

    await runAgentHook({
      entry: makeEntry({ command: runScript(scriptFile("exit 0")), origin: "project" }),
      payload: PAYLOAD,
      cwd: dir,
    });

    expect(calls).toEqual([[dir, "agent-hooks"]]);
  });

  test("AC-22: a global entry never asks for trust", async () => {
    let calls = 0;
    _runAgentHookDeps.assertTrusted = async () => {
      calls += 1;
    };

    const run = await runAgentHook({
      entry: makeEntry({ command: runScript(scriptFile("exit 0")) }),
      payload: PAYLOAD,
      cwd: dir,
    });

    expect(run.kind).toBe("ok");
    expect(calls).toBe(0);
  });
});

describe("runAgentHook — logging", () => {
  test("AC-23: one debug line per run carries the event, command, kind and durationMs", async () => {
    const entry = makeEntry({ command: runScript(scriptFile("exit 0")) });

    await withDebugSpy(async (spy) => {
      const run = await runAgentHook({ entry, payload: PAYLOAD, cwd: dir });
      expect(run.kind).toBe("ok");

      const lines = spy.mock.calls.filter((call) => call[0] === "agent-hooks");
      expect(lines).toHaveLength(1);
      const data = lines[0][2] ?? {};
      expect(data).toMatchObject({ event: "PreToolUse", command: entry.command, kind: "ok" });
      expect(typeof data.durationMs).toBe("number");
    });
  });

  test("AC-23 continued: an error run logs exactly one line too", async () => {
    const entry = makeEntry({ command: "  \t " });

    await withDebugSpy(async (spy) => {
      const run = await runAgentHook({ entry, payload: PAYLOAD, cwd: dir });
      expect(run.kind).toBe("error");

      const lines = spy.mock.calls.filter((call) => call[0] === "agent-hooks");
      expect(lines).toHaveLength(1);
      expect(lines[0][2]).toMatchObject({ event: "PreToolUse", command: entry.command, kind: "error" });
    });
  });
});
