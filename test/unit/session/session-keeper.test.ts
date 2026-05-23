/**
 * SessionKeeper Tests
 *
 * Tests the SessionKeeper class which manages session reuse and transport retry.
 * SessionKeeper encapsulates the ~75-line getLiveHandle → openSession →
 * transport-retry → bindHandle pattern used in rectification loops.
 */

import { describe, test, expect, mock } from "bun:test";
import type { SessionHandle, TurnResult } from "../../../src/agents/types";
import { SessionTurnError } from "../../../src/agents/types";
import type { ModelDef } from "../../../src/config/schema";
import type { RetryStrategy, RetryDecision } from "../../../src/agents/retry";
import { makeSessionManager, makeMockAgentManager } from "../../helpers";
import { SessionKeeper } from "../../../src/session/session-keeper";
import type { SessionKeeperOptions } from "../../../src/session/session-keeper";

function makeOpts(overrides: Partial<SessionKeeperOptions> = {}): SessionKeeperOptions {
  return {
    sessionName: "nax-test-session",
    defaultAgent: "claude",
    role: "implementer",
    pipelineStage: "rectification",
    storyId: "US-001",
    featureName: "test-feature",
    workdir: "/tmp/test",
    modelDef: { provider: "anthropic", model: "claude-opus" } as ModelDef,
    timeoutSeconds: 300,
    ...overrides,
  };
}

function makeTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    output: "test output",
    tokenUsage: { inputTokens: 10, outputTokens: 20 },
    estimatedCostUsd: 0.001,
    internalRoundTrips: 1,
    ...overrides,
  };
}

function makeSessionHandle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    id: "sess-test-handle",
    agentName: "claude",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: send() returns TurnResult on success
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionKeeper.send()", () => {
  describe("AC-1: returns TurnResult on success", () => {
    test("returns the TurnResult from agentManager.runAsSession on successful run", async () => {
      const sessionManager = makeSessionManager({
        openSession: mock(async () => makeSessionHandle({ agentName: "claude" })),
        getLiveHandle: mock(() => undefined),
        closeSession: mock(async () => {}),
      });

      const expectedTurnResult = makeTurnResult({ output: "success" });
      const agentManager = makeMockAgentManager({
        runAsSessionFn: mock(async () => expectedTurnResult),
      });

      const keeper = new SessionKeeper(sessionManager, agentManager, makeOpts());
      const result = await keeper.send({ prompt: "test prompt" });
      expect(result).toEqual(expectedTurnResult);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // AC-2: Always calls openSession (no getLiveHandle shortcut — PR #1060)
  //
  // The previous AC-2 spec said "calls getLiveHandle before openSession" and
  // "reuses live handle when getLiveHandle returns a matching handle". That
  // shortcut was removed because closeStory marks sessions COMPLETED after main
  // execution, so deferred rectification could grab a stale handle that
  // crashed on sendPrompt. SessionKeeper now always goes through openSession
  // (which is idempotent on a live handle and recovers stale entries via the
  // terminal-state guard).
  // ─────────────────────────────────────────────────────────────────────────────

  describe("AC-2: always calls openSession (PR #1060 stale-handle fix)", () => {
    test("calls sessionManager.openSession on every send (no getLiveHandle shortcut)", async () => {
      const sessionName = "nax-test-session";
      let openSessionCalled = false;
      let openSessionName: string | undefined;

      const sessionManager = makeSessionManager({
        openSession: mock(async (name: string) => {
          openSessionCalled = true;
          openSessionName = name;
          return makeSessionHandle({ agentName: "claude" });
        }),
        closeSession: mock(async () => {}),
      });

      const agentManager = makeMockAgentManager({
        runAsSessionFn: mock(async () => makeTurnResult()),
      });

      const keeper = new SessionKeeper(sessionManager, agentManager, makeOpts({ sessionName }));
      await keeper.send({ prompt: "test" });
      expect(openSessionCalled).toBe(true);
      expect(openSessionName).toBe(sessionName);
    });

    test("does NOT consult getLiveHandle even when a live handle would match", async () => {
      // Regression guard: PR #1060 — closeStory left COMPLETED handles in _liveHandles,
      // so reusing them by name caused terminal-state errors on sendPrompt.
      const sessionName = "nax-test-session";
      let getLiveHandleCalled = false;
      let openSessionCalled = false;

      const sessionManager = makeSessionManager({
        getLiveHandle: mock(() => {
          getLiveHandleCalled = true;
          return makeSessionHandle({ agentName: "claude" });
        }),
        openSession: mock(async () => {
          openSessionCalled = true;
          return makeSessionHandle({ agentName: "claude" });
        }),
        closeSession: mock(async () => {}),
      });

      const agentManager = makeMockAgentManager({
        runAsSessionFn: mock(async () => makeTurnResult()),
      });

      const keeper = new SessionKeeper(sessionManager, agentManager, makeOpts({ sessionName }));
      await keeper.send({ prompt: "test" });
      expect(getLiveHandleCalled).toBe(false);
      expect(openSessionCalled).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // AC-3: Opens new session when no matching live handle exists
  // ─────────────────────────────────────────────────────────────────────────────

  describe("AC-3: opens new session when no matching live handle", () => {
    test("calls sessionManager.openSession when getLiveHandle returns undefined", async () => {
      let openSessionCalled = false;
      const expectedHandle = makeSessionHandle({ agentName: "claude" });

      const sessionManager = makeSessionManager({
        getLiveHandle: mock(() => undefined),
        openSession: mock(async () => {
          openSessionCalled = true;
          return expectedHandle;
        }),
        closeSession: mock(async () => {}),
      });

      const agentManager = makeMockAgentManager({
        runAsSessionFn: mock(async () => makeTurnResult()),
      });

      const keeper = new SessionKeeper(sessionManager, agentManager, makeOpts({ sessionName: "nax-test" }));
      await keeper.send({ prompt: "test" });
      expect(openSessionCalled).toBe(true);
    });

    test("uses the opened handle for agent.runAsSession call", async () => {
      const openedHandle = makeSessionHandle({ id: "sess-new-123", agentName: "claude" });
      let agentRunCalledWithHandle = false;

      const sessionManager = makeSessionManager({
        getLiveHandle: mock(() => undefined),
        openSession: mock(async () => openedHandle),
        closeSession: mock(async () => {}),
      });

      const agentManager = makeMockAgentManager({
        // Mock receives (agentName, handle, prompt, opts) via the runAsSession path (mock-agent-manager casts as any)
        runAsSessionFn: mock(async (_agentName: string, _handle: SessionHandle) => {
          agentRunCalledWithHandle = true;
          return makeTurnResult();
        }) as any,
      });

      const keeper = new SessionKeeper(sessionManager, agentManager, makeOpts({ sessionName: "nax-test" }));
      await keeper.send({ prompt: "test" });
      expect(agentRunCalledWithHandle).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // AC-4: Retries on SessionTurnError with retryable=true when strategy allows
  // ─────────────────────────────────────────────────────────────────────────────

  describe("AC-4: retries on SessionTurnError with retryable=true when strategy allows", () => {
    test("closes stale handle and retries when retryStrategy.shouldRetry returns retry:true", async () => {
      const failingHandle = makeSessionHandle({ id: "sess-stale" });
      const retriedHandle = makeSessionHandle({ id: "sess-retried" });
      let closeSessionCalledWithHandle: SessionHandle | undefined;
      let retryAttempts = 0;

      let openCalls = 0;
      const sessionManager = makeSessionManager({
        closeSession: mock(async (h: SessionHandle) => {
          closeSessionCalledWithHandle = h;
        }),
        openSession: mock(async () => {
          openCalls++;
          return openCalls === 1 ? failingHandle : retriedHandle;
        }),
      });

      const retryableError = new SessionTurnError("Session lost", false, true);

      const agentManager = makeMockAgentManager({
        // Mock receives (agentName, handle, prompt, opts) via the runAsSession path (mock-agent-manager casts as any)
        runAsSessionFn: mock(async (_agentName: string, _handle: SessionHandle) => {
          retryAttempts++;
          if (retryAttempts === 1) {
            throw retryableError;
          }
          return makeTurnResult({ output: "recovered" });
        }) as any,
      });

      const retryStrategy: RetryStrategy = {
        shouldRetry: mock((): RetryDecision => ({ retry: true, delayMs: 0 })),
      };

      const keeper = new SessionKeeper(sessionManager, agentManager, makeOpts({ retryStrategy }));
      const result = await keeper.send({ prompt: "test" });
      expect(result.output).toBe("recovered");
      expect(retryAttempts).toBe(2);
      expect(closeSessionCalledWithHandle?.id).toBe("sess-stale");
      expect(retryStrategy.shouldRetry).toHaveBeenCalled();
    });

    test("discards stale handle before retrying", async () => {
      const sessionName = "nax-test";
      const failingHandle = makeSessionHandle({ id: "sess-stale" });
      const retriedHandle = makeSessionHandle({ id: "sess-new" });
      const closedHandles: SessionHandle[] = [];

      let openCalls = 0;
      const sessionManager = makeSessionManager({
        closeSession: mock(async (h: SessionHandle) => {
          closedHandles.push(h);
        }),
        openSession: mock(async () => {
          openCalls++;
          // First attempt: return the handle that will fail.
          // Second attempt (after stale handle is closed): return the fresh handle.
          return openCalls === 1 ? failingHandle : retriedHandle;
        }),
      });

      const retryableError = new SessionTurnError("stale", false, true);
      let attempts = 0;

      const agentManager = makeMockAgentManager({
        // Mock receives (agentName, handle, prompt, opts) via the runAsSession path (mock-agent-manager casts as any)
        runAsSessionFn: mock(async (_agentName: string, _handle: SessionHandle) => {
          attempts++;
          if (attempts === 1) throw retryableError;
          return makeTurnResult();
        }) as any,
      });

      const retryStrategy: RetryStrategy = {
        shouldRetry: (): RetryDecision => ({ retry: true, delayMs: 0 }),
      };

      const keeper = new SessionKeeper(sessionManager, agentManager, makeOpts({ sessionName, retryStrategy }));
      await keeper.send({ prompt: "test" });
      expect(closedHandles.length).toBe(1);
      expect(closedHandles[0].id).toBe("sess-stale");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // AC-5: Re-throws when retryStrategy absent or returns retry:false
  // ─────────────────────────────────────────────────────────────────────────────

  describe("AC-5: re-throws when retryStrategy absent or returns retry:false", () => {
    test("re-throws error when retryStrategy is undefined", async () => {
      const sessionManager = makeSessionManager({
        getLiveHandle: mock(() => makeSessionHandle()),
        closeSession: mock(async () => {}),
      });

      const retryableError = new SessionTurnError("retry-me", false, true);

      const agentManager = makeMockAgentManager({
        runAsSessionFn: mock(async () => {
          throw retryableError;
        }),
      });

      const keeper = new SessionKeeper(sessionManager, agentManager, makeOpts({ retryStrategy: undefined }));
      await expect(keeper.send({ prompt: "test" })).rejects.toThrow(SessionTurnError);
    });

    test("re-throws when retryStrategy.shouldRetry returns retry:false", async () => {
      const sessionManager = makeSessionManager({
        getLiveHandle: mock(() => makeSessionHandle()),
        closeSession: mock(async () => {}),
      });

      const retryableError = new SessionTurnError("dont-retry", false, true);

      const agentManager = makeMockAgentManager({
        runAsSessionFn: mock(async () => {
          throw retryableError;
        }),
      });

      const retryStrategy: RetryStrategy = {
        shouldRetry: mock((): RetryDecision => ({ retry: false })),
      };

      const keeper = new SessionKeeper(sessionManager, agentManager, makeOpts({ retryStrategy }));
      await expect(keeper.send({ prompt: "test" })).rejects.toThrow(SessionTurnError);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // AC-6: Re-throws non-retryable SessionTurnError immediately
  // ─────────────────────────────────────────────────────────────────────────────

  describe("AC-6: re-throws non-retryable SessionTurnError immediately", () => {
    test("re-throws when SessionTurnError.retryable=false without calling retryStrategy", async () => {
      const sessionManager = makeSessionManager({
        getLiveHandle: mock(() => makeSessionHandle()),
        closeSession: mock(async () => {}),
      });

      const nonRetryableError = new SessionTurnError("no-retry", false, false);

      const agentManager = makeMockAgentManager({
        runAsSessionFn: mock(async () => {
          throw nonRetryableError;
        }),
      });

      const shouldRetrySpy = mock((): RetryDecision => {
        throw new Error("shouldRetry should NOT be called for non-retryable errors");
      });
      const retryStrategy: RetryStrategy = { shouldRetry: shouldRetrySpy };

      const keeper = new SessionKeeper(sessionManager, agentManager, makeOpts({ retryStrategy }));
      await expect(keeper.send({ prompt: "test" })).rejects.toThrow(SessionTurnError);
      expect(shouldRetrySpy).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7 & AC-8: bindProtocolIds()
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionKeeper.bindProtocolIds()", () => {
  describe("AC-7: calls bindHandle when protocolIds is defined", () => {
    test("calls sessionManager.bindHandle with heldHandle.id and protocolIds", async () => {
      const protocolIds = { recordId: "rec-123", sessionId: "acp-456" };
      const heldHandle = makeSessionHandle({
        id: "sess-with-ids",
        agentName: "claude",
        protocolIds,
      });

      let bindHandleCalledWith: {
        id: string;
        name: string;
        protocolIds: { recordId: string | null; sessionId: string | null };
      } | undefined;

      const sessionManager = makeSessionManager({
        bindHandle: mock(
          (id: string, name: string, pids: { recordId: string | null; sessionId: string | null }) => {
            bindHandleCalledWith = { id, name, protocolIds: pids };
            return { id, state: "RUNNING" } as any;
          },
        ),
        getLiveHandle: mock(() => heldHandle),
        openSession: mock(async () => heldHandle),
        closeSession: mock(async () => {}),
      });

      const agentManager = makeMockAgentManager({
        runAsSessionFn: mock(async () => makeTurnResult()),
      });

      const keeper = new SessionKeeper(sessionManager, agentManager, makeOpts({ sessionName: "nax-test" }));
      await keeper.send({ prompt: "test" });
      keeper.bindProtocolIds();

      expect(bindHandleCalledWith).toEqual({
        id: "sess-with-ids",
        name: "nax-test",
        protocolIds: { recordId: "rec-123", sessionId: "acp-456" },
      });
    });
  });

  describe("AC-8: does not call bindHandle when protocolIds is undefined", () => {
    test("does not call bindHandle when heldHandle.protocolIds is undefined", async () => {
      const heldHandle = makeSessionHandle({ id: "sess-no-ids" });

      let bindHandleCalled = false;

      const sessionManager = makeSessionManager({
        bindHandle: mock(() => {
          bindHandleCalled = true;
          throw new Error("bindHandle should not be called when protocolIds is undefined");
        }),
        getLiveHandle: mock(() => heldHandle),
        openSession: mock(async () => heldHandle),
        closeSession: mock(async () => {}),
      });

      const agentManager = makeMockAgentManager({
        runAsSessionFn: mock(async () => makeTurnResult()),
      });

      const keeper = new SessionKeeper(sessionManager, agentManager, makeOpts({ sessionName: "nax-test" }));
      await keeper.send({ prompt: "test" });
      keeper.bindProtocolIds();
      expect(bindHandleCalled).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-9: close()
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionKeeper.close()", () => {
  describe("AC-9: closes held handle and does not throw when no handle", () => {
    test("calls sessionManager.closeSession when a handle is held", async () => {
      const heldHandle = makeSessionHandle({ id: "sess-to-close" });
      let closeSessionCalledWith: SessionHandle | undefined;

      const sessionManager = makeSessionManager({
        getLiveHandle: mock(() => heldHandle),
        openSession: mock(async () => heldHandle),
        closeSession: mock(async (h: SessionHandle) => {
          closeSessionCalledWith = h;
        }),
      });

      const agentManager = makeMockAgentManager({
        runAsSessionFn: mock(async () => makeTurnResult()),
      });

      const keeper = new SessionKeeper(sessionManager, agentManager, makeOpts({ sessionName: "nax-test" }));
      await keeper.send({ prompt: "test" });
      await keeper.close();
      expect(closeSessionCalledWith).toEqual(heldHandle);
    });

    test("does not throw when no handle is held", async () => {
      const sessionManager = makeSessionManager({
        getLiveHandle: mock(() => undefined),
        closeSession: mock(async () => {}),
      });

      const agentManager = makeMockAgentManager();

      const keeper = new SessionKeeper(sessionManager, agentManager, makeOpts({ sessionName: "nax-test" }));
      await keeper.close(); // should not throw
    });
  });
});

