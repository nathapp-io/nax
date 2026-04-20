/**
 * SessionManager.runInSession — eager protocolId binding via
 * onSessionEstablished (#591).
 *
 * Invariant: if the runner fires the onSessionEstablished callback before
 * completing (e.g. right after the physical session is opened), the
 * descriptor must carry the protocolIds BEFORE the runner returns. If the
 * run is then interrupted (SIGINT, crash, first-turn failure), the on-disk
 * descriptor still has the correlation needed to resume.
 */

import { describe, expect, test } from "bun:test";
import type { AgentRunRequest } from "../../../src/agents/manager-types";
import type { AgentResult, AgentRunOptions } from "../../../src/agents/types";
import type { IAgentManager } from "../../../src/agents";
import type { NaxConfig } from "../../../src/config";
import { SessionManager } from "../../../src/session/manager";

function makeOptions(): AgentRunOptions {
  return {
    prompt: "test",
    workdir: "/tmp/x",
    modelTier: "fast",
    modelDef: { provider: "anthropic", model: "claude-haiku", env: {} },
    timeoutSeconds: 30,
    config: {} as NaxConfig,
  };
}

function makeBaseResult(): AgentResult {
  return {
    success: true,
    exitCode: 0,
    output: "ok",
    rateLimited: false,
    durationMs: 100,
    estimatedCost: 0.01,
  };
}

function makeAgentManager(runFn: (req: AgentRunRequest) => Promise<AgentResult>): IAgentManager {
  return {
    getDefault: () => "claude",
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: async (req) => ({ result: await runFn(req), fallbacks: [] }),
    completeWithFallback: async () => ({
      result: { output: "", costUsd: 0, source: "fallback" as const },
      fallbacks: [],
    }),
    run: runFn,
    complete: async () => ({ output: "", costUsd: 0, source: "fallback" as const }),
    getAgent: () => undefined,
    events: { on: () => {} },
  };
}

function makeRequest(extraOpts?: Partial<AgentRunOptions>): AgentRunRequest {
  return { runOptions: { ...makeOptions(), ...extraOpts } };
}

describe("SessionManager.runInSession — onSessionEstablished (#591)", () => {
  test("fires onSessionEstablished and binds handle + protocolIds before runner returns", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });

    expect(mgr.get(d.id)?.protocolIds).toEqual({ recordId: null, sessionId: null });
    expect(mgr.get(d.id)?.handle).toBeUndefined();

    type Observed = { protocolIds: unknown; handle: unknown };
    let observedDuringRun: Observed | null = null;

    const agentMgr = makeAgentManager(async (req) => {
      req.runOptions.onSessionEstablished?.({ recordId: "rec-early", sessionId: "sess-early" }, "nax-early-handle");
      observedDuringRun = {
        protocolIds: mgr.get(d.id)?.protocolIds,
        handle: mgr.get(d.id)?.handle,
      };
      return makeBaseResult();
    });

    await mgr.runInSession(d.id, agentMgr, makeRequest());

    if (!observedDuringRun) throw new Error("runner never observed descriptor state");
    const captured: Observed = observedDuringRun;
    expect(captured.protocolIds).toEqual({ recordId: "rec-early", sessionId: "sess-early" });
    expect(captured.handle).toBe("nax-early-handle");
  });

  test("descriptor retains protocolIds even if the runner throws after onSessionEstablished fires", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });

    let caught: unknown;
    const agentMgr = makeAgentManager(async (req) => {
      req.runOptions.onSessionEstablished?.({ recordId: "rec-crash", sessionId: "sess-crash" }, "nax-crash-handle");
      throw new Error("runner crashed mid-flight");
    });

    try {
      await mgr.runInSession(d.id, agentMgr, makeRequest());
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(mgr.get(d.id)?.protocolIds).toEqual({ recordId: "rec-crash", sessionId: "sess-crash" });
    expect(mgr.get(d.id)?.handle).toBe("nax-crash-handle");
    expect(mgr.get(d.id)?.state).toBe("FAILED");
  });

  test("chains caller-provided onSessionEstablished after the manager's own", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });

    const callerCalls: Array<{ ids: unknown; name: string }> = [];
    const callerCallback = (ids: unknown, name: string) => {
      callerCalls.push({ ids, name });
    };

    const agentMgr = makeAgentManager(async (req) => {
      req.runOptions.onSessionEstablished?.({ recordId: "rec-1", sessionId: "sess-1" }, "nax-chain");
      return makeBaseResult();
    });

    await mgr.runInSession(d.id, agentMgr, makeRequest({ onSessionEstablished: callerCallback }));

    expect(mgr.get(d.id)?.handle).toBe("nax-chain");
    expect(mgr.get(d.id)?.protocolIds).toEqual({ recordId: "rec-1", sessionId: "sess-1" });
    expect(callerCalls).toHaveLength(1);
    expect(callerCalls[0]).toEqual({
      ids: { recordId: "rec-1", sessionId: "sess-1" },
      name: "nax-chain",
    });
  });

  test("no-op when the runner never fires the callback (legacy adapter path)", async () => {
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x", handle: "pre-existing" });

    const agentMgr = makeAgentManager(async () => ({
      ...makeBaseResult(),
      protocolIds: { recordId: "rec-late", sessionId: "sess-late" },
    }));

    await mgr.runInSession(d.id, agentMgr, makeRequest());

    expect(mgr.get(d.id)?.protocolIds).toEqual({ recordId: "rec-late", sessionId: "sess-late" });
    expect(mgr.get(d.id)?.handle).toBe("pre-existing");
  });
});
