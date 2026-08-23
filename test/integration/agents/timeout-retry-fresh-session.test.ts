/**
 * US-002 AC5 — timeout-retry hop opens a fresh session, not the cached live handle.
 *
 * Mirrors the stale-retry-session-reuse integration test (#977) but for the
 * new timeout-retry branch:
 * - openSession fires for BOTH the primary and the timeout-retry hop
 *   (no reuse of the cached handle — wall-clock timeout killed the session,
 *    so reusing it would hand the retry a dead handle).
 * - getLiveHandle is NOT called for the timeout-retry hop.
 * - closeSession fires for both hops (fresh session = closed after hop).
 *
 * Also pins AC2: the retry hop receives the half-budget timeoutSeconds when
 * the timeoutRetry callback forwards `resolvedRunOptions` downstream.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AgentManager, SessionFailureError } from "@/agents";
import type { SessionHandle, TurnResult } from "@/agents";
import type { AdapterFailure, ContextBundle } from "@/context/engine";
import { _buildHopCallbackDeps, buildHopCallback } from "@/operations";
import { makeContextBundle, makeMockAgentManager, makeNaxConfig, makeSessionManager, makeStory } from "@test/helpers";

const CLAUDE_HANDLE: SessionHandle = { id: "ses_timeout_retry_1", agentName: "claude" };

const TIMEOUT_FAILURE: AdapterFailure = {
  category: "quality",
  outcome: "fail-timeout",
  retriable: true,
  message: "wall-clock timeout exceeded",
};

const STUB_TURN: TurnResult = {
  output: "ok",
  tokenUsage: { inputTokens: 10, outputTokens: 5 },
  estimatedCostUsd: 0.001,
  internalRoundTrips: 1,
};

const STUB_BUNDLE = makeContextBundle({
  pullTools: [],
  digest: "",
  chunks: [],
});

const STUB_RUN_OPTIONS = {
  prompt: "implement the story",
  workdir: "/tmp",
  storyId: "US-002",
  sessionRole: "implementer" as const,
  timeoutSeconds: 60,
} as any;

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

function makeHopCtx(
  sessionMgr: ReturnType<typeof makeSessionManager>,
  runAsSessionFn: Parameters<typeof makeMockAgentManager>[0]["runAsSessionFn"],
) {
  return {
    sessionManager: sessionMgr,
    agentManager: makeMockAgentManager({ runAsSessionFn }),
    story: makeStory({ id: "US-002" }),
    config: makeNaxConfig(),
    projectDir: undefined,
    featureName: "timeout-retry-fresh-session",
    workdir: "/tmp",
    effectiveTier: "balanced" as const,
    defaultAgent: "claude",
    pipelineStage: "run" as const,
  };
}

describe("AC5 — timeout-retry opens a fresh session, never reuses the cached live handle", () => {
  test("openSession fires for primary AND timeout-retry (fresh session); getLiveHandle never called", async () => {
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        timeoutRetry: { maxAttempts: 1, budgetMultiplier: 0.5 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: true },
      },
    });
    const manager = new AgentManager(config);

    const openSession = mock(async () => CLAUDE_HANDLE);
    const closeSession = mock(async () => {});
    const getLiveHandle = mock((_name: string) => CLAUDE_HANDLE);
    const sessionMgr = makeSessionManager({ openSession, closeSession, getLiveHandle });

    let sendCallCount = 0;
    const runAsSessionFn = mock(async () => {
      sendCallCount++;
      if (sendCallCount === 1) {
        // Primary hop: wall-clock timeout (simulated by SessionFailureError)
        throw new SessionFailureError("wall-clock timeout", TIMEOUT_FAILURE);
      }
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
    expect(sendCallCount).toBe(2);

    // AC5: a fresh session is opened for the timeout-retry hop — openSession
    // fires twice (primary + timeout-retry), getLiveHandle is NEVER called.
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(closeSession).toHaveBeenCalledTimes(2);
    expect(getLiveHandle).not.toHaveBeenCalled();
  });

  test("boundary: the timeout-retry hop's openSession receives half the primary timeoutSeconds", async () => {
    // AC2 at the integration layer: openSession for the retry hop must receive
    // timeoutSeconds = primary × budgetMultiplier. buildHopCallback wires
    // resolvedRunOptions.timeoutSeconds into openSession via the
    // `timeoutSeconds ?? config.execution?.sessionTimeoutSeconds` fallback,
    // so the half-budget value from runWithFallback must reach openSession.
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        timeoutRetry: { maxAttempts: 1, budgetMultiplier: 0.5 },
        fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: true },
      },
    });
    const manager = new AgentManager(config);

    const openSession = mock(async () => CLAUDE_HANDLE);
    const closeSession = mock(async () => {});
    const sessionMgr = makeSessionManager({ openSession, closeSession });

    let sendCallCount = 0;
    const runAsSessionFn = mock(async () => {
      sendCallCount++;
      if (sendCallCount === 1) {
        throw new SessionFailureError("wall-clock timeout", TIMEOUT_FAILURE);
      }
      return STUB_TURN;
    });

    const ctx = makeHopCtx(sessionMgr, runAsSessionFn);
    const hopCb = buildHopCallback(ctx, undefined, STUB_RUN_OPTIONS);
    await manager.runWithFallback({
      runOptions: STUB_RUN_OPTIONS,
      bundle: STUB_BUNDLE,
      executeHop: hopCb,
    });

    expect(openSession).toHaveBeenCalledTimes(2);
    const openCalls = (openSession as ReturnType<typeof mock>).mock.calls;
    const primaryOpenArgs = openCalls[0]?.[1] as { timeoutSeconds: number };
    const retryOpenArgs = openCalls[1]?.[1] as { timeoutSeconds: number };
    expect(primaryOpenArgs.timeoutSeconds).toBe(60);
    expect(retryOpenArgs.timeoutSeconds).toBe(30);
  });
});
