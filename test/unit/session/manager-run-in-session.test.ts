/**
 * SessionManager.runInSession — per-session lifecycle primitive.
 *
 * ADR-013 Phase 1: signature changed from (id, SessionAgentRunner, AgentRunOptions)
 * to (id, IAgentManager, AgentRunRequest, SessionRunOptions?).
 *
 * Contract:
 *   - transitions CREATED → RUNNING before agentManager.run() fires (idempotent —
 *     RESUMING state is left alone)
 *   - binds protocolIds from the result
 *   - transitions RUNNING → COMPLETED on success, RUNNING → FAILED on failure
 *   - on thrown error: marks session FAILED, re-raises
 */

import { describe, expect, mock, test } from "bun:test";
import { SessionManager } from "../../../src/session/manager";
import type { IAgentManager } from "../../../src/agents/manager-types";
import type { AgentRunRequest } from "../../../src/agents/manager-types";
import type { AgentResult } from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";

function makeRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    runOptions: {
      prompt: "test",
      workdir: "/tmp/x",
      modelTier: "fast",
      modelDef: { provider: "anthropic", model: "claude-haiku", env: {} },
      timeoutSeconds: 30,
      config: {} as NaxConfig,
    },
    ...overrides,
  };
}

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: true,
    exitCode: 0,
    output: "ok",
    rateLimited: false,
    durationMs: 100,
    estimatedCost: 0.01,
    ...overrides,
  };
}

function makeAgentManager(result: AgentResult | (() => Promise<AgentResult>)): IAgentManager {
  const runFn = typeof result === "function" ? result : async () => result;
  return {
    getDefault: () => "claude",
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: async (_req) => ({ result: await runFn(), fallbacks: [] }),
    completeWithFallback: async () => ({ result: { output: "", costUsd: 0, source: "fallback" as const }, fallbacks: [] }),
    run: mock(runFn),
    complete: async () => ({ output: "", costUsd: 0, source: "fallback" as const }),
    getAgent: () => undefined,
    events: { on: () => {} },
  };
}

describe("SessionManager.runInSession — ADR-013 Phase 1", () => {
  test("transitions CREATED → RUNNING → COMPLETED on success", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x", handle: "nax-test" });

    const observed: string[] = [];
    const agentMgr = makeAgentManager(async () => {
      observed.push(mgr.get(d.id)?.state ?? "?");
      return makeResult();
    });

    const result = await mgr.runInSession(d.id, agentMgr, makeRequest());

    expect(observed).toEqual(["RUNNING"]);
    expect(mgr.get(d.id)?.state).toBe("COMPLETED");
    expect(result.success).toBe(true);
  });

  test("transitions to FAILED when agentManager.run() returns success=false", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x", handle: "nax-test" });

    await mgr.runInSession(d.id, makeAgentManager(makeResult({ success: false })), makeRequest());

    expect(mgr.get(d.id)?.state).toBe("FAILED");
  });

  test("transitions to FAILED and re-throws when agentManager.run() throws", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x", handle: "nax-test" });

    const err = new Error("runner boom");
    let caught: unknown;
    try {
      await mgr.runInSession(
        d.id,
        makeAgentManager(async () => { throw err; }),
        makeRequest(),
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(err);
    expect(mgr.get(d.id)?.state).toBe("FAILED");
  });

  test("binds protocolIds from agentManager.run() result onto the descriptor", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x", handle: "nax-test" });

    await mgr.runInSession(
      d.id,
      makeAgentManager(makeResult({ protocolIds: { recordId: "rec-1", sessionId: "sess-1" } })),
      makeRequest(),
    );

    expect(mgr.get(d.id)?.protocolIds).toEqual({ recordId: "rec-1", sessionId: "sess-1" });
  });

  test("throws SESSION_NOT_FOUND for unknown id", async () => {
    const mgr = new SessionManager();

    let caught: unknown;
    try {
      await mgr.runInSession("sess-nonexistent", makeAgentManager(makeResult()), makeRequest());
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain("sess-nonexistent");
  });

  test("leaves non-CREATED sessions alone (does not force RUNNING)", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x", handle: "nax-test" });
    mgr.transition(d.id, "RUNNING");
    mgr.transition(d.id, "PAUSED");
    mgr.transition(d.id, "RESUMING");

    const result = await mgr.runInSession(d.id, makeAgentManager(makeResult()), makeRequest());
    expect(result.success).toBe(true);
    expect(mgr.get(d.id)?.state).toBe("RESUMING");
  });

  test("propagates tokenUsage through the returned result unchanged", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x", handle: "nax-test" });

    const result = await mgr.runInSession(
      d.id,
      makeAgentManager(makeResult({
        tokenUsage: { inputTokens: 100, outputTokens: 50, cache_read_input_tokens: 10 },
      })),
      makeRequest(),
    );

    expect(result.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 50, cache_read_input_tokens: 10 });
  });

  test("injects onSessionEstablished into request.runOptions and fires caller callback", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x", handle: "nax-test" });

    let callerFired = false;
    let bindHandleFired = false;

    const origBind = mgr.bindHandle.bind(mgr);
    mgr.bindHandle = mock((...args: Parameters<typeof mgr.bindHandle>) => {
      bindHandleFired = true;
      return origBind(...args);
    });

    const agentMgr: IAgentManager = {
      ...makeAgentManager(makeResult()),
      run: mock(async (req) => {
        // Fire onSessionEstablished as if adapter established a session
        req.runOptions.onSessionEstablished?.({ recordId: "r1", sessionId: "s1" }, "nax-test");
        return makeResult();
      }),
    };

    await mgr.runInSession(
      d.id,
      agentMgr,
      makeRequest({
        runOptions: {
          prompt: "test",
          workdir: "/tmp/x",
          modelTier: "fast",
          modelDef: { provider: "anthropic", model: "m", env: {} },
          timeoutSeconds: 30,
          config: {} as NaxConfig,
          onSessionEstablished: () => { callerFired = true; },
        },
      }),
    );

    expect(callerFired).toBe(true);
    expect(bindHandleFired).toBe(true);
  });
});
