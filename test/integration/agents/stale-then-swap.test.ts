/**
 * Integration test — stale-retry exhaustion → agent swap (#977).
 *
 * Drives the full AgentManager.runWithFallback → buildHopCallback chain
 * without spawning real processes. Verifies the stale-then-swap sequence:
 *   primary (fail-stale) → stale-retry (fail-stale, exhausted) → swap to codex (success).
 *
 * AC from fix plan §186:
 * - closeSession fires TWICE across a fail-stale → swap cycle
 *   (once for primary, once for the swap agent; skipped on stale-retry).
 * - handoff fires ONCE (on swap only; stale-retry must NOT trigger handoff).
 * - The swap hop uses { kind: "swap" }; the retry hop uses { kind: "stale-retry" }.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AgentManager, SessionFailureError, SessionTurnError } from "@/agents";
import type { SessionHandle, TurnResult } from "@/agents/types";
import type { AdapterFailure, ContextBundle } from "@/context/engine";
import { _buildHopCallbackDeps, buildHopCallback } from "@/operations";
import { makeMockAgentManager, makeNaxConfig, makeSessionManager, makeStory } from "@test/helpers";

// ─── Stubs ───────────────────────────────────────────────────────────────────

const CLAUDE_HANDLE: SessionHandle = { id: "ses_claude_01", agentName: "claude" };
const CODEX_HANDLE: SessionHandle = { id: "ses_codex_01", agentName: "codex" };

const STUB_TURN: TurnResult = {
  output: "ok",
  tokenUsage: { inputTokens: 10, outputTokens: 5 },
  estimatedCostUsd: 0.001,
  internalRoundTrips: 1,
};

const STALE_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  retriable: true,
  message: "idle timeout",
};

const STUB_BUNDLE = {
  pushMarkdown: "",
  pullTools: [],
  digest: "",
  manifest: {},
  chunks: [],
} as unknown as ContextBundle;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STUB_RUN_OPTIONS = {
  prompt: "implement the story",
  workdir: "/tmp",
  storyId: "US-977",
  sessionRole: "implementer" as const,
  timeoutSeconds: 30,
} as any;

// Config: one stale retry allowed, then swap to codex
function makeSwapConfig() {
  return makeNaxConfig({
    agent: {
      default: "claude",
      idleWatchdog: { enabled: true, maxRetryAttempts: 1 },
      fallback: {
        enabled: true,
        map: { claude: ["codex"] },
        maxHopsPerStory: 3,
        onQualityFailure: false,
        rebuildContext: false,
      },
    },
  });
}

// ─── Dep injection save/restore ───────────────────────────────────────────────

let origCreateContextToolRuntime: typeof _buildHopCallbackDeps.createContextToolRuntime;
let origRebuildForAgent: typeof _buildHopCallbackDeps.rebuildForAgent;

beforeEach(() => {
  origCreateContextToolRuntime = _buildHopCallbackDeps.createContextToolRuntime;
  origRebuildForAgent = _buildHopCallbackDeps.rebuildForAgent;
  _buildHopCallbackDeps.createContextToolRuntime = () => undefined as any;
  _buildHopCallbackDeps.rebuildForAgent = (prior) => prior as any;
});

afterEach(() => {
  _buildHopCallbackDeps.createContextToolRuntime = origCreateContextToolRuntime;
  _buildHopCallbackDeps.rebuildForAgent = origRebuildForAgent;
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function makeHopCtx(
  sessionMgr: ReturnType<typeof makeSessionManager>,
  runAsSessionFn: Parameters<typeof makeMockAgentManager>[0]["runAsSessionFn"],
) {
  return {
    sessionManager: sessionMgr,
    agentManager: makeMockAgentManager({ runAsSessionFn }),
    story: makeStory({ id: "US-977" }),
    config: makeNaxConfig(),
    projectDir: undefined,
    featureName: "stale-then-swap-test",
    workdir: "/tmp",
    effectiveTier: "balanced" as const,
    defaultAgent: "claude",
    pipelineStage: "run" as const,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("stale-then-swap — full runWithFallback loop", () => {
  test("handoff fires once (swap only); stale-retry does NOT trigger handoff", async () => {
    const manager = new AgentManager(makeSwapConfig());

    const handoff = mock(() => ({ id: "sess-001", state: "RUNNING" }) as any);
    const getLiveHandle = mock((_name: string) => CLAUDE_HANDLE);
    const openSession = mock(async (name: string) => (name.includes("codex") ? CODEX_HANDLE : CLAUDE_HANDLE));
    const sessionMgr = makeSessionManager({ handoff, getLiveHandle, openSession });

    let sendCallCount = 0;
    const runAsSessionFn = mock(async (agentName: string) => {
      sendCallCount++;
      if (agentName === "claude") {
        // Both claude hops (primary + stale-retry) fail stale
        throw new SessionFailureError("idle timeout", STALE_FAILURE);
      }
      // Codex (swap) succeeds
      return STUB_TURN;
    });

    const ctx = makeHopCtx(sessionMgr, runAsSessionFn);
    const hopCb = buildHopCallback(ctx, "sess-001", STUB_RUN_OPTIONS);
    const outcome = await manager.runWithFallback({
      runOptions: STUB_RUN_OPTIONS,
      bundle: STUB_BUNDLE,
      executeHop: hopCb,
    });

    expect(outcome.result.success).toBe(true);
    expect(sendCallCount).toBe(3); // primary claude, stale-retry claude, swap codex

    // handoff fires exactly once — on the swap, not on stale-retry
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(handoff).toHaveBeenCalledWith("sess-001", "codex", STALE_FAILURE.outcome);
  });

  test("closeSession fires twice (primary + swap agent), skipped for stale-retry", async () => {
    const manager = new AgentManager(makeSwapConfig());

    const closeSession = mock(async () => {});
    const getLiveHandle = mock((_name: string) => CLAUDE_HANDLE);
    const openSession = mock(async (name: string) => (name.includes("codex") ? CODEX_HANDLE : CLAUDE_HANDLE));
    const sessionMgr = makeSessionManager({ closeSession, getLiveHandle, openSession });

    let sendCallCount = 0;
    const runAsSessionFn = mock(async (agentName: string) => {
      sendCallCount++;
      if (agentName === "claude") throw new SessionFailureError("idle timeout", STALE_FAILURE);
      return STUB_TURN;
    });

    const ctx = makeHopCtx(sessionMgr, runAsSessionFn);
    const hopCb = buildHopCallback(ctx, undefined, STUB_RUN_OPTIONS);
    const outcome = await manager.runWithFallback({
      runOptions: STUB_RUN_OPTIONS,
      bundle: STUB_BUNDLE,
      executeHop: hopCb,
    });

    expect(outcome.result.success).toBe(true);

    // openSession: 2 (primary claude + swap codex; stale-retry reuses handle)
    expect(openSession).toHaveBeenCalledTimes(2);
    // closeSession: 2 (primary claude + swap codex; stale-retry skips finally)
    expect(closeSession).toHaveBeenCalledTimes(2);
    // getLiveHandle: 1 (only on the stale-retry hop)
    expect(getLiveHandle).toHaveBeenCalledTimes(1);
  });

  test("full hop sequence: primary(stale) → stale-retry(stale,exhausted) → swap(success)", async () => {
    const manager = new AgentManager(makeSwapConfig());

    const agents: string[] = [];
    const getLiveHandle = mock((_name: string) => CLAUDE_HANDLE);
    const sessionMgr = makeSessionManager({ getLiveHandle });

    let sendCallCount = 0;
    const runAsSessionFn = mock(async (agentName: string) => {
      agents.push(agentName);
      sendCallCount++;
      if (agentName === "claude") throw new SessionFailureError("idle timeout", STALE_FAILURE);
      return STUB_TURN;
    });

    const ctx = makeHopCtx(sessionMgr, runAsSessionFn);
    const hopCb = buildHopCallback(ctx, undefined, STUB_RUN_OPTIONS);
    const outcome = await manager.runWithFallback({
      runOptions: STUB_RUN_OPTIONS,
      bundle: STUB_BUNDLE,
      executeHop: hopCb,
    });

    // Three hops total: two claude (primary + stale-retry), one codex (swap)
    expect(sendCallCount).toBe(3);
    expect(agents).toEqual(["claude", "claude", "codex"]);
    expect(outcome.result.success).toBe(true);
    expect(outcome.finalAgent).toBe("codex");
  });
});

describe("fail-adapter-error retry — QUEUE_DISCONNECTED_BEFORE_COMPLETION (#1027 follow-up)", () => {
  // Config: sessionErrorRetryableMaxRetries=2, no fallback agents so retries exhaust cleanly
  function makeAdapterErrorConfig(retryableMax = 2, nonRetryableMax = 1) {
    return makeNaxConfig({
      execution: { sessionErrorRetryableMaxRetries: retryableMax, sessionErrorMaxRetries: nonRetryableMax },
      agent: {
        default: "claude",
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: false },
      },
    });
  }

  test("retryable fail-adapter-error retries up to sessionErrorRetryableMaxRetries then succeeds", async () => {
    const config = makeAdapterErrorConfig(2);
    const manager = new AgentManager(config);

    const openSession = mock(async () => ({ id: "ses_01", agentName: "claude" }) as SessionHandle);
    const sessionMgr = makeSessionManager({ openSession });

    let callCount = 0;
    const runAsSessionFn = mock(async () => {
      callCount++;
      if (callCount <= 2) throw new SessionTurnError("Queue owner disconnected", false, true);
      return STUB_TURN;
    });

    const hopCtx = {
      sessionManager: sessionMgr,
      agentManager: makeMockAgentManager({ runAsSessionFn }),
      story: makeStory({ id: "US-1027" }),
      config,
      featureName: "adapter-error-retry",
      workdir: "/tmp",
      effectiveTier: "balanced" as const,
      defaultAgent: "claude",
      pipelineStage: "run" as const,
    };
    const hopCb = buildHopCallback(hopCtx, undefined, { ...STUB_RUN_OPTIONS, storyId: "US-1027" } as any);
    const outcome = await manager.runWithFallback({
      runOptions: { ...STUB_RUN_OPTIONS, storyId: "US-1027", config } as any,
      bundle: STUB_BUNDLE,
      executeHop: hopCb,
    });

    // 2 retryable failures + 1 success = 3 total calls
    expect(callCount).toBe(3);
    expect(outcome.result.success).toBe(true);
  });

  test("retryable fail-adapter-error exhausted → result is failure (no swap when fallback disabled)", async () => {
    const config = makeAdapterErrorConfig(2);
    const manager = new AgentManager(config);

    const openSession = mock(async () => ({ id: "ses_01", agentName: "claude" }) as SessionHandle);
    const sessionMgr = makeSessionManager({ openSession });

    let callCount = 0;
    const runAsSessionFn = mock(async () => {
      callCount++;
      throw new SessionTurnError("Queue owner disconnected", false, true);
    });

    const hopCtx = {
      sessionManager: sessionMgr,
      agentManager: makeMockAgentManager({ runAsSessionFn }),
      story: makeStory({ id: "US-1027b" }),
      config,
      featureName: "adapter-error-retry-exhaust",
      workdir: "/tmp",
      effectiveTier: "balanced" as const,
      defaultAgent: "claude",
      pipelineStage: "run" as const,
    };
    const hopCb = buildHopCallback(hopCtx, undefined, { ...STUB_RUN_OPTIONS, storyId: "US-1027b" } as any);
    const outcome = await manager.runWithFallback({
      runOptions: { ...STUB_RUN_OPTIONS, storyId: "US-1027b", config } as any,
      bundle: STUB_BUNDLE,
      executeHop: hopCb,
    });

    // 1 primary + 2 retries = 3 total calls (sessionErrorRetryableMaxRetries=2)
    expect(callCount).toBe(3);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-adapter-error");
    expect(outcome.result.adapterFailure?.retriable).toBe(true);
  });

  test("retry reuses live handle (stale-retry style): getLiveHandle called, openSession called once (primary only)", async () => {
    const config = makeAdapterErrorConfig(1);
    const manager = new AgentManager(config);

    const openSession = mock(async () => ({ id: "ses_01", agentName: "claude" }) as SessionHandle);
    const getLiveHandle = mock((_name: string) => ({ id: "ses_01", agentName: "claude" }) as SessionHandle);
    const sessionMgr = makeSessionManager({ openSession, getLiveHandle });

    let callCount = 0;
    const runAsSessionFn = mock(async () => {
      callCount++;
      if (callCount === 1) throw new SessionTurnError("Queue owner disconnected", false, true);
      return STUB_TURN;
    });

    const hopCtx = {
      sessionManager: sessionMgr,
      agentManager: makeMockAgentManager({ runAsSessionFn }),
      story: makeStory({ id: "US-1027c" }),
      config,
      featureName: "adapter-error-fresh-session",
      workdir: "/tmp",
      effectiveTier: "balanced" as const,
      defaultAgent: "claude",
      pipelineStage: "run" as const,
    };
    const hopCb = buildHopCallback(hopCtx, undefined, { ...STUB_RUN_OPTIONS, storyId: "US-1027c" } as any);
    await manager.runWithFallback({
      runOptions: { ...STUB_RUN_OPTIONS, storyId: "US-1027c", config } as any,
      bundle: STUB_BUNDLE,
      executeHop: hopCb,
    });

    // openSession called once (primary only); retry uses getLiveHandle (stale-retry kind)
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(getLiveHandle).toHaveBeenCalledTimes(1);
    expect(callCount).toBe(2);
  });
});
