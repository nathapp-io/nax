/**
 * Tests for SpawnAcpClient — spawn-client.ts
 *
 * SEC-3: loadSession() must NOT hardcode "approve-all".
 *        It must use the client's stored permissionMode ("approve-reads" by default).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { SpawnAcpClient, _spawnClientDeps } from "@/agents/acp";
import type { SpawnOptions } from "@/utils/bun-deps";
import { waitForCondition, withDepsRestore, withTimerSpy } from "@test/helpers";
import { makeSpawnResult, stubProcessKill } from "./_spawn-client-test-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// SAFETY: file-scope process.kill stub
//
// BUG-1 (safety): cancelActivePrompt()/close() call killProcessGroup, which
// hits the REAL process.kill(-pid, signal) unless stubbed. Several describe
// blocks below exercise these paths with fake PIDs — without a file-wide stub,
// any test that doesn't set up its own local override (or an escalation timer
// that outlives a describe-local afterEach) can send a real signal to the
// host. Stub process.kill for every test in this file, unconditionally, and
// restore the true original only after each test completes. Individual tests
// may still install their own recording override — the file-scope beforeEach
// re-installs the safe default before the NEXT test, so nothing leaks across
// tests either.
// ─────────────────────────────────────────────────────────────────────────────

stubProcessKill();

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
    pid: 99999999,
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

  test("onPidSpawned fires during createSession (short-lived trackedSpawn)", async () => {
    _spawnClientDeps.spawn = (_cmd, _opts) => makeSpawnResult(0);

    const pids: number[] = [];
    const client = new SpawnAcpClient("acpx claude", "/tmp", undefined, (pid) => pids.push(pid));
    await client.createSession({ agentName: "claude", permissionMode: "approve-reads" });

    expect(pids).toHaveLength(1);
  });

  test("onPidSpawned fires during closeSession (short-lived trackedSpawn)", async () => {
    _spawnClientDeps.spawn = (_cmd, _opts) => makeSpawnResult(0);

    const pids: number[] = [];
    const client = new SpawnAcpClient("acpx claude", "/tmp", undefined, (pid) => pids.push(pid));
    await client.closeSession("test-session", "claude");

    expect(pids).toHaveLength(1);
  });

  // BUG-16: forceStop was declared on the AcpClient interface but never
  // implemented anywhere — closePhysicalSession's { force: true } branch was
  // a dead call site. SpawnAcpClient must actually run `acpx --cwd <cwd>
  // <agent> stop`. --cwd is required (matches every other acpx invocation
  // in this client) — without it, the command scopes to the acpx process's
  // own cwd instead of this client's worktree, risking the wrong queue
  // owner in a parallel/worktree run with multiple instances of the same agent.
  test("forceStop spawns `acpx --cwd <cwd> <agentName> stop`", async () => {
    const spawnedCommands: string[][] = [];
    _spawnClientDeps.spawn = (cmd, _opts) => {
      spawnedCommands.push(cmd as string[]);
      return makeSpawnResult(0);
    };

    const client = new SpawnAcpClient("acpx claude", "/tmp/my-worktree");
    await client.forceStop("claude");

    expect(spawnedCommands).toHaveLength(1);
    expect(spawnedCommands[0]).toEqual(["acpx", "--cwd", "/tmp/my-worktree", "claude", "stop"]);
  });

  test("forceStop does not throw when the stop command fails", async () => {
    _spawnClientDeps.spawn = (_cmd, _opts) => makeSpawnResult(1);

    const client = new SpawnAcpClient("acpx claude", "/tmp");
    await expect(client.forceStop("claude")).resolves.toBeUndefined();
  });

  // BUG-15: opts.env (config.models.<agent>.<tier>.env) was accepted by the
  // constructor's AcpClientOptions type but never passed into
  // buildAllowedEnv() — a per-model API key/base URL override was silently
  // dropped and the subprocess ran on ambient env only.
  test("threads AcpClientOptions.env into the client's subprocess env as modelEnv", () => {
    const client = new SpawnAcpClient("acpx claude", "/tmp", undefined, undefined, undefined, undefined, {
      env: { ANTHROPIC_BASE_URL: "https://custom.example.com", ANTHROPIC_API_KEY: "from-model-def" },
    });
    const internals = client as unknown as { env: Record<string, string | undefined> }; // test-ratchet-allow: as-unknown-as
    expect(internals.env.ANTHROPIC_BASE_URL).toBe("https://custom.example.com");
    expect(internals.env.ANTHROPIC_API_KEY).toBe("from-model-def");
  });

  test("subprocess env is unaffected when no env override is passed", () => {
    const client = new SpawnAcpClient("acpx claude", "/tmp");
    const internals = client as unknown as { env: Record<string, string | undefined> }; // test-ratchet-allow: as-unknown-as
    expect(internals.env.ANTHROPIC_BASE_URL).toBeUndefined();
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
        stdout: new ReadableStream<Uint8Array>({
          start(c) {
            c.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode("connection failed"));
            c.close();
          },
        }),
        stdin: {
          write: () => {
            throw new Error("EPIPE: broken pipe");
          },
          end: () => {},
          flush: () => {},
        },
        exited: Promise.resolve(1),
        pid: 99999999,
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
        stdout: new ReadableStream<Uint8Array>({
          start(c) {
            c.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode("write error"));
            c.close();
          },
        }),
        stdin: {
          write: () => 0,
          end: () => {
            throw new Error("EPIPE: broken pipe");
          },
          flush: () => {},
        },
        exited: Promise.resolve(1),
        pid: 99999999,
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
        start(c) {
          c.error(new Error("stream error"));
        },
      });
      const stderrStream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode("acpx crashed"));
          c.close();
        },
      });
      return {
        stdout: errStream,
        stderr: stderrStream,
        stdin: { write: () => 0, end: () => {}, flush: () => {} },
        exited: Promise.resolve(1),
        pid: 99999999,
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
      const hangingStream = new ReadableStream<Uint8Array>({
        start() {
          /* never closes */
        },
      });
      return {
        stdout: hangingStream,
        stderr: new ReadableStream<Uint8Array>({
          start(c) {
            c.close();
          },
        }),
        stdin: { write: () => 0, end: () => {}, flush: () => {} },
        exited: Promise.resolve(1),
        pid: 99999999,
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

// ─────────────────────────────────────────────────────────────────────────────
// BUG-1/BUG-2 — success-path response fidelity
// ─────────────────────────────────────────────────────────────────────────────

describe("SpawnAcpSession — success-path response fidelity (BUG-1/BUG-2)", () => {
  withDepsRestore(_spawnClientDeps, ["spawn", "killTreeGraceMs"]);

  beforeEach(() => {
    // ORPHAN-1: cancelActivePrompt() below kills the active process tree,
    // which arms a SIGKILL-escalation setTimeout (default 250ms — see
    // KILL_TREE_GRACE_MS). Use a tiny grace period so the escalation timer
    // fires and settles well inside this test's own execution window, while
    // process.kill is still the file-scope safety stub — not after this test
    // (or the file-scope afterEach) has already moved on.
    _spawnClientDeps.killTreeGraceMs = 1;
  });

  test("success path carries parsed.error/retryable through even on exit 0 (BUG-1)", async () => {
    let callCount = 0;
    // acpx can exit 0 while still emitting a JSON-RPC error envelope on stdout
    // (finalizeParseState captures it as `error`/`retryable`).
    const errorLine = `${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "message_end",
        },
      },
    })}\n`;
    const rpcError = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { message: "recoverable acpx fault", data: { retryable: true } },
    });

    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0); // ensure session
      return makeSpawnResult(0, `${rpcError}\n`);
    };

    const client = new SpawnAcpClient("acpx claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    expect(session).not.toBeNull();

    const response = await session!.prompt("hello");
    expect(response.error).toBe("recoverable acpx fault");
    expect(response.retryable).toBe(true);
  });

  test("stamps cancelled:true on the success path when cancelActivePrompt() was invoked (BUG-2)", async () => {
    let callCount = 0;
    let resolvePromptExit: ((code: number) => void) | undefined;

    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0); // ensure session
      if (callCount === 2) {
        // The prompt spawn: exits 0 (agent exited cleanly on SIGTERM) with
        // truncated/partial text — must NOT look like a clean success once
        // cancelActivePrompt() has been invoked. Exit is held open so the test
        // can invoke cancelActivePrompt() while the prompt is still in-flight.
        const enc = new TextEncoder();
        const stdout = JSON.stringify({ result: "partial output before SIGTERM" });
        const exited = new Promise<number>((resolve) => {
          resolvePromptExit = resolve;
        });
        return {
          stdout: new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode(stdout));
              c.close();
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(c) {
              c.close();
            },
          }),
          stdin: { write: () => 0, end: () => {}, flush: () => {} },
          exited,
          pid: 99999999,
          kill: () => {},
        };
      }
      // Third call: the `acpx <agent> cancel` trackedSpawn invoked by cancelActivePrompt()
      return makeSpawnResult(0);
    };

    const client = new SpawnAcpClient("acpx claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    expect(session).not.toBeNull();

    // async function bodies run synchronously up to their first `await` — by the
    // time prompt() returns a pending promise, `this.activeProc` is already set
    // (the first await inside prompt() is `await proc.exited`), so cancelActivePrompt()
    // observes the in-flight process without any extra synchronization.
    const promptPromise = session!.prompt("hello");
    await session!.cancelActivePrompt();
    resolvePromptExit?.(0);

    const response = await promptPromise;
    expect(response.cancelled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ORPHAN-1 — process-tree cleanup (detached spawn + killProcessGroup)
// ─────────────────────────────────────────────────────────────────────────────

describe("SpawnAcpSession — process-tree cleanup (ORPHAN-1)", () => {
  withDepsRestore(_spawnClientDeps, ["spawn", "killTreeGraceMs"]);

  beforeEach(() => {
    // See the BUG-1/BUG-2 describe block above for why this must be tiny:
    // close()/cancelActivePrompt() arm a SIGKILL-escalation timer that must
    // settle within this test's own window while process.kill is still the
    // file-scope safety stub (registered in the outer beforeEach above).
    _spawnClientDeps.killTreeGraceMs = 1;
  });

  test("prompt spawn is detached so its PID is a real process-group leader", async () => {
    let callCount = 0;
    let capturedOpts: SpawnOptions | undefined;

    _spawnClientDeps.spawn = (_cmd, opts) => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0); // ensure session
      capturedOpts = opts;
      return makeSpawnResult(0, JSON.stringify({ result: "ok" }));
    };

    const client = new SpawnAcpClient("acpx claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    await session!.prompt("hello");

    expect(capturedOpts?.detached).toBe(true);
  });

  test("close() kills the active prompt's process group, not just the single PID", async () => {
    let callCount = 0;
    let resolvePromptExit: ((code: number) => void) | undefined;

    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0); // ensure session
      if (callCount === 2) {
        const exited = new Promise<number>((resolve) => {
          resolvePromptExit = resolve;
        });
        return {
          stdout: new ReadableStream<Uint8Array>({
            start(c) {
              c.close();
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(c) {
              c.close();
            },
          }),
          stdin: { write: () => 0, end: () => {}, flush: () => {} },
          exited,
          pid: 99999999,
          kill: () => {},
        };
      }
      return makeSpawnResult(0); // sessions close trackedSpawn
    };

    const killCalls: Array<{ pid: number | string; signal?: NodeJS.Signals | number }> = [];
    process.kill = ((pid: number | string, signal?: NodeJS.Signals | number) => {
      killCalls.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    const client = new SpawnAcpClient("acpx claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");

    const promptPromise = session!.prompt("hello");
    await session!.close();
    resolvePromptExit?.(0);
    await promptPromise;

    // killProcessGroup signals the negative (group) PID first.
    expect(killCalls.some((c) => c.pid === -99999999 && c.signal === "SIGTERM")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PERF-1 — trackedSpawn hard deadline
// ─────────────────────────────────────────────────────────────────────────────

describe("SpawnAcpSession — trackedSpawn hard deadline (PERF-1)", () => {
  withDepsRestore(_spawnClientDeps, ["spawn", "trackedSpawnDeadlineMs", "killTreeGraceMs"]);

  test("close() resolves within the deadline when the session-close spawn never exits", async () => {
    _spawnClientDeps.trackedSpawnDeadlineMs = 50;

    let callCount = 0;
    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0); // ensure session
      // Session-close spawn: never exits, streams never close (wedged acpx).
      return {
        stdout: new ReadableStream<Uint8Array>({ start() {} }),
        stderr: new ReadableStream<Uint8Array>({ start() {} }),
        stdin: { write: () => 0, end: () => {}, flush: () => {} },
        exited: new Promise<number>(() => {}),
        pid: 99999999,
        kill: () => {},
      };
    };

    const client = new SpawnAcpClient("acpx claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    expect(session).not.toBeNull();

    const MARGIN_MS = 500;
    const timed = Symbol("timed");
    const result = await Promise.race([
      session!.close(),
      new Promise<typeof timed>((resolve) =>
        setTimeout(() => resolve(timed), _spawnClientDeps.trackedSpawnDeadlineMs + MARGIN_MS),
      ),
    ]);

    // close() must resolve within the deadline, not hang on the wedged proc.exited.
    expect(result).not.toBe(timed);
  });

  // BUG-3: previously, a trackedSpawn timeout just returned exitCode:-1 and
  // abandoned the wedged process — the whole point of PERF-1 (bounding a
  // wedged acpx) was defeated because the process itself kept running. Now
  // the timeout path must kill the process tree and best-effort cancel its
  // still-open stdout/stderr streams.
  test("BUG-3: timeout kills the wedged process tree and cancels its streams", async () => {
    _spawnClientDeps.trackedSpawnDeadlineMs = 20;
    _spawnClientDeps.killTreeGraceMs = 1;

    let callCount = 0;
    let stdoutCancelled = false;
    let stderrCancelled = false;
    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0); // ensure session
      // Session-close spawn: wedged — never exits, streams never close.
      return {
        stdout: new ReadableStream<Uint8Array>({
          start() {},
          cancel: () => {
            stdoutCancelled = true;
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start() {},
          cancel: () => {
            stderrCancelled = true;
          },
        }),
        stdin: { write: () => 0, end: () => {}, flush: () => {} },
        exited: new Promise<number>(() => {}),
        pid: 99999999,
        kill: () => {},
      };
    };

    const killCalls: Array<{ pid: number | string; signal?: NodeJS.Signals | number }> = [];
    process.kill = ((pid: number | string, signal?: NodeJS.Signals | number) => {
      killCalls.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    const client = new SpawnAcpClient("acpx claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    await session!.close();

    expect(killCalls.some((c) => c.pid === -99999999 && c.signal === "SIGTERM")).toBe(true);
    expect(stdoutCancelled).toBe(true);
    expect(stderrCancelled).toBe(true);

    // SIGKILL escalation runs on its own timer (killTreeGraceMs=1) — wait for
    // it instead of a fixed sleep so the assertion isn't a race against the timer.
    await waitForCondition(() => killCalls.some((c) => c.pid === -99999999 && c.signal === "SIGKILL"), 1000, 5);
  });

  // BUG-4: an already-aborted signal must take the SAME kill action as a
  // genuine deadline timeout — Ctrl+C during graceful teardown must not leave
  // the process it was trying to tear down still running.
  test("BUG-4: an already-aborted signal also kills the process tree (not silently abandoned)", async () => {
    _spawnClientDeps.trackedSpawnDeadlineMs = 5000; // large — abort must win, not the deadline
    _spawnClientDeps.killTreeGraceMs = 1;

    let callCount = 0;
    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0); // ensure session
      return {
        stdout: new ReadableStream<Uint8Array>({ start() {} }),
        stderr: new ReadableStream<Uint8Array>({ start() {} }),
        stdin: { write: () => 0, end: () => {}, flush: () => {} },
        exited: new Promise<number>(() => {}), // never resolves on its own
        pid: 99999999,
        kill: () => {},
      };
    };

    const killCalls: Array<{ pid: number | string; signal?: NodeJS.Signals | number }> = [];
    process.kill = ((pid: number | string, signal?: NodeJS.Signals | number) => {
      killCalls.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    const client = new SpawnAcpClient("acpx claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");

    const controller = new AbortController();
    controller.abort(); // already aborted before close() is even called

    const MARGIN_MS = 500;
    const timed = Symbol("timed");
    const result = await Promise.race([
      session!.close({ signal: controller.signal }),
      new Promise<typeof timed>((resolve) => setTimeout(() => resolve(timed), MARGIN_MS)),
    ]);

    // Must resolve promptly on the abort path, not wait for the 5s deadline.
    expect(result).not.toBe(timed);
    expect(killCalls.some((c) => c.pid === -99999999 && c.signal === "SIGTERM")).toBe(true);
  });

  // PERF-1: the deadline timer itself must not stay armed for the full
  // deadline once proc.exited has already won the race — previously
  // cancellableDelay's internal setTimeout was left running (holding the
  // event loop open) even after the caller had already moved on.
  test("PERF-1: deadline timer is cleared once proc.exited wins, not left armed for the full deadline", async () => {
    _spawnClientDeps.trackedSpawnDeadlineMs = 5000;

    let callCount = 0;
    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0); // ensure session
      return makeSpawnResult(0); // session-close spawn exits immediately
    };

    const client = new SpawnAcpClient("acpx claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    expect(session).not.toBeNull();

    const { leaked } = await withTimerSpy(async () => {
      await session!.close();
    });

    expect(leaked).toEqual([]);
  });
});

describe("SpawnAcpClient — loadSession (SEC-3)", () => {
  withDepsRestore(_spawnClientDeps, ["spawn"]);

  test("loadSession returns a session when ensure succeeds", async () => {
    _spawnClientDeps.spawn = (_cmd, _opts) => makeSpawnResult(0);

    const client = new SpawnAcpClient("acpx --model claude-sonnet-4-5 claude", "/tmp");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    expect(session).not.toBeNull();
  });

  test("loadSession returns null when ensure fails", async () => {
    _spawnClientDeps.spawn = (_cmd, _opts) => makeSpawnResult(1);

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

// ─────────────────────────────────────────────────────────────────────────────
// --prompt-retries flag passthrough
// ─────────────────────────────────────────────────────────────────────────────

describe("SpawnAcpClient — --prompt-retries flag passthrough", () => {
  withDepsRestore(_spawnClientDeps, ["spawn"]);

  function capturePromptCmd(promptRetries?: number): {
    capturedCmd: () => string[];
    client: SpawnAcpClient;
  } {
    let captured: string[] = [];
    _spawnClientDeps.spawn = (cmd, _opts) => {
      captured = [...cmd];
      return makeSpawnResult(0, JSON.stringify({ result: "ok" }));
    };
    const client = new SpawnAcpClient("acpx --model claude-sonnet-4-5 claude", "/tmp", 30, undefined, promptRetries);
    return { capturedCmd: () => captured, client };
  }

  test("prompt cmd includes --prompt-retries when promptRetries > 0", async () => {
    const { capturedCmd, client } = capturePromptCmd(2);
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    expect(session).not.toBeNull();
    await session!.prompt("hello");
    expect(capturedCmd()).toContain("--prompt-retries");
    const idx = capturedCmd().indexOf("--prompt-retries");
    expect(capturedCmd()[idx + 1]).toBe("2");
  });

  test("prompt cmd omits --prompt-retries when promptRetries is 0 (default)", async () => {
    const { capturedCmd, client } = capturePromptCmd(0);
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    expect(session).not.toBeNull();
    await session!.prompt("hello");
    expect(capturedCmd()).not.toContain("--prompt-retries");
  });

  test("prompt cmd omits --prompt-retries when promptRetries is unset", async () => {
    const { capturedCmd, client } = capturePromptCmd(undefined);
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    expect(session).not.toBeNull();
    await session!.prompt("hello");
    expect(capturedCmd()).not.toContain("--prompt-retries");
  });
});
