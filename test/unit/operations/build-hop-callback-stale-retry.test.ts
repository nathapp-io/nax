/**
 * Unit tests — buildHopCallback stale-retry session reuse (#977).
 *
 * Verifies that on { kind: "stale-retry" }:
 * - getLiveHandle is called to find the cached handle
 * - openSession is NOT called when the handle is found
 * - closeSession is NOT called (handle stays open for the next attempt)
 *
 * And that on { kind: "primary" } and { kind: "swap" }:
 * - openSession IS called
 * - closeSession IS called in the finally block
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SessionHandle, TurnResult } from "@/agents/types";
import type { AdapterFailure } from "@/context/engine";
import { _buildHopCallbackDeps, buildHopCallback } from "@/operations";
import { makeMockAgentManager, makeNaxConfig, makeSessionManager, makeStory } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Shared stubs
// ─────────────────────────────────────────────────────────────────────────────

const STUB_HANDLE: SessionHandle = { id: "nax-abc123", agentName: "claude" };

const STUB_TURN: TurnResult = {
  output: "done",
  tokenUsage: { inputTokens: 10, outputTokens: 5 },
  estimatedCostUsd: 0.001,
  internalRoundTrips: 1,
};

const SWAP_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-auth",
  retriable: false,
  message: "401",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STUB_RUN_OPTIONS = {
  prompt: "do the thing",
  workdir: "/tmp",
  storyId: "US-001",
  sessionRole: "implementer" as const,
  timeoutSeconds: 30,
} as any;

// ─────────────────────────────────────────────────────────────────────────────
// Dep injection save/restore
// ─────────────────────────────────────────────────────────────────────────────

let origCreateContextToolRuntime: typeof _buildHopCallbackDeps.createContextToolRuntime;
let origRebuildForAgent: typeof _buildHopCallbackDeps.rebuildForAgent;

beforeEach(() => {
  origCreateContextToolRuntime = _buildHopCallbackDeps.createContextToolRuntime;
  origRebuildForAgent = _buildHopCallbackDeps.rebuildForAgent;
  // Suppress context tool runtime creation — not relevant to session reuse tests.
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  _buildHopCallbackDeps.createContextToolRuntime = () => undefined as any;
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  _buildHopCallbackDeps.rebuildForAgent = (prior) => prior as any;
});

afterEach(() => {
  _buildHopCallbackDeps.createContextToolRuntime = origCreateContextToolRuntime;
  _buildHopCallbackDeps.rebuildForAgent = origRebuildForAgent;
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeCtx(sessionMgr: ReturnType<typeof makeSessionManager>) {
  const story = makeStory({ id: "US-001" });
  const config = makeNaxConfig();
  const agentManager = makeMockAgentManager({
    runAsSessionFn: mock(async () => STUB_TURN),
  });
  return {
    sessionManager: sessionMgr,
    agentManager,
    story,
    config,
    projectDir: undefined,
    featureName: "test-feature",
    workdir: "/tmp",
    effectiveTier: "balanced" as const,
    defaultAgent: "claude",
    pipelineStage: "run" as const,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

// Gap finding 7 — the pull budget registry must be created ONCE per callback,
// outside the returned closure. Created inside, every retry / fallback /
// escalation hop got a fresh registry and maxCallsPerSession reset to zero.
// Nothing else in the suite pins this placement.
describe("buildHopCallback — session-scoped pull budget registry", () => {
  test("every hop receives the same sessionBudgets instance", async () => {
    const seen: unknown[] = [];
    _buildHopCallbackDeps.createContextToolRuntime = (opts: { sessionBudgets?: unknown }) => {
      seen.push(opts.sessionBudgets);
      return undefined as any;
    };
    const sessionMgr = makeSessionManager({});
    const cb = buildHopCallback(makeCtx(sessionMgr), undefined, STUB_RUN_OPTIONS);

    const bundle = { pushMarkdown: "", pullTools: [], digest: "", manifest: {} } as any;
    await cb("claude", bundle, { kind: "primary", attempt: 1 }, STUB_RUN_OPTIONS);
    await cb("claude", bundle, { kind: "stale-retry", attempt: 2 }, STUB_RUN_OPTIONS);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeDefined();
    expect(seen[0]).toBe(seen[1]);
  });
});

describe("buildHopCallback — stale-retry session reuse", () => {
  test("stale-retry: getLiveHandle called; openSession and closeSession skipped", async () => {
    const getLiveHandle = mock((_name: string) => STUB_HANDLE);
    const openSession = mock(async () => STUB_HANDLE);
    const closeSession = mock(async () => {});
    const sessionMgr = makeSessionManager({ getLiveHandle, openSession, closeSession });

    const cb = buildHopCallback(makeCtx(sessionMgr), undefined, STUB_RUN_OPTIONS);
    const result = await cb("claude", undefined, { kind: "stale-retry", attempt: 1 }, STUB_RUN_OPTIONS);

    expect(result.result.success).toBe(true);
    expect(getLiveHandle).toHaveBeenCalledTimes(1);
    expect(openSession).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
  });

  test("stale-retry cache miss: falls back to openSession, closeSession still skipped", async () => {
    const getLiveHandle = mock((_name: string) => undefined as SessionHandle | undefined);
    const openSession = mock(async () => STUB_HANDLE);
    const closeSession = mock(async () => {});
    const sessionMgr = makeSessionManager({ getLiveHandle, openSession, closeSession });

    const cb = buildHopCallback(makeCtx(sessionMgr), undefined, STUB_RUN_OPTIONS);
    const result = await cb("claude", undefined, { kind: "stale-retry", attempt: 1 }, STUB_RUN_OPTIONS);

    expect(result.result.success).toBe(true);
    expect(getLiveHandle).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledTimes(1);
    // Even on cache-miss fallback, the handle stays open for the next attempt
    expect(closeSession).not.toHaveBeenCalled();
  });

  test("primary: openSession called, closeSession called, getLiveHandle not called", async () => {
    const getLiveHandle = mock((_name: string) => undefined as SessionHandle | undefined);
    const openSession = mock(async () => STUB_HANDLE);
    const closeSession = mock(async () => {});
    const sessionMgr = makeSessionManager({ getLiveHandle, openSession, closeSession });

    const cb = buildHopCallback(makeCtx(sessionMgr), undefined, STUB_RUN_OPTIONS);
    const result = await cb("claude", undefined, { kind: "primary" }, STUB_RUN_OPTIONS);

    expect(result.result.success).toBe(true);
    expect(getLiveHandle).not.toHaveBeenCalled();
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
  });

  test("swap: openSession called, closeSession called, getLiveHandle not called", async () => {
    const getLiveHandle = mock((_name: string) => undefined as SessionHandle | undefined);
    const openSession = mock(async () => STUB_HANDLE);
    const closeSession = mock(async () => {});
    const sessionMgr = makeSessionManager({ getLiveHandle, openSession, closeSession });

    const cb = buildHopCallback(makeCtx(sessionMgr), undefined, STUB_RUN_OPTIONS);
    const result = await cb("codex", undefined, { kind: "swap", failure: SWAP_FAILURE }, STUB_RUN_OPTIONS);

    expect(result.result.success).toBe(true);
    expect(getLiveHandle).not.toHaveBeenCalled();
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
  });

  test("swap: handoff fires with failure outcome; stale-retry does not trigger handoff", async () => {
    const handoff = mock(() => ({ id: "session-1", state: "RUNNING" }) as any);
    const openSession = mock(async () => STUB_HANDLE);
    const closeSession = mock(async () => {});
    const getLiveHandle = mock((_name: string) => STUB_HANDLE);
    const sessionMgr = makeSessionManager({ handoff, openSession, closeSession, getLiveHandle });

    const cb = buildHopCallback(makeCtx(sessionMgr), "session-1", STUB_RUN_OPTIONS);

    // Stale-retry must NOT fire handoff
    await cb("claude", undefined, { kind: "stale-retry", attempt: 1 }, STUB_RUN_OPTIONS);
    expect(handoff).not.toHaveBeenCalled();

    // Swap MUST fire handoff
    await cb("codex", undefined, { kind: "swap", failure: SWAP_FAILURE }, STUB_RUN_OPTIONS);
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(handoff).toHaveBeenCalledWith("session-1", "codex", SWAP_FAILURE.outcome);
  });

  test("closeSession NOT called on stale-retry when send throws (handle stays open for watchdog to cancel)", async () => {
    const getLiveHandle = mock((_name: string) => STUB_HANDLE);
    const openSession = mock(async () => STUB_HANDLE);
    const closeSession = mock(async () => {});
    const sessionMgr = makeSessionManager({ getLiveHandle, openSession, closeSession });

    const agentManager = makeMockAgentManager({
      runAsSessionFn: mock(async () => {
        throw new Error("send failed");
      }),
    });
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig();
    const ctx = {
      sessionManager: sessionMgr,
      agentManager,
      story,
      config,
      projectDir: undefined,
      featureName: "f",
      workdir: "/tmp",
      effectiveTier: "balanced" as const,
      defaultAgent: "claude",
      pipelineStage: "run" as const,
    };

    const cb = buildHopCallback(ctx, undefined, STUB_RUN_OPTIONS);
    const result = await cb("claude", undefined, { kind: "stale-retry", attempt: 1 }, STUB_RUN_OPTIONS);

    // Error is caught and returned as failed AgentResult
    expect(result.result.success).toBe(false);
    // Handle must NOT be closed — it stays open for the next hop
    expect(closeSession).not.toHaveBeenCalled();
  });
});
