import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { assertCaughtInstanceOf, assertDefined, makeAgentAdapter } from "@test/helpers";
import { NO_OP_INTERACTION_HANDLER } from "@/agents";
import type { OpenSessionOpts, SendTurnOpts, SessionHandle, TurnResult } from "@/agents/types";
import { SessionFailureError, SessionTurnError } from "@/agents/types";
import { AgentStreamEventBus } from "@/runtime/agent-stream-events";
import { _sessionManagerDeps, SessionManager } from "@/session/manager";
import type { OpenSessionRequest, RunInSessionOpts } from "@/session/types";

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
    assertCaughtInstanceOf(caught, SessionFailureError, "sendPrompt rejection");
    expect(caught.adapterFailure.outcome).toBe("fail-stale");
    expect(caught.adapterFailure.category).toBe("availability");
    expect(caught.adapterFailure.retriable).toBe(true);
    expect(caught.adapterFailure.reason).toBe("idle-watchdog");
  });

  test("rewraps a plain abort error as fail-stale when the watchdog triggered the cancel (native transport, nax#2218)", async () => {
    // nax#2218: the native adapter surfaces the watchdog's turnController.abort()
    // as a plain AbortError ("The operation was aborted.") — nothing rewraps it
    // into SessionTurnError(cancelled:true) the way the ACP path does. sendPrompt
    // must still consult the watchdog bookkeeping and classify fail-stale,
    // otherwise the error poisons the warm session and the same-agent retry dies
    // on the SESSION_CANCELLED guard without reaching a model.
    let capturedActiveCall: ((callId: string, cancel: () => Promise<void>) => void) | undefined;
    const registry = new Map<string, () => Promise<void>>();
    let firstTurn = true;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        capturedActiveCall = opts.onActiveCall;
        return { id: name, agentName: "claude" } as SessionHandle;
      }),
      sendTurn: mock(async () => {
        if (!firstTurn) return MOCK_TURN;
        firstTurn = false;
        // 1. The adapter publishes its in-flight call via onActiveCall.
        capturedActiveCall?.("call-native", async () => {});
        // 2. The watchdog fires: the wrapper records "call-native" in bookkeeping.
        await registry.get("call-native")?.();
        // 3. The abort rejects the in-flight client call; the native adapter
        //    rethrows it unmodified (only protocol faults are wrapped).
        throw new DOMException("The operation was aborted.", "AbortError");
      }),
    });

    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ watchdogControllerRegistry: registry });
    const handle = await sm.openSession("nax-stale-native-test", makeOpenRequest());

    let caught: unknown;
    try {
      await sm.sendPrompt(handle, "test");
    } catch (err) {
      caught = err;
    }
    assertCaughtInstanceOf(caught, SessionFailureError, "sendPrompt rejection");
    expect(caught.adapterFailure.outcome).toBe("fail-stale");
    expect(caught.adapterFailure.category).toBe("availability");
    expect(caught.adapterFailure.retriable).toBe(true);
    expect(caught.adapterFailure.reason).toBe("idle-watchdog");

    // The watchdog cancel must NOT poison the warm session: the descriptor stays
    // RUNNING and the same-agent retry dispatches on the same handle instead of
    // dying on the SESSION_CANCELLED guard (nax#2218 — the wasted iteration).
    expect(sm.descriptor("nax-stale-native-test")?.state).toBe("RUNNING");
    const retried = await sm.sendPrompt(handle, "retry");
    expect(retried.output).toBe(MOCK_TURN.output);
  });

  test("does not rewrap a plain abort error when the caller's signal aborted (run-level abort keeps the generic branch)", async () => {
    // A caller-signalled abort (run-level abort / queue ABORT) is never the
    // watchdog's decision: the session must stay poisoned and the raw error
    // must flow through so an aborting run does not retry into its own teardown.
    let capturedActiveCall: ((callId: string, cancel: () => Promise<void>) => void) | undefined;
    const registry = new Map<string, () => Promise<void>>();
    const controller = new AbortController();
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        capturedActiveCall = opts.onActiveCall;
        return { id: name, agentName: "claude" } as SessionHandle;
      }),
      sendTurn: mock(async () => {
        capturedActiveCall?.("call-run-abort", async () => {});
        await registry.get("call-run-abort")?.();
        throw new DOMException("The operation was aborted.", "AbortError");
      }),
    });

    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ watchdogControllerRegistry: registry });
    const handle = await sm.openSession("nax-run-abort-test", makeOpenRequest());
    controller.abort();

    let caught: unknown;
    try {
      await sm.sendPrompt(handle, "test", { signal: controller.signal });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(SessionFailureError);
    assertCaughtInstanceOf(caught, Error, "sendPrompt rejection");
    expect(caught.name).toBe("AbortError");
    // Generic branch behavior preserved: the session is poisoned.
    await expect(sm.sendPrompt(handle, "after abort")).rejects.toMatchObject({
      code: "SESSION_CANCELLED",
    });
  });

  test("does not rewrap a plain abort error when the watchdog did not trigger the cancel", async () => {
    // An AbortError with empty watchdog bookkeeping is an unrelated external
    // kill — the generic abort branch must keep handling it (poison + rethrow).
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      }),
    });

    const registry = new Map<string, () => Promise<void>>();
    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ watchdogControllerRegistry: registry });
    const handle = await sm.openSession("nax-external-abort-test", makeOpenRequest());

    let caught: unknown;
    try {
      await sm.sendPrompt(handle, "test");
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(SessionFailureError);
    assertCaughtInstanceOf(caught, Error, "sendPrompt rejection");
    expect(caught.name).toBe("AbortError");
    await expect(sm.sendPrompt(handle, "after abort")).rejects.toMatchObject({
      code: "SESSION_CANCELLED",
    });
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
    assertCaughtInstanceOf(caught, SessionFailureError, "sendPrompt rejection");
    expect(caught.adapterFailure.outcome).toBe("fail-stale");
    expect(caught.adapterFailure.reason).toBe("idle-watchdog");
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

    assertCaughtInstanceOf(resultA, SessionFailureError, "promptA rejection");
    expect(resultA.adapterFailure.outcome).toBe("fail-stale");
    expect(resultA.adapterFailure.reason).toBe("idle-watchdog");
  });

  test("forwards maxInteractions to adapter.sendTurn", async () => {
    let capturedMaxInteractions: number | undefined;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async (_h: SessionHandle, _p: string, opts: SendTurnOpts) => {
        capturedMaxInteractions = opts.maxInteractions;
        return MOCK_TURN;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-maxturn-test", makeOpenRequest());
    await sm.sendPrompt(handle, "test", { maxInteractions: 5 });
    expect(capturedMaxInteractions).toBe(5);
  });

  test("forwards turnId to adapter.sendTurn", async () => {
    let capturedTurnId: string | undefined;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string): Promise<SessionHandle> => ({ id: name, agentName: "claude" })),
      sendTurn: mock(async (_h: SessionHandle, _p: string, opts: SendTurnOpts) => {
        capturedTurnId = opts.turnId;
        return MOCK_TURN;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-turnid-test", makeOpenRequest());
    await sm.sendPrompt(handle, "test", { turnId: "turn-42" });
    expect(capturedTurnId).toBe("turn-42");
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

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle methods (Phase 3, Issue #477): resume() and closeStory()
//
// This file hosts the prompt/runInSession suites above; the lifecycle suites
// carry their own deterministic uuid/now/writeDescriptor hooks, scoped to
// this block so the suites above keep running against real deps.
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager lifecycle — resume() and closeStory()", () => {
  let _uuidSeq = 0;
  let _timeSeq = 0;
  const _origUuid = _sessionManagerDeps.uuid;
  const _origNow = _sessionManagerDeps.now;
  const _origWriteDescriptor = _sessionManagerDeps.writeDescriptor;

  beforeEach(() => {
    _uuidSeq = 0;
    _timeSeq = 0;
    _sessionManagerDeps.uuid = () =>
      `00000000-0000-0000-0000-${String(++_uuidSeq).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`;
    _sessionManagerDeps.now = () => `2025-01-01T00:${String(_timeSeq++).padStart(2, "0")}:00.000Z`;
    // Suppress disk writes during unit tests
    _sessionManagerDeps.writeDescriptor = async () => {};
  });

  afterEach(() => {
    _sessionManagerDeps.uuid = _origUuid;
    _sessionManagerDeps.now = _origNow;
    _sessionManagerDeps.writeDescriptor = _origWriteDescriptor;
  });

  describe("SessionManager.resume()", () => {
    test("returns null when no sessions exist", () => {
      const mgr = new SessionManager();
      expect(mgr.resume("US-001", "implementer")).toBeNull();
    });

    test("returns null when storyId doesn't match", () => {
      const mgr = new SessionManager();
      mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-002" });
      expect(mgr.resume("US-001", "implementer")).toBeNull();
    });

    test("returns null when role doesn't match", () => {
      const mgr = new SessionManager();
      mgr.create({ role: "test-writer", agent: "claude", workdir: "/p", storyId: "US-001" });
      expect(mgr.resume("US-001", "implementer")).toBeNull();
    });

    test.each([
      [
        "COMPLETED",
        (mgr: SessionManager, id: string) => {
          mgr.transition(id, "RUNNING");
          mgr.closeStory("US-001");
        },
      ],
      [
        "FAILED",
        (mgr: SessionManager, id: string) => {
          mgr.transition(id, "RUNNING");
          mgr.transition(id, "FAILED");
        },
      ],
    ])("returns null for %s sessions", (_state, setupFn) => {
      const mgr = new SessionManager();
      const desc = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
      setupFn(mgr, desc.id);
      expect(mgr.resume("US-001", "implementer")).toBeNull();
    });

    test("returns the descriptor for a CREATED session", () => {
      const mgr = new SessionManager();
      const created = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
      const found = mgr.resume("US-001", "implementer");
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.state).toBe("CREATED");
    });

    test("returns the descriptor for a RUNNING session", () => {
      const mgr = new SessionManager();
      const desc = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
      mgr.transition(desc.id, "RUNNING");
      const found = mgr.resume("US-001", "implementer");
      expect(found?.state).toBe("RUNNING");
    });

    test("returns an immutable copy — mutations don't affect registry", () => {
      const mgr = new SessionManager();
      mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
      const found = mgr.resume("US-001", "implementer");
      assertDefined(found, "resume result");
      (found as { agent: string }).agent = "mutated";
      const again = mgr.resume("US-001", "implementer");
      assertDefined(again, "second resume result");
      expect(again.agent).toBe("claude");
    });

    test("returns first matching non-terminal when multiple sessions exist for same storyId+role", () => {
      const mgr = new SessionManager();
      const a = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
      mgr.transition(a.id, "RUNNING");
      mgr.transition(a.id, "FAILED"); // terminal
      mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
      const found = mgr.resume("US-001", "implementer");
      expect(found).not.toBeNull();
      expect(found?.state).not.toBe("FAILED");
    });
  });

  describe("SessionManager.closeStory()", () => {
    test("returns empty array when no sessions exist for the story", () => {
      const mgr = new SessionManager();
      const closed = mgr.closeStory("US-001");
      expect(closed).toHaveLength(0);
    });

    test("returns empty array when all sessions are already terminal", () => {
      const mgr = new SessionManager();
      const desc = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
      mgr.transition(desc.id, "RUNNING");
      mgr.transition(desc.id, "FAILED");
      const closed = mgr.closeStory("US-001");
      expect(closed).toHaveLength(0);
    });

    test.each([
      ["CREATED", [] as string[]],
      ["RUNNING", ["RUNNING"] as string[]],
    ])("transitions a %s session to COMPLETED", (_state, extraTransitions) => {
      const mgr = new SessionManager();
      const desc = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
      for (const t of extraTransitions) mgr.transition(desc.id, t as Parameters<typeof mgr.transition>[1]);
      const closed = mgr.closeStory("US-001");
      expect(closed).toHaveLength(1);
      expect(closed[0].state).toBe("COMPLETED");
      // MEM-1: closeStory now deletes the descriptor (was retained with state=COMPLETED).
      // The returned `closed` array carries the final state for callers; the descriptor
      // is no longer retrievable from the manager.
      expect(mgr.get(desc.id)).toBeNull();
    });

    test("transitions multiple sessions for the same story", () => {
      const mgr = new SessionManager();
      mgr.create({ role: "test-writer", agent: "claude", workdir: "/p", storyId: "US-001" });
      mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
      const closed = mgr.closeStory("US-001");
      expect(closed).toHaveLength(2);
      expect(closed.every((s) => s.state === "COMPLETED")).toBe(true);
    });

    test("does not affect sessions for other stories", () => {
      const mgr = new SessionManager();
      mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
      const other = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-002" });
      mgr.closeStory("US-001");
      expect(mgr.get(other.id)?.state).toBe("CREATED");
    });

    test("updates lastActivityAt on closed sessions", () => {
      const mgr = new SessionManager();
      const desc = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
      const priorActivity = desc.lastActivityAt;
      const closed = mgr.closeStory("US-001");
      // MEM-1: closeStory now deletes the descriptor (was retained with the new
      // lastActivityAt). The returned `closed` array carries the final descriptor,
      // so the timestamp is verifiable there.
      expect(closed).toHaveLength(1);
      const closedEntry = closed[0];
      assertDefined(closedEntry, "closed[0]");
      expect(closedEntry.lastActivityAt).not.toBe(priorActivity);
    });

    test("skips already-COMPLETED sessions", () => {
      const mgr = new SessionManager();
      const desc = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
      mgr.transition(desc.id, "RUNNING");
      mgr.transition(desc.id, "COMPLETED");
      const session = mgr.get(desc.id);
      assertDefined(session, "mgr.get(desc.id)");
      const firstActivity = session.lastActivityAt;
      mgr.closeStory("US-001"); // second call — should no-op
      const afterClose = mgr.get(desc.id);
      assertDefined(afterClose, "mgr.get(desc.id) after closeStory");
      expect(afterClose.lastActivityAt).toBe(firstActivity);
    });

    test("resume() returns null after closeStory()", () => {
      const mgr = new SessionManager();
      mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
      mgr.closeStory("US-001");
      expect(mgr.resume("US-001", "implementer")).toBeNull();
    });

    test.each([
      ["PAUSED", ["RUNNING", "PAUSED"]],
      ["RESUMING", ["RUNNING", "PAUSED", "RESUMING"]],
      ["CLOSING", ["RUNNING", "CLOSING"]],
    ])("force-closes %s session", (_state, transitions) => {
      const mgr = new SessionManager();
      const desc = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
      for (const t of transitions) mgr.transition(desc.id, t as Parameters<typeof mgr.transition>[1]);
      const closed = mgr.closeStory("US-001");
      expect(closed).toHaveLength(1);
      expect(closed[0].state).toBe("COMPLETED");
    });

    test("resume() returns null for PAUSED session after closeStory()", () => {
      const mgr = new SessionManager();
      const desc = mgr.create({ role: "implementer", agent: "claude", workdir: "/p", storyId: "US-001" });
      mgr.transition(desc.id, "RUNNING");
      mgr.transition(desc.id, "PAUSED");
      mgr.closeStory("US-001");
      expect(mgr.resume("US-001", "implementer")).toBeNull();
    });
  });
});
