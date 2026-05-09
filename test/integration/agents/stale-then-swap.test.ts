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
import { AgentManager, SessionFailureError } from "@/agents";
import { buildHopCallback, _buildHopCallbackDeps } from "@/operations";
import type { SessionHandle, TurnResult } from "@/agents/types";
import type { AdapterFailure, ContextBundle } from "@/context/engine";
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
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  _buildHopCallbackDeps.createContextToolRuntime = () => undefined as any;
  // biome-ignore lint/suspicious/noExplicitAny: test stub
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
    const openSession = mock(async (name: string) =>
      name.includes("codex") ? CODEX_HANDLE : CLAUDE_HANDLE,
    );
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
    const openSession = mock(async (name: string) =>
      name.includes("codex") ? CODEX_HANDLE : CLAUDE_HANDLE,
    );
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
