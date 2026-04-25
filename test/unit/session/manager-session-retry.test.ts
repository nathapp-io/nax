/**
 * SessionManager.runInSession — session-transport retry (ADR-013 Phase 2).
 *
 * Phase 2 moves the session-error retry loop from AcpAgentAdapter into
 * SessionManager.runInSession. The adapter now executes once, classifies the
 * result, and returns. SessionManager owns the retry decision.
 *
 * Covered:
 *   - fail-adapter-error retriable: true  → retries up to sessionErrorRetryableMaxRetries
 *   - fail-adapter-error retriable: false → retries up to sessionErrorMaxRetries (non-retriable)
 *   - fail-auth                           → no retry, surfaces immediately
 *   - fail-rate-limit                     → no retry at session level
 *   - abort signal                        → no retry when signal is aborted
 *   - Gap A: handoff() called when agentFallbacks shows agent swap
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentRunRequest } from "../../../src/agents/manager-types";
import type { AgentResult } from "../../../src/agents/types";
import type { AdapterFailure } from "../../../src/context/engine";
import { SessionManager, _sessionManagerDeps } from "../../../src/session/manager";
import { makeMockAgentManager } from "../../../test/helpers";
import { makeNaxConfig } from "../../helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Record<string, unknown> = {}) {
  return makeNaxConfig({
    execution: {
      sessionTimeoutSeconds: 30,
      verificationTimeoutSeconds: 60,
      sessionErrorMaxRetries: 1,
      sessionErrorRetryableMaxRetries: 3,
      ...overrides,
    },
  });
}

function makeRequest(config = makeConfig()): AgentRunRequest {
  return {
    runOptions: {
      prompt: "test",
      workdir: "/tmp/x",
      modelTier: "fast",
      modelDef: { provider: "anthropic", model: "claude-haiku", env: {} },
      timeoutSeconds: 30,
      config,
    },
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

function makeFailure(outcome: AdapterFailure["outcome"], retriable: boolean): AdapterFailure {
  return { category: "availability", outcome, retriable, message: "" };
}

/** Build a mock IAgentManager that returns results in sequence from the queue. */
function makeSequencedManager(queue: AgentResult[]): IAgentManager {
  let callIndex = 0;
  const runMock = mock(async () => {
    const result = queue[callIndex] ?? queue[queue.length - 1];
    callIndex++;
    return result;
  });
  return {
    ...makeMockAgentManager({ getDefaultAgent: "claude" }),
    run: runMock,
  } as IAgentManager;
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved deps for restoration
// ─────────────────────────────────────────────────────────────────────────────

let origNow: typeof _sessionManagerDeps.now;
beforeEach(() => {
  origNow = _sessionManagerDeps.now;
});
afterEach(() => {
  _sessionManagerDeps.now = origNow;
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry on fail-adapter-error retriable: true
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.runInSession — retry on fail-adapter-error", () => {
  test("retries up to sessionErrorRetryableMaxRetries on retriable transport errors", async () => {
    // Default: sessionErrorRetryableMaxRetries = 3 → 3 retries after the first attempt
    const failResult = makeResult({
      success: false,
      exitCode: 1,
      output: "",
      adapterFailure: makeFailure("fail-adapter-error", true),
    });
    const successResult = makeResult({ success: true });

    // Fail 3 times, succeed on 4th attempt (attempt index 3 = 4th call)
    const queue = [failResult, failResult, failResult, successResult];
    const manager = makeSequencedManager(queue);

    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });
    const result = await mgr.runInSession(d.id, manager, makeRequest());

    expect(result.success).toBe(true);
    expect((manager.run as ReturnType<typeof mock>).mock.calls.length).toBe(4);
  });

  test("stops retrying after sessionErrorRetryableMaxRetries exhausted", async () => {
    // sessionErrorRetryableMaxRetries = 3 → max 3 retries → 4 total attempts
    const failResult = makeResult({
      success: false,
      exitCode: 1,
      adapterFailure: makeFailure("fail-adapter-error", true),
    });

    // All attempts fail
    const manager = makeSequencedManager([failResult, failResult, failResult, failResult]);

    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });
    const result = await mgr.runInSession(d.id, manager, makeRequest());

    expect(result.success).toBe(false);
    expect(result.adapterFailure?.outcome).toBe("fail-adapter-error");
    expect((manager.run as ReturnType<typeof mock>).mock.calls.length).toBe(4); // 1 + 3 retries
  });

  test("succeeds immediately if first attempt succeeds (no retries fired)", async () => {
    const manager = makeSequencedManager([makeResult({ success: true })]);

    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });
    await mgr.runInSession(d.id, manager, makeRequest());

    expect((manager.run as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  test("respects custom sessionErrorRetryableMaxRetries from config", async () => {
    // Override to 1 retry only
    const config = makeConfig({ sessionErrorRetryableMaxRetries: 1 });
    const failResult = makeResult({
      success: false,
      exitCode: 1,
      adapterFailure: makeFailure("fail-adapter-error", true),
    });

    const manager = makeSequencedManager([failResult, failResult, failResult]);

    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });
    await mgr.runInSession(d.id, manager, makeRequest(config));

    expect((manager.run as ReturnType<typeof mock>).mock.calls.length).toBe(2); // 1 + 1 retry
  });

  test("session stays RUNNING across all retry attempts (no intermediate FAILED)", async () => {
    const failResult = makeResult({
      success: false,
      exitCode: 1,
      adapterFailure: makeFailure("fail-adapter-error", true),
    });
    const successResult = makeResult({ success: true });

    const states: string[] = [];
    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });

    let callIndex = 0;
    const queue = [failResult, failResult, successResult];
    const runMock = mock(async () => {
      states.push(mgr.get(d.id)?.state ?? "?");
      const result = queue[callIndex] ?? queue[queue.length - 1];
      callIndex++;
      return result;
    });
    const manager: IAgentManager = {
      ...makeMockAgentManager({ getDefaultAgent: "claude" }),
      run: runMock,
    };

    await mgr.runInSession(d.id, manager, makeRequest());

    expect(states.every((s) => s === "RUNNING")).toBe(true);
    expect(mgr.get(d.id)?.state).toBe("COMPLETED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-retriable transport errors
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.runInSession — non-retriable transport errors", () => {
  test("retries once on fail-adapter-error retriable: false (sessionErrorMaxRetries = 1)", async () => {
    const failResult = makeResult({
      success: false,
      exitCode: 1,
      adapterFailure: makeFailure("fail-adapter-error", false),
    });
    const successResult = makeResult({ success: true });

    const manager = makeSequencedManager([failResult, successResult]);

    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });
    const result = await mgr.runInSession(d.id, manager, makeRequest());

    expect(result.success).toBe(true);
    expect((manager.run as ReturnType<typeof mock>).mock.calls.length).toBe(2);
  });

  test("stops after sessionErrorMaxRetries exhausted for non-retriable", async () => {
    // sessionErrorMaxRetries = 1 → 1 retry → 2 total attempts
    const failResult = makeResult({
      success: false,
      exitCode: 1,
      adapterFailure: makeFailure("fail-adapter-error", false),
    });

    const manager = makeSequencedManager([failResult, failResult, failResult]);

    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });
    await mgr.runInSession(d.id, manager, makeRequest());

    expect((manager.run as ReturnType<typeof mock>).mock.calls.length).toBe(2); // 1 + 1 retry
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No retry for auth / rate-limit failures
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.runInSession — no retry for auth/rate-limit", () => {
  test("does not retry on fail-auth — surfaces immediately to AgentManager", async () => {
    const authResult = makeResult({
      success: false,
      exitCode: 1,
      adapterFailure: makeFailure("fail-auth", false),
    });

    const manager = makeSequencedManager([authResult, makeResult({ success: true })]);

    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });
    const result = await mgr.runInSession(d.id, manager, makeRequest());

    expect(result.adapterFailure?.outcome).toBe("fail-auth");
    expect((manager.run as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  test("does not retry on fail-rate-limit — surfaces immediately to AgentManager", async () => {
    const rateLimitResult = makeResult({
      success: false,
      exitCode: 1,
      rateLimited: true,
      adapterFailure: makeFailure("fail-rate-limit", true),
    });

    const manager = makeSequencedManager([rateLimitResult, makeResult({ success: true })]);

    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });
    const result = await mgr.runInSession(d.id, manager, makeRequest());

    expect(result.adapterFailure?.outcome).toBe("fail-rate-limit");
    expect((manager.run as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  test("does not retry on fail-aborted", async () => {
    const abortedResult = makeResult({
      success: false,
      exitCode: 130,
      adapterFailure: makeFailure("fail-aborted", false),
    });

    const manager = makeSequencedManager([abortedResult, makeResult({ success: true })]);

    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });
    const result = await mgr.runInSession(d.id, manager, makeRequest());

    expect(result.adapterFailure?.outcome).toBe("fail-aborted");
    expect((manager.run as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Abort signal cancels retries
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.runInSession — abort signal", () => {
  test("does not retry when abort signal is already aborted", async () => {
    const failResult = makeResult({
      success: false,
      exitCode: 1,
      adapterFailure: makeFailure("fail-adapter-error", true),
    });

    const controller = new AbortController();
    controller.abort();

    const manager = makeSequencedManager([failResult, makeResult({ success: true })]);

    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });
    const request: AgentRunRequest = { ...makeRequest(), signal: controller.signal };
    await mgr.runInSession(d.id, manager, request);

    // Should not retry when signal already aborted
    expect((manager.run as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gap A: descriptor.agent updated after swap (handoff called)
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager.runInSession — Gap A: handoff after agent swap", () => {
  test("calls handoff() when agentFallbacks shows a swap occurred", async () => {
    const result = makeResult({
      agentFallbacks: [
        {
          storyId: "US-001",
          priorAgent: "claude",
          newAgent: "codex",
          outcome: "fail-auth" as const,
          category: "availability" as const,
          hop: 1,
          timestamp: new Date().toISOString(),
          costUsd: 0,
        },
      ],
    });

    const manager = makeSequencedManager([result]);

    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });
    await mgr.runInSession(d.id, manager, makeRequest());

    expect(mgr.get(d.id)?.agent).toBe("codex");
  });

  test("does not call handoff() when no fallbacks occurred", async () => {
    const result = makeResult({ agentFallbacks: [] });

    const manager = makeSequencedManager([result]);

    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });
    await mgr.runInSession(d.id, manager, makeRequest());

    expect(mgr.get(d.id)?.agent).toBe("claude");
  });

  test("uses the LAST hop's newAgent when multiple swaps occurred", async () => {
    const result = makeResult({
      agentFallbacks: [
        {
          storyId: "US-001",
          priorAgent: "claude",
          newAgent: "codex",
          outcome: "fail-auth" as const,
          category: "availability" as const,
          hop: 1,
          timestamp: new Date().toISOString(),
          costUsd: 0,
        },
        {
          storyId: "US-001",
          priorAgent: "codex",
          newAgent: "gemini",
          outcome: "fail-rate-limit" as const,
          category: "availability" as const,
          hop: 2,
          timestamp: new Date().toISOString(),
          costUsd: 0,
        },
      ],
    });

    const manager = makeSequencedManager([result]);

    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });
    await mgr.runInSession(d.id, manager, makeRequest());

    expect(mgr.get(d.id)?.agent).toBe("gemini");
  });

  test("does not call handoff() when agentFallbacks is undefined", async () => {
    const result = makeResult(); // agentFallbacks not set

    const manager = makeSequencedManager([result]);

    const mgr = new SessionManager();
    const d = mgr.create({ role: "main", agent: "claude", workdir: "/tmp/x" });
    await mgr.runInSession(d.id, manager, makeRequest());

    expect(mgr.get(d.id)?.agent).toBe("claude");
  });
});
