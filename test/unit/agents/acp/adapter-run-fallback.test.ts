/**
 * Tests for the fallback retry loop in AcpAgentAdapter.run().
 *
 * Covers US-003-4 acceptance criteria:
 * 1. run() retries with next fallbackOrder agent when stderr contains 'rate limit'
 * 2. run() retries with next fallbackOrder agent when stderr contains '429'
 * 3. run() marks agent unavailable and retries next when stderr contains auth error
 * 4. run() throws AllAgentsUnavailableError when all fallbackOrder agents are unavailable
 * 5. run() shares the same _unavailableAgents set as complete() — agents marked unavailable
 *    by a prior complete() call remain unavailable for run()
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  AcpAgentAdapter,
  type AcpClient,
  type AcpSession,
  type AcpSessionResponse,
  _acpAdapterDeps,
  _fallbackDeps,
} from "../../../../src/agents/acp/adapter";
import { AllAgentsUnavailableError } from "../../../../src/agents/index";
import type { AgentError } from "../../../../src/agents/types";
import type { AgentRunOptions } from "../../../../src/agents/types";
import type { NaxConfig } from "../../../../src/config";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig(fallbackOrder: string[]): NaxConfig {
  return {
    autoMode: {
      fallbackOrder,
      defaultAgent: "claude",
    },
    models: {},
  } as unknown as NaxConfig;
}

function makeRunOptions(fallbackOrder: string[] = [], overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    prompt: "test prompt",
    workdir: "/tmp/nax-run-fallback-test",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5-20250514" },
    timeoutSeconds: 30,
    config: makeConfig(fallbackOrder),
    ...overrides,
  };
}

function makeSuccessResponse(text = "run result"): AcpSessionResponse {
  return {
    messages: [{ role: "assistant", content: text }],
    stopReason: "end_turn",
  };
}

function makeSuccessSession(text = "run result"): AcpSession {
  return {
    prompt: async (_p: string) => makeSuccessResponse(text),
    close: async () => {},
    cancelActivePrompt: async () => {},
  };
}

function makeErrorSession(errorMsg: string): AcpSession {
  return {
    prompt: async (_p: string) => {
      throw new Error(errorMsg);
    },
    close: async () => {},
    cancelActivePrompt: async () => {},
  };
}

function makeSuccessClient(text = "run result"): AcpClient {
  return {
    start: async () => {},
    createSession: async () => makeSuccessSession(text),
    close: async () => {},
  };
}

function makeErrorClient(errorMsg: string): AcpClient {
  return {
    start: async () => {},
    createSession: async () => makeErrorSession(errorMsg),
    close: async () => {},
  };
}

/**
 * Install a createClient mock that returns clients from the queue in order.
 * After the queue is exhausted, returns the last client repeatedly.
 * Returns capturedCmdStrs (for agent name verification) and a restore function.
 */
function mockClientQueue(...clients: AcpClient[]): { capturedCmdStrs: string[]; restore: () => void } {
  const orig = _acpAdapterDeps.createClient;
  let callIdx = 0;
  const capturedCmdStrs: string[] = [];

  _acpAdapterDeps.createClient = (cmdStr: string) => {
    capturedCmdStrs.push(cmdStr);
    const client = clients[callIdx] ?? clients[clients.length - 1];
    callIdx++;
    return client;
  };

  return {
    capturedCmdStrs,
    restore: () => {
      _acpAdapterDeps.createClient = orig;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals for teardown
// ─────────────────────────────────────────────────────────────────────────────

let origParseAgentError: typeof _fallbackDeps.parseAgentError;
let origFallbackSleep: typeof _fallbackDeps.sleep;
let origCreateClient: typeof _acpAdapterDeps.createClient;
let origAcpSleep: typeof _acpAdapterDeps.sleep;
let origShouldRetrySessionError: boolean;

beforeEach(() => {
  origParseAgentError = _fallbackDeps.parseAgentError;
  origFallbackSleep = _fallbackDeps.sleep;
  origCreateClient = _acpAdapterDeps.createClient;
  origAcpSleep = _acpAdapterDeps.sleep;
  origShouldRetrySessionError = _acpAdapterDeps.shouldRetrySessionError;
  // Disable session error retry to prevent mock callIndex drift
  _acpAdapterDeps.shouldRetrySessionError = false;
  // Prevent real sleep in legacy exponential-backoff path
  _acpAdapterDeps.sleep = async (_ms: number) => {};
});

afterEach(() => {
  _fallbackDeps.parseAgentError = origParseAgentError;
  _fallbackDeps.sleep = origFallbackSleep;
  _acpAdapterDeps.createClient = origCreateClient;
  _acpAdapterDeps.sleep = origAcpSleep;
  _acpAdapterDeps.shouldRetrySessionError = origShouldRetrySessionError;
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path: sleep and parseAgentError never called on success
// ─────────────────────────────────────────────────────────────────────────────

describe("run() — happy path", () => {
  test("returns successful AgentResult when session succeeds on first attempt", async () => {
    const sleepMock = mock(async (_ms: number) => {});
    _fallbackDeps.sleep = sleepMock;

    const { restore } = mockClientQueue(makeSuccessClient("agent output"));
    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.run(makeRunOptions([]));
      expect(result.success).toBe(true);
      expect(result.output).toContain("agent output");
      expect(sleepMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test("parseAgentError is not invoked when session succeeds", async () => {
    const parseMock = mock((_stderr: string): AgentError => ({ type: "unknown" }));
    _fallbackDeps.parseAgentError = parseMock;

    const { restore } = mockClientQueue(makeSuccessClient("ok"));
    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.run(makeRunOptions([]));
      expect(parseMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 1: run() retries with next fallbackOrder agent when stderr contains 'rate limit'
// ─────────────────────────────────────────────────────────────────────────────

describe("run() — rate-limit 'rate limit' fallback", () => {
  test("retries with next fallbackOrder agent when session throws 'rate limit' error", async () => {
    const sleepMock = mock(async (_ms: number) => {});
    _fallbackDeps.sleep = sleepMock;

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "rate-limit" }));

    const { restore, capturedCmdStrs } = mockClientQueue(
      makeErrorClient("HTTP 429 rate limit exceeded"),
      makeSuccessClient("fallback run output"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.run(makeRunOptions(["claude", "codex"]));

      // Caller sees success — fallback retries are transparent
      expect(result.success).toBe(true);
      expect(result.output).toContain("fallback run output");

      // A second agent was attempted (cmdStr contains fallback agent name)
      expect(capturedCmdStrs.length).toBeGreaterThanOrEqual(2);
      expect(capturedCmdStrs[1]).toContain("codex");

      // No sleep for single rate-limit retry
      expect(sleepMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test("attempt count is transparent — caller receives success without seeing retry count", async () => {
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "rate-limit" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("rate limit"),
      makeSuccessClient("transparent result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.run(makeRunOptions(["claude", "codex"]));
      expect(result.success).toBe(true);
      expect(result.output).toContain("transparent result");
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 2: run() retries with next fallbackOrder agent when stderr contains '429'
// ─────────────────────────────────────────────────────────────────────────────

describe("run() — rate-limit '429' fallback", () => {
  test("retries with next fallbackOrder agent when session throws '429' error", async () => {
    const sleepMock = mock(async (_ms: number) => {});
    _fallbackDeps.sleep = sleepMock;

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "rate-limit" }));

    const { restore, capturedCmdStrs } = mockClientQueue(
      makeErrorClient("429 Too Many Requests"),
      makeSuccessClient("after 429 result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.run(makeRunOptions(["claude", "gemini"]));

      expect(result.success).toBe(true);
      expect(capturedCmdStrs.length).toBeGreaterThanOrEqual(2);
      expect(capturedCmdStrs[1]).toContain("gemini");
      expect(sleepMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 3: run() marks agent unavailable and retries next when auth error
// ─────────────────────────────────────────────────────────────────────────────

describe("run() — auth error fallback", () => {
  test("marks failing agent unavailable and retries with next fallbackOrder agent on auth error", async () => {
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore, capturedCmdStrs } = mockClientQueue(
      makeErrorClient("HTTP 401 Unauthorized"),
      makeSuccessClient("auth-fallback result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.run(makeRunOptions(["claude", "codex"]));

      expect(result.success).toBe(true);
      expect(result.output).toContain("auth-fallback result");

      // Primary "claude" was tried first, then fallback "codex"
      expect(capturedCmdStrs.length).toBeGreaterThanOrEqual(2);
      expect(capturedCmdStrs[1]).toContain("codex");

      // Primary agent "claude" should be in _unavailableAgents
      const unavailable = (adapter as unknown as { _unavailableAgents: Set<string> })._unavailableAgents;
      expect(unavailable.has("claude")).toBe(true);
    } finally {
      restore();
    }
  });

  test("returns successfully when fallback succeeds after primary auth error", async () => {
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("403 Forbidden"),
      makeSuccessClient("from-gemini"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.run(makeRunOptions(["claude", "gemini"]));
      expect(result.success).toBe(true);
      expect(result.output).toContain("from-gemini");
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 4: run() throws AllAgentsUnavailableError when all fallbackOrder agents are unavailable
// ─────────────────────────────────────────────────────────────────────────────

describe("run() — all agents unavailable", () => {
  test("throws AllAgentsUnavailableError when all fallbackOrder agents are auth-failed", async () => {
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("401 Unauthorized"),
      makeErrorClient("401 Unauthorized"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await expect(adapter.run(makeRunOptions(["claude", "codex"]))).rejects.toBeInstanceOf(
        AllAgentsUnavailableError,
      );
    } finally {
      restore();
    }
  });

  test("throws AllAgentsUnavailableError when single fallback agent is auth-failed", async () => {
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("401"),
      makeErrorClient("401"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await expect(adapter.run(makeRunOptions(["claude", "gemini"]))).rejects.toBeInstanceOf(
        AllAgentsUnavailableError,
      );
    } finally {
      restore();
    }
  });

  test("AllAgentsUnavailableError contains the tried agent names", async () => {
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(makeErrorClient("401"), makeErrorClient("401"));

    try {
      const adapter = new AcpAgentAdapter("claude");
      let thrown: unknown;
      try {
        await adapter.run(makeRunOptions(["claude", "codex"]));
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(AllAgentsUnavailableError);
      const err = thrown as AllAgentsUnavailableError;
      expect(err.message).toMatch(/claude|codex/);
    } finally {
      restore();
    }
  });

  test("does not call _fallbackDeps.sleep when all agents auth-fail", async () => {
    const sleepMock = mock(async (_ms: number) => {});
    _fallbackDeps.sleep = sleepMock;
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));

    const { restore } = mockClientQueue(makeErrorClient("401"), makeErrorClient("401"));

    try {
      const adapter = new AcpAgentAdapter("claude");
      await expect(adapter.run(makeRunOptions(["claude", "codex"]))).rejects.toBeInstanceOf(
        AllAgentsUnavailableError,
      );
      expect(sleepMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test("sleeps min(retryAfterSeconds)*1000 when all fallbackOrder agents are rate-limited", async () => {
    const sleepMock = mock(async (_ms: number) => {});
    _fallbackDeps.sleep = sleepMock;

    let errorCallIdx = 0;
    const rateLimitErrors: AgentError[] = [
      { type: "rate-limit", retryAfterSeconds: 60 },
      { type: "rate-limit", retryAfterSeconds: 45 },
    ];
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => {
      const err = rateLimitErrors[errorCallIdx] ?? { type: "rate-limit", retryAfterSeconds: 45 };
      errorCallIdx++;
      return err;
    });

    const { restore } = mockClientQueue(
      makeErrorClient("429 rate limit"),
      makeErrorClient("429 rate limit"),
      makeSuccessClient("after-sleep result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.run(makeRunOptions(["claude", "codex"]));

      expect(result.success).toBe(true);
      // sleep called once with min(60, 45)*1000 = 45_000
      expect(sleepMock).toHaveBeenCalledTimes(1);
      expect(sleepMock).toHaveBeenCalledWith(45_000);
    } finally {
      restore();
    }
  });

  test("sleeps 30_000ms when no retryAfterSeconds is available from any rate-limited agent", async () => {
    const sleepMock = mock(async (_ms: number) => {});
    _fallbackDeps.sleep = sleepMock;

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "rate-limit" }));

    const { restore } = mockClientQueue(
      makeErrorClient("429"),
      makeErrorClient("429"),
      makeSuccessClient("result after 30s"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.run(makeRunOptions(["claude", "codex"]));

      expect(result.success).toBe(true);
      expect(sleepMock).toHaveBeenCalledTimes(1);
      expect(sleepMock).toHaveBeenCalledWith(30_000);
    } finally {
      restore();
    }
  });

  test("retries from fallbackOrder[0] after sleeping when all rate-limited", async () => {
    const sleepMock = mock(async (_ms: number) => {});
    _fallbackDeps.sleep = sleepMock;

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({
      type: "rate-limit",
      retryAfterSeconds: 10,
    }));

    const { restore, capturedCmdStrs } = mockClientQueue(
      makeErrorClient("429"),
      makeErrorClient("429"),
      makeSuccessClient("retry result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.run(makeRunOptions(["claude", "codex"]));

      // Third call (after sleep) should target fallbackOrder[0] = "codex"
      expect(capturedCmdStrs.length).toBe(3);
      expect(capturedCmdStrs[2]).toContain("codex");
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 5: run() shares the same _unavailableAgents set as complete()
// ─────────────────────────────────────────────────────────────────────────────

describe("run() — shared _unavailableAgents with complete()", () => {
  test("agent marked unavailable by complete() is also unavailable for run()", async () => {
    // Step 1: complete() fails with auth error for "claude" — marks it unavailable
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const adapter = new AcpAgentAdapter("claude");

    // Make complete() fail for claude but succeed for codex
    const completeClients = mockClientQueue(
      makeErrorClient("401 Unauthorized"),
      makeSuccessClient("complete fallback ok"),
    );
    try {
      await adapter.complete("prompt", { config: makeConfig(["claude", "codex"]) });
    } finally {
      completeClients.restore();
    }

    // Verify claude is now in _unavailableAgents
    const unavailable = (adapter as unknown as { _unavailableAgents: Set<string> })._unavailableAgents;
    expect(unavailable.has("claude")).toBe(true);

    // Step 2: run() with same adapter — "claude" should be skipped, "codex" used directly
    const runClients = mockClientQueue(makeSuccessClient("run from codex"));
    try {
      const result = await adapter.run(makeRunOptions(["claude", "codex"]));
      expect(result.success).toBe(true);

      // Since claude is unavailable, run() should use codex directly (not try claude first)
      const firstCmd = runClients.capturedCmdStrs[0];
      expect(firstCmd).toContain("codex");
    } finally {
      runClients.restore();
    }
  });

  test("agent marked unavailable by run() is also unavailable for subsequent complete()", async () => {
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const adapter = new AcpAgentAdapter("claude");

    // Step 1: run() fails with auth error — marks claude unavailable
    const runClients = mockClientQueue(
      makeErrorClient("401 Unauthorized"),
      makeSuccessClient("run fallback ok"),
    );
    try {
      await adapter.run(makeRunOptions(["claude", "codex"]));
    } finally {
      runClients.restore();
    }

    // Verify claude is now unavailable
    const unavailable = (adapter as unknown as { _unavailableAgents: Set<string> })._unavailableAgents;
    expect(unavailable.has("claude")).toBe(true);

    // Step 2: complete() with same adapter — claude is still unavailable
    const completeClients = mockClientQueue(makeSuccessClient("complete from codex"));
    try {
      const result = await adapter.complete("prompt", { config: makeConfig(["claude", "codex"]) });
      expect(result).toContain("complete from codex");

      // claude is unavailable, so codex should be used first
      const firstCmd = completeClients.capturedCmdStrs[0];
      expect(firstCmd).toContain("codex");
    } finally {
      completeClients.restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge case: empty fallbackOrder → AllAgentsUnavailableError immediately
// ─────────────────────────────────────────────────────────────────────────────

describe("run() — empty fallbackOrder", () => {
  test("throws AllAgentsUnavailableError when resolveFallbackOrder returns [] and primary auth-fails", async () => {
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(makeErrorClient("401"));

    try {
      const adapter = new AcpAgentAdapter("claude");
      await expect(adapter.run(makeRunOptions([]))).rejects.toBeInstanceOf(AllAgentsUnavailableError);
    } finally {
      restore();
    }
  });
});
