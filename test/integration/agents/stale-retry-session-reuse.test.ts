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
import { makeContextBundle, makeMockAgentManager, makeNaxConfig, makeSessionManager, makeStory } from "@test/helpers";
import { AgentManager, SessionFailureError } from "@/agents";
import type { AgentRunOptions, SessionHandle, TurnResult } from "@/agents/types";
import type { NaxConfig } from "@/config";
import type { AdapterFailure } from "@/context/engine";
import { _buildHopCallbackDeps, buildHopCallback } from "@/operations";

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

const STUB_BUNDLE = makeContextBundle({
  pullTools: [],
  digest: "",
  chunks: [],
});

/**
 * Fully-typed run options. `config` must be passed by each caller:
 * runWithFallback reads `request.runOptions.config ?? this._config`, so the
 * caller's own AgentManager config is the behavior-preserving choice.
 */
function makeStubRunOptions(config: NaxConfig): AgentRunOptions {
  return {
    prompt: "implement the story",
    workdir: "/tmp",
    storyId: "US-977",
    sessionRole: "implementer",
    timeoutSeconds: 30,
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    config,
  };
}

// ─── Dep injection save/restore ───────────────────────────────────────────────

let origCreateContextToolRuntime: typeof _buildHopCallbackDeps.createContextToolRuntime;
let origRebuildForAgent: typeof _buildHopCallbackDeps.rebuildForAgent;

beforeEach(() => {
  origCreateContextToolRuntime = _buildHopCallbackDeps.createContextToolRuntime;
  origRebuildForAgent = _buildHopCallbackDeps.rebuildForAgent;
  _buildHopCallbackDeps.createContextToolRuntime = () => undefined;
  _buildHopCallbackDeps.rebuildForAgent = (prior) => prior;
});

afterEach(() => {
  _buildHopCallbackDeps.createContextToolRuntime = origCreateContextToolRuntime;
  _buildHopCallbackDeps.rebuildForAgent = origRebuildForAgent;
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function makeHopCtx(
  sessionMgr: ReturnType<typeof makeSessionManager>,
  runAsSessionFn: NonNullable<Parameters<typeof makeMockAgentManager>[0]>["runAsSessionFn"],
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
    const runOptions = makeStubRunOptions(config);

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
    const hopCb = buildHopCallback(ctx, undefined, runOptions);
    const outcome = await manager.runWithFallback({
      runOptions,
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
    const runOptions = makeStubRunOptions(config);

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
    const hopCb = buildHopCallback(ctx, undefined, runOptions);
    await manager.runWithFallback({
      runOptions,
      bundle: STUB_BUNDLE,
      executeHop: hopCb,
    });

    expect(capturedPrompts).toHaveLength(2);
    // Both the primary and stale-retry use the same original prompt
    expect(capturedPrompts[0]).toBe(runOptions.prompt);
    expect(capturedPrompts[1]).toBe(runOptions.prompt);
  });

  test("stale-retry cache miss: falls back to openSession, closeSession still skipped", async () => {
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        idleWatchdog: { enabled: true, maxRetryAttempts: 1 },
      },
    });
    const manager = new AgentManager(config);
    const runOptions = makeStubRunOptions(config);

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
    const hopCb = buildHopCallback(ctx, undefined, runOptions);
    const outcome = await manager.runWithFallback({
      runOptions,
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
