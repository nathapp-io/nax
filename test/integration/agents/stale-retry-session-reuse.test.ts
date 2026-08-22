/**
 * Integration test — stale-retry reuses the live acpx session (#977).
 *
 * Drives the full AgentManager.runWithFallback → buildHopCallback chain
 * without spawning real processes. Asserts session open/close/getLiveHandle
 * call counts across a single fail-stale + retry cycle.
 *
 * AC from fix plan §177 (refcast to mock-session level):
 * - openSession fires ONCE (primary only) across a fail-stale + retry cycle.
 * - closeSession fires ONCE (primary only); skipped on stale-retry.
 * - getLiveHandle fires once on the stale-retry hop.
 * - Stale-retry uses the original prompt (no swapHandoff rewrite).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AgentManager, SessionFailureError } from "@/agents";
import type { SessionHandle, TurnResult } from "@/agents/types";
import type { AdapterFailure, ContextBundle } from "@/context/engine";
import { _buildHopCallbackDeps, buildHopCallback } from "@/operations";
import { makeMockAgentManager, makeNaxConfig, makeSessionManager, makeStory } from "@test/helpers";

// ─── Stubs ───────────────────────────────────────────────────────────────────

const CLAUDE_HANDLE: SessionHandle = { id: "ses_abc123", agentName: "claude" };

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
    featureName: "stale-retry-test",
    workdir: "/tmp",
    effectiveTier: "balanced" as const,
    defaultAgent: "claude",
    pipelineStage: "run" as const,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("stale-retry session reuse — full runWithFallback loop", () => {
  test("openSession fires once (primary only), closeSession fires once (primary only), getLiveHandle fires once (stale-retry)", async () => {
    // Config: allow one stale retry, no fallback
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        idleWatchdog: { enabled: true, maxRetryAttempts: 1 },
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
        // Primary hop: fail-stale → triggers stale-retry
        throw new SessionFailureError("idle timeout", STALE_FAILURE);
      }
      // Stale-retry hop: succeed
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

    // openSession called once (primary only — stale-retry reuses handle)
    expect(openSession).toHaveBeenCalledTimes(1);
    // closeSession called once (primary only — stale-retry skips finally)
    expect(closeSession).toHaveBeenCalledTimes(1);
    // getLiveHandle called once (on the stale-retry hop)
    expect(getLiveHandle).toHaveBeenCalledTimes(1);
  });

  test("stale-retry preserves original prompt (no swapHandoff rewrite)", async () => {
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        idleWatchdog: { enabled: true, maxRetryAttempts: 1 },
      },
    });
    const manager = new AgentManager(config);

    const getLiveHandle = mock((_name: string) => CLAUDE_HANDLE);
    const sessionMgr = makeSessionManager({ getLiveHandle });

    const capturedPrompts: string[] = [];
    let sendCallCount = 0;
    const runAsSessionFn = mock(async (_agentName: string, _handle: SessionHandle, prompt: string) => {
      capturedPrompts.push(prompt);
      sendCallCount++;
      if (sendCallCount === 1) throw new SessionFailureError("idle timeout", STALE_FAILURE);
      return STUB_TURN;
    });

    const ctx = makeHopCtx(sessionMgr, runAsSessionFn);
    const hopCb = buildHopCallback(ctx, undefined, STUB_RUN_OPTIONS);
    await manager.runWithFallback({
      runOptions: STUB_RUN_OPTIONS,
      bundle: STUB_BUNDLE,
      executeHop: hopCb,
    });

    expect(capturedPrompts).toHaveLength(2);
    // Both the primary and stale-retry use the same original prompt
    expect(capturedPrompts[0]).toBe(STUB_RUN_OPTIONS.prompt);
    expect(capturedPrompts[1]).toBe(STUB_RUN_OPTIONS.prompt);
  });

  test("stale-retry cache miss: falls back to openSession, closeSession still skipped", async () => {
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        idleWatchdog: { enabled: true, maxRetryAttempts: 1 },
      },
    });
    const manager = new AgentManager(config);

    const openSession = mock(async () => CLAUDE_HANDLE);
    const closeSession = mock(async () => {});
    // Simulate cache miss: getLiveHandle returns undefined
    const getLiveHandle = mock((_name: string) => undefined as SessionHandle | undefined);
    const sessionMgr = makeSessionManager({ openSession, closeSession, getLiveHandle });

    let sendCallCount = 0;
    const runAsSessionFn = mock(async () => {
      sendCallCount++;
      if (sendCallCount === 1) throw new SessionFailureError("idle timeout", STALE_FAILURE);
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

    // On cache miss, stale-retry falls back to openSession (total: 2)
    expect(openSession).toHaveBeenCalledTimes(2);
    // Even on cache miss, closeSession is still skipped on the stale-retry hop
    // (primary: 1 close; stale-retry: 0 close)
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(getLiveHandle).toHaveBeenCalledTimes(1);
  });
});
