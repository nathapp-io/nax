import { describe, expect, mock, test } from "bun:test";
import { NO_OP_INTERACTION_HANDLER } from "@/agents";
import type { OpenSessionOpts, SendTurnOpts, SessionHandle, TurnResult } from "@/agents/types";
import { SessionFailureError, SessionTurnError } from "@/agents/types";
import { AgentStreamEventBus } from "@/runtime/agent-stream-events";
import { SessionManager } from "@/session/manager";
import type { OpenSessionRequest, RunInSessionOpts } from "@/session/types";
import { makeAgentAdapter } from "@test/helpers";

const WORKDIR = "/tmp/nax-phase-b-test";

const MOCK_TURN: TurnResult = {
  output: "hello world",
  tokenUsage: { inputTokens: 10, outputTokens: 5 },
  estimatedCostUsd: 0,
  internalRoundTrips: 1,
};

function makeOpenRequest(overrides: Partial<OpenSessionRequest> = {}): OpenSessionRequest {
  return {
    agentName: "claude",
    workdir: WORKDIR,
    pipelineStage: "run",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    timeoutSeconds: 30,
    ...overrides,
  };
}

function makeRunOpts(overrides: Partial<RunInSessionOpts> = {}): RunInSessionOpts {
  return {
    agentName: "claude",
    workdir: WORKDIR,
    pipelineStage: "run",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    timeoutSeconds: 30,
    ...overrides,
  };
}

// ─── sendPrompt() ─────────────────────────────────────────────────────────────

describe("sendPrompt()", () => {
  test("delegates to adapter.sendTurn and returns result", async () => {
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => MOCK_TURN),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-send-test", makeOpenRequest());

    const result = await sm.sendPrompt(handle, "write a function");
    expect(result.output).toBe("hello world");
  });

  test("forwards NO_OP_INTERACTION_HANDLER when opts omitted", async () => {
    let capturedHandler: unknown;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async (_h: SessionHandle, _p: string, opts: SendTurnOpts) => {
        capturedHandler = opts.interactionHandler;
        return MOCK_TURN;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-handler-test", makeOpenRequest());
    await sm.sendPrompt(handle, "test");
    expect(capturedHandler).toBe(NO_OP_INTERACTION_HANDLER);
  });

  test("throws SESSION_BUSY on concurrent sendPrompt for same handle", async () => {
    let resolveFirst!: () => void;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        return MOCK_TURN;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-busy-test", makeOpenRequest());

    const first = sm.sendPrompt(handle, "first");
    await expect(sm.sendPrompt(handle, "second")).rejects.toMatchObject({
      code: "SESSION_BUSY",
    });
    resolveFirst();
    await first;
  });

  test("throws SESSION_CANCELLED after signal abort during turn", async () => {
    const controller = new AbortController();
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => {
        controller.abort();
        throw new Error("aborted");
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-cancel-test", makeOpenRequest());

    await expect(sm.sendPrompt(handle, "cancelled", { signal: controller.signal })).rejects.toThrow();
    await expect(sm.sendPrompt(handle, "after cancel")).rejects.toMatchObject({
      code: "SESSION_CANCELLED",
    });
  });

  test("throws ADAPTER_NOT_FOUND when sendPrompt called without adapter", async () => {
    const sm = new SessionManager();
    const fakeHandle: SessionHandle = { id: "nax-noadapter", agentName: "claude" };
    await expect(sm.sendPrompt(fakeHandle, "test")).rejects.toMatchObject({
      code: "ADAPTER_NOT_FOUND",
    });
  });

  test("throws SESSION_TERMINAL_STATE when session is COMPLETED (closed without re-open)", async () => {
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => MOCK_TURN),
      closeSession: mock(async () => {}),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-terminal-test", makeOpenRequest());
    await sm.sendPrompt(handle, "first prompt");
    await sm.closeSession(handle);

    await expect(sm.sendPrompt(handle, "after close")).rejects.toMatchObject({
      code: "SESSION_TERMINAL_STATE",
    });
  });

  test("rewraps SessionTurnError(cancelled=true) as fail-stale when watchdog triggered the cancel", async () => {
    // The adapter is a transport primitive — it surfaces cancelled:true via
    // SessionTurnError. SessionManager owns the watchdog policy: when its own
    // onActiveCall callback was invoked (i.e. _it_ triggered the cancel), it
    // maps the throw to a SessionFailureError with outcome:"fail-stale".
    let capturedActiveCall: ((callId: string, cancel: () => Promise<void>) => void) | undefined;
    const registry = new Map<string, () => Promise<void>>();
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        capturedActiveCall = opts.onActiveCall;
        return { id: name, agentName: "claude" } as SessionHandle;
      }),
      sendTurn: mock(async () => {
        // 1. The adapter publishes its in-flight call via onActiveCall —
        //    SessionManager's wrapper registers a wrapped cancel in the registry.
        capturedActiveCall?.("call-1", async () => {});
        // 2. Simulate the watchdog firing: invoke the registered cancel. The
        //    wrapper records "call-1" in SessionManager's bookkeeping.
        await registry.get("call-1")?.();
        // 3. The adapter then throws cancelled:true.
        throw new SessionTurnError("Agent session ended with stop reason: error (externally cancelled)", true);
      }),
    });

    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ watchdogControllerRegistry: registry });
    const handle = await sm.openSession("nax-stale-test", makeOpenRequest());

    let caught: unknown;
    try {
      await sm.sendPrompt(handle, "test");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SessionFailureError);
    expect((caught as SessionFailureError).adapterFailure.outcome).toBe("fail-stale");
    expect((caught as SessionFailureError).adapterFailure.category).toBe("availability");
    expect((caught as SessionFailureError).adapterFailure.retriable).toBe(true);
    expect((caught as SessionFailureError).adapterFailure.reason).toBe("idle-watchdog");
  });

  test("does not rewrap SessionTurnError(cancelled=true) when watchdog did not trigger the cancel", async () => {
    // If the adapter reports cancelled:true but SessionManager's bookkeeping
    // shows _it_ never invoked the cancel (e.g. an unrelated process kill),
    // pass the error through — do not invent a fail-stale outcome.
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => {
        throw new SessionTurnError("Agent session ended with stop reason: error (externally cancelled)", true);
      }),
    });

    const registry = new Map<string, () => Promise<void>>();
    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ watchdogControllerRegistry: registry });
    const handle = await sm.openSession("nax-passthrough-test", makeOpenRequest());

    let caught: unknown;
    try {
      await sm.sendPrompt(handle, "test");
    } catch (err) {
      caught = err;
    }
    // No fail-stale rewrap — original SessionTurnError flows through.
    expect(caught).toBeInstanceOf(SessionTurnError);
    expect(caught).not.toBeInstanceOf(SessionFailureError);
  });

  test("agent.call_ended event drains watchdog controller registry", async () => {
    // SessionManager subscribes once to the stream bus and depopulates the
    // controller registry when agent.call_ended fires. Note: _watchdogCancelledCalls
    // is NOT drained from this subscriber to avoid the race where agent.call_ended
    // fires inside SpawnAcpSession.prompt() before sendPrompt sees the error.
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => MOCK_TURN),
    });

    const registry = new Map<string, () => Promise<void>>();
    const bus = new AgentStreamEventBus();
    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ watchdogControllerRegistry: registry, agentStreamEvents: bus });

    registry.set("call-x", async () => {});
    expect(registry.size).toBe(1);

    bus.emitAgentStream({
      kind: "agent.call_ended",
      callId: "call-x",
      runId: "r-1",
      agentName: "claude",
      sessionName: "nax-test",
      status: "success",
      timestamp: Date.now(),
    });

    expect(registry.size).toBe(0);
  });

  test("fail-stale classification survives agent.call_ended emitted before SessionTurnError throws", async () => {
    // Regression: agent.call_ended fires synchronously inside SpawnAcpSession.prompt()
    // BEFORE the error propagates as a SessionTurnError. Previously the agent.call_ended
    // subscriber drained _watchdogCancelledCalls, causing sendPrompt to see an empty
    // set and miss the fail-stale classification. The fix: only drain from sendPrompt.
    let capturedActiveCall: ((callId: string, cancel: () => Promise<void>) => void) | undefined;
    const registry = new Map<string, () => Promise<void>>();
    const bus = new AgentStreamEventBus();
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        capturedActiveCall = opts.onActiveCall;
        return { id: name, agentName: "claude" } as SessionHandle;
      }),
      sendTurn: mock(async () => {
        // 1. Register the in-flight call via onActiveCall.
        capturedActiveCall?.("call-race", async () => {});
        // 2. Watchdog fires: wrapped cancel records callId in _watchdogCancelledCalls.
        await registry.get("call-race")?.();
        // 3. Simulate agent.call_ended fired by SpawnAcpSession BEFORE throwing —
        //    this is what happens in production (event emitted on non-zero exit path).
        bus.emitAgentStream({
          kind: "agent.call_ended",
          callId: "call-race",
          runId: "r-1",
          agentName: "claude",
          sessionName: "nax-test",
          status: "error",
          timestamp: Date.now(),
        });
        // 4. Now throw — like the adapter does after emitting call_ended.
        throw new SessionTurnError("Agent session ended with stop reason: error (externally cancelled)", true);
      }),
    });

    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ watchdogControllerRegistry: registry, agentStreamEvents: bus });
    const handle = await sm.openSession("nax-race-test", makeOpenRequest());

    let caught: unknown;
    try {
      await sm.sendPrompt(handle, "test");
    } catch (err) {
      caught = err;
    }
    // Must still be classified as fail-stale despite agent.call_ended firing first.
    expect(caught).toBeInstanceOf(SessionFailureError);
    expect((caught as SessionFailureError).adapterFailure.outcome).toBe("fail-stale");
    expect((caught as SessionFailureError).adapterFailure.reason).toBe("idle-watchdog");
  });

  test("watchdog fail-stale classification is isolated per session handle during parallel prompts", async () => {
    let capturedA: ((callId: string, cancel: () => Promise<void>) => void) | undefined;
    let capturedB: ((callId: string, cancel: () => Promise<void>) => void) | undefined;
    const registry = new Map<string, () => Promise<void>>();
    let releaseB: (() => void) | undefined;
    const allowBToFinish = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        if (name === "nax-session-a") capturedA = opts.onActiveCall;
        if (name === "nax-session-b") capturedB = opts.onActiveCall;
        return { id: name, agentName: "claude" } as SessionHandle;
      }),
      sendTurn: mock(async (handle: SessionHandle) => {
        if (handle.id === "nax-session-a") {
          capturedA?.("call-a", async () => {});
          await registry.get("call-a")?.();
          await allowBToFinish;
          throw new SessionTurnError("Agent session ended with stop reason: error (externally cancelled)", true);
        }
        if (handle.id === "nax-session-b") {
          capturedB?.("call-b", async () => {});
          releaseB?.();
          return MOCK_TURN;
        }
        return MOCK_TURN;
      }),
    });

    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ watchdogControllerRegistry: registry });
    const handleA = await sm.openSession("nax-session-a", makeOpenRequest());
    const handleB = await sm.openSession("nax-session-b", makeOpenRequest());

    const promiseA = sm.sendPrompt(handleA, "prompt-a").catch((err) => err);
    const promiseB = sm.sendPrompt(handleB, "prompt-b");
    const [resultA] = await Promise.all([promiseA, promiseB]);

    expect(resultA).toBeInstanceOf(SessionFailureError);
    expect((resultA as SessionFailureError).adapterFailure.outcome).toBe("fail-stale");
    expect((resultA as SessionFailureError).adapterFailure.reason).toBe("idle-watchdog");
  });

  test("forwards maxTurns to adapter.sendTurn", async () => {
    let capturedMaxTurns: number | undefined;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async (_h: SessionHandle, _p: string, opts: SendTurnOpts) => {
        capturedMaxTurns = opts.maxTurns;
        return MOCK_TURN;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-maxturn-test", makeOpenRequest());
    await sm.sendPrompt(handle, "test", { maxTurns: 5 });
    expect(capturedMaxTurns).toBe(5);
  });
});

// ─── runInSession() — prompt form ─────────────────────────────────────────────

describe("runInSession() — prompt form", () => {
  test("opens, sends prompt, and closes session (try/finally)", async () => {
    let closeCalled = false;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => MOCK_TURN),
      closeSession: mock(async () => {
        closeCalled = true;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });

    const result = await sm.runInSession("nax-prompt-form", "write a test", makeRunOpts());
    expect(result.output).toBe("hello world");
    expect(closeCalled).toBe(true);
  });

  test("closes session even when sendPrompt throws", async () => {
    let closeCalled = false;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => {
        throw new Error("turn failed");
      }),
      closeSession: mock(async () => {
        closeCalled = true;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });

    await expect(sm.runInSession("nax-throw-form", "bad prompt", makeRunOpts())).rejects.toThrow("turn failed");
    expect(closeCalled).toBe(true);
  });
});

// ─── runInSession() — callback form ───────────────────────────────────────────

describe("runInSession() — callback form", () => {
  test("opens, runs callback with live handle, closes session (try/finally)", async () => {
    let closeCalled = false;
    let capturedHandle: SessionHandle | undefined;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      closeSession: mock(async () => {
        closeCalled = true;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });

    const result = await sm.runInSession(
      "nax-callback-form",
      async (handle) => {
        capturedHandle = handle;
        return 42;
      },
      makeRunOpts(),
    );

    expect(result).toBe(42);
    expect(capturedHandle?.id).toBe("nax-callback-form");
    expect(closeCalled).toBe(true);
  });

  test("closes session even when callback throws", async () => {
    let closeCalled = false;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      closeSession: mock(async () => {
        closeCalled = true;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });

    await expect(
      sm.runInSession(
        "nax-callback-throw",
        async () => {
          throw new Error("callback failed");
        },
        makeRunOpts(),
      ),
    ).rejects.toThrow("callback failed");
    expect(closeCalled).toBe(true);
  });
});
