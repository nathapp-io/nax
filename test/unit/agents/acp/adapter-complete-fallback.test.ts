/**
 * Tests for the fallback retry loop in AcpAgentAdapter.complete().
 *
 * Covers US-003-3 acceptance criteria:
 * 1. 429 → retry with next fallbackOrder agent → returns transparently to caller
 * 2. 401 → markUnavailable(failing agent) → retry with next fallbackOrder agent
 * 3. Fallback does NOT decrement story attempt count (caller sees transparent success)
 * 4. All fallbackOrder agents rate-limited → sleep min(retryAfterSeconds)*1000 || 30_000 → retry [0]
 * 5. Single fallbackOrder agent rate-limited → sleep retryAfterSeconds*1000 || 30_000 → retry same
 * 6. All agents auth-failed → throws AllAgentsUnavailableError
 * 7. sleep is NEVER called in the happy path
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  AcpAgentAdapter,
  _acpAdapterDeps,
  _fallbackDeps,
  type AcpClient,
  type AcpSession,
  type AcpSessionResponse,
} from "../../../../src/agents/acp/adapter";
import { AllAgentsUnavailableError } from "../../../../src/agents/index";
import type { NaxConfig } from "../../../../src/config";
import type { AgentError } from "../../../../src/agents/types";

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

function makeSuccessResponse(text = "result text"): AcpSessionResponse {
  return {
    messages: [{ role: "assistant", content: text }],
    stopReason: "end_turn",
  };
}

function makeSuccessSession(text = "result text"): AcpSession {
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

function makeSuccessClient(text = "result text"): AcpClient {
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
 * Returns a restore function.
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
let origSleep: typeof _fallbackDeps.sleep;
let origCreateClient: typeof _acpAdapterDeps.createClient;
let origAcpSleep: typeof _acpAdapterDeps.sleep;
let origShouldRetrySessionError: boolean;

beforeEach(() => {
  origParseAgentError = _fallbackDeps.parseAgentError;
  origSleep = _fallbackDeps.sleep;
  origCreateClient = _acpAdapterDeps.createClient;
  origAcpSleep = _acpAdapterDeps.sleep;
  origShouldRetrySessionError = _acpAdapterDeps.shouldRetrySessionError;
  _acpAdapterDeps.shouldRetrySessionError = false;
  // Prevent real sleep during the old exponential-backoff retry loop
  _acpAdapterDeps.sleep = async (_ms: number) => {};
});

afterEach(() => {
  _fallbackDeps.parseAgentError = origParseAgentError;
  _fallbackDeps.sleep = origSleep;
  _acpAdapterDeps.createClient = origCreateClient;
  _acpAdapterDeps.sleep = origAcpSleep;
  _acpAdapterDeps.shouldRetrySessionError = origShouldRetrySessionError;
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 7: sleep is NEVER called in the happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("complete() — happy path", () => {
  test("sleep is never called when acpx succeeds on first attempt", async () => {
    const sleepMock = mock(async (_ms: number) => {});
    _fallbackDeps.sleep = sleepMock;

    const { restore } = mockClientQueue(makeSuccessClient("hello world"));
    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.complete("prompt", { config: makeConfig([]) });
      expect(result).toBe("hello world");
      expect(sleepMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test("parseAgentError is not invoked when prompt succeeds", async () => {
    const parseMock = mock((_stderr: string): AgentError => ({ type: "unknown" }));
    _fallbackDeps.parseAgentError = parseMock;

    const { restore } = mockClientQueue(makeSuccessClient("ok"));
    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.complete("prompt", { config: makeConfig([]) });
      expect(parseMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 1 & 3: 429 → retry with next fallbackOrder agent → transparent success
// ─────────────────────────────────────────────────────────────────────────────

describe("complete() — 429 rate-limit fallback", () => {
  test("retries with next fallbackOrder agent after 429 and returns result transparently", async () => {
    const sleepMock = mock(async (_ms: number) => {});
    _fallbackDeps.sleep = sleepMock;

    // parseAgentError returns rate-limit for the first error call, then no more errors
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "rate-limit" }));

    // Client 1 (primary agent "claude"): rate-limit error
    // Client 2 (fallback "codex"): success
    const { restore, capturedCmdStrs } = mockClientQueue(
      makeErrorClient("HTTP 429 rate limit exceeded"),
      makeSuccessClient("fallback answer"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.complete("the prompt", {
        config: makeConfig(["claude", "codex"]),
      });

      // Caller sees the successful result — retries are transparent
      expect(result).toBe("fallback answer");

      // Verify a second agent was attempted (cmdStr should reference fallback agent)
      expect(capturedCmdStrs.length).toBeGreaterThanOrEqual(2);
      const secondCmd = capturedCmdStrs[1];
      expect(secondCmd).toContain("codex");

      // Sleep should NOT have been called (rate-limit retry without waiting)
      expect(sleepMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test("attempt count is transparent — caller receives success without seeing retry count", async () => {
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "rate-limit" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("429"),
      makeSuccessClient("transparent result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      // Single call to complete() — caller sees success, no retry count exposed
      const result = await adapter.complete("prompt", { config: makeConfig(["claude", "codex"]) });
      expect(result).toBe("transparent result");
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 2: 401 → markUnavailable → retry with next fallbackOrder agent
// ─────────────────────────────────────────────────────────────────────────────

describe("complete() — 401 auth fallback", () => {
  test("marks failing agent unavailable and retries with next fallbackOrder agent on 401", async () => {
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore, capturedCmdStrs } = mockClientQueue(
      makeErrorClient("HTTP 401 Unauthorized"),
      makeSuccessClient("auth-fallback result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.complete("prompt", {
        config: makeConfig(["claude", "codex"]),
      });

      expect(result).toBe("auth-fallback result");

      // Primary agent "claude" was tried first, then fallback
      expect(capturedCmdStrs.length).toBeGreaterThanOrEqual(2);
      expect(capturedCmdStrs[1]).toContain("codex");

      // After marking claude unavailable, it should not appear in future fallback calls
      const unavailable = (adapter as unknown as { _unavailableAgents: Set<string> })._unavailableAgents;
      expect(unavailable.has("claude")).toBe(true);
    } finally {
      restore();
    }
  });

  test("returns successfully even when primary agent is 401 but fallback succeeds", async () => {
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("401"),
      makeSuccessClient("from-gemini"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.complete("prompt", {
        config: makeConfig(["claude", "gemini"]),
      });
      expect(result).toBe("from-gemini");
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 4: All fallbackOrder agents rate-limited → sleep min(retryAfterSeconds) || 30s
// ─────────────────────────────────────────────────────────────────────────────

describe("complete() — all fallbackOrder agents rate-limited", () => {
  test("sleeps min(retryAfterSeconds)*1000 when all fallback agents are rate-limited", async () => {
    const sleepMock = mock(async (_ms: number) => {});
    _fallbackDeps.sleep = sleepMock;

    // All errors are rate-limit; first pass has retryAfterSeconds, second succeeds
    let parseCallCount = 0;
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => {
      parseCallCount++;
      // Return rate-limit for initial attempts, then stop (success follows)
      return { type: "rate-limit", retryAfterSeconds: 60 };
    });

    // Call sequence:
    // 1. primary "claude" → rate-limit (retryAfterSeconds: 60)
    // 2. fallback "codex" → rate-limit (retryAfterSeconds: 45)
    // [sleep with min(60, 45)*1000 = 45_000]
    // 3. retry fallbackOrder[0] "codex" → success
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
      const result = await adapter.complete("prompt", {
        config: makeConfig(["claude", "codex"]),
      });

      expect(result).toBe("after-sleep result");
      // sleep called once with min(60, 45)*1000 = 45_000
      expect(sleepMock).toHaveBeenCalledTimes(1);
      expect(sleepMock).toHaveBeenCalledWith(45_000);
    } finally {
      restore();
    }
  });

  test("sleeps 30_000ms when no retryAfterSeconds is available from any agent", async () => {
    const sleepMock = mock(async (_ms: number) => {});
    _fallbackDeps.sleep = sleepMock;

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "rate-limit" }));

    const { restore } = mockClientQueue(
      makeErrorClient("429"),
      makeSuccessClient("result after 30s"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.complete("prompt", {
        config: makeConfig(["claude", "codex"]),
      });

      expect(result).toBe("result after 30s");
      expect(sleepMock).toHaveBeenCalledTimes(1);
      expect(sleepMock).toHaveBeenCalledWith(30_000);
    } finally {
      restore();
    }
  });

  test("retries from fallbackOrder[0] after sleeping when all rate-limited", async () => {
    const sleepMock = mock(async (_ms: number) => {});
    _fallbackDeps.sleep = sleepMock;

    let errorCallIdx = 0;
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => {
      errorCallIdx++;
      return { type: "rate-limit", retryAfterSeconds: 10 };
    });

    const { restore, capturedCmdStrs } = mockClientQueue(
      makeErrorClient("429"),
      makeErrorClient("429"),
      makeSuccessClient("retry result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.complete("prompt", { config: makeConfig(["claude", "codex"]) });

      // Third call should be to fallbackOrder[0] (codex), not the primary
      expect(capturedCmdStrs.length).toBe(3);
      expect(capturedCmdStrs[2]).toContain("codex");
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 5: Single fallbackOrder agent rate-limited → sleep retryAfterSeconds || 30s → retry same
// ─────────────────────────────────────────────────────────────────────────────

describe("complete() — single fallbackOrder agent rate-limited", () => {
  test("waits retryAfterSeconds then retries the same single fallback agent", async () => {
    const sleepMock = mock(async (_ms: number) => {});
    _fallbackDeps.sleep = sleepMock;

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({
      type: "rate-limit",
      retryAfterSeconds: 90,
    }));

    // Primary "claude" fails (rate-limit), fallback "codex" also fails (rate-limit),
    // then after sleep, codex succeeds
    const { restore, capturedCmdStrs } = mockClientQueue(
      makeErrorClient("429"),
      makeErrorClient("429"),
      makeSuccessClient("single-fallback-retry"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.complete("prompt", {
        config: makeConfig(["claude", "codex"]),
      });

      expect(result).toBe("single-fallback-retry");
      expect(sleepMock).toHaveBeenCalledTimes(1);
      expect(sleepMock).toHaveBeenCalledWith(90_000);

      // After sleep, the same fallback agent "codex" is retried
      expect(capturedCmdStrs[2]).toContain("codex");
    } finally {
      restore();
    }
  });

  test("waits 30_000ms when single rate-limited agent has no retryAfterSeconds", async () => {
    const sleepMock = mock(async (_ms: number) => {});
    _fallbackDeps.sleep = sleepMock;

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "rate-limit" }));

    const { restore } = mockClientQueue(
      makeErrorClient("429"),
      makeErrorClient("429"),
      makeSuccessClient("ok"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.complete("prompt", { config: makeConfig(["claude", "codex"]) });

      expect(sleepMock).toHaveBeenCalledWith(30_000);
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 6: All agents auth-failed → throws AllAgentsUnavailableError
// ─────────────────────────────────────────────────────────────────────────────

describe("complete() — all agents auth-failed", () => {
  test("throws AllAgentsUnavailableError when all fallbackOrder agents return 401", async () => {
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    // All clients throw auth errors
    const { restore } = mockClientQueue(
      makeErrorClient("401 Unauthorized"),
      makeErrorClient("401 Unauthorized"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await expect(
        adapter.complete("prompt", {
          config: makeConfig(["claude", "codex"]),
        }),
      ).rejects.toBeInstanceOf(AllAgentsUnavailableError);
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
      await expect(
        adapter.complete("prompt", {
          config: makeConfig(["claude", "gemini"]),
        }),
      ).rejects.toBeInstanceOf(AllAgentsUnavailableError);
    } finally {
      restore();
    }
  });

  test("AllAgentsUnavailableError contains the tried agent names", async () => {
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("401"),
      makeErrorClient("401"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      let thrown: unknown;
      try {
        await adapter.complete("prompt", {
          config: makeConfig(["claude", "codex"]),
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(AllAgentsUnavailableError);
      const err = thrown as AllAgentsUnavailableError;
      // Error message should mention the agents that were tried
      expect(err.message).toMatch(/claude|codex/);
    } finally {
      restore();
    }
  });

  test("does not call sleep when all agents auth-fail", async () => {
    const sleepMock = mock(async (_ms: number) => {});
    _fallbackDeps.sleep = sleepMock;
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));

    const { restore } = mockClientQueue(
      makeErrorClient("401"),
      makeErrorClient("401"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await expect(
        adapter.complete("prompt", { config: makeConfig(["claude", "codex"]) }),
      ).rejects.toBeInstanceOf(AllAgentsUnavailableError);

      expect(sleepMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge case: empty fallbackOrder → AllAgentsUnavailableError immediately
// ─────────────────────────────────────────────────────────────────────────────

describe("complete() — empty fallbackOrder", () => {
  test("throws AllAgentsUnavailableError when resolveFallbackOrder returns [] and primary fails", async () => {
    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(makeErrorClient("401"));

    try {
      const adapter = new AcpAgentAdapter("claude");
      await expect(
        adapter.complete("prompt", {
          config: makeConfig([]), // no fallback agents
        }),
      ).rejects.toBeInstanceOf(AllAgentsUnavailableError);
    } finally {
      restore();
    }
  });
});
