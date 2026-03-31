/**
 * Tests for structured fallback logging in AcpAgentAdapter.
 *
 * Covers US-003-5 acceptance criteria:
 * 1. Each fallback attempt logs at info level with stage 'agent-fallback'
 * 2. Log data contains storyId as first key, then originalAgent, fallbackAgent, errorType, retryCount
 * 3. Wait events log with waitMs field indicating actual sleep duration
 * 4. AllAgentsUnavailableError path logs at error level before throwing, including full list of unavailable agents
 * 5. No console.log or console.error calls introduced
 * 6. Unit tests assert logger.info is called with correct stage and fields on fallback (use a logger mock)
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
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
import * as loggerModule from "../../../../src/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface LogCall {
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

interface MockLogger {
  info: ReturnType<typeof mock>;
  warn: ReturnType<typeof mock>;
  error: ReturnType<typeof mock>;
  debug: ReturnType<typeof mock>;
  infoCalls: LogCall[];
  errorCalls: LogCall[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeLogger(): MockLogger {
  const infoCalls: LogCall[] = [];
  const errorCalls: LogCall[] = [];

  return {
    infoCalls,
    errorCalls,
    info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
      infoCalls.push({ stage, message, data });
    }),
    warn: mock((_stage: string, _message: string, _data?: Record<string, unknown>) => {}),
    error: mock((stage: string, message: string, data?: Record<string, unknown>) => {
      errorCalls.push({ stage, message, data });
    }),
    debug: mock((_stage: string, _message: string, _data?: Record<string, unknown>) => {}),
  };
}

function makeConfig(fallbackOrder: string[]): NaxConfig {
  return {
    autoMode: {
      fallbackOrder,
      defaultAgent: "claude",
    },
    models: {},
  } as unknown as NaxConfig;
}

function makeRunOptions(
  fallbackOrder: string[] = [],
  overrides: Partial<AgentRunOptions> = {},
): AgentRunOptions {
  return {
    prompt: "test prompt",
    workdir: "/tmp/nax-fallback-logging-test",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5-20250514" },
    timeoutSeconds: 30,
    config: makeConfig(fallbackOrder),
    storyId: "US-001-1",
    ...overrides,
  };
}

function makeSuccessResponse(text = "result"): AcpSessionResponse {
  return { messages: [{ role: "assistant", content: text }], stopReason: "end_turn" };
}

function makeSuccessSession(text = "result"): AcpSession {
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

function makeSuccessClient(text = "result"): AcpClient {
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
let loggerSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  origParseAgentError = _fallbackDeps.parseAgentError;
  origFallbackSleep = _fallbackDeps.sleep;
  origCreateClient = _acpAdapterDeps.createClient;
  origAcpSleep = _acpAdapterDeps.sleep;
  origShouldRetrySessionError = _acpAdapterDeps.shouldRetrySessionError;
  _acpAdapterDeps.shouldRetrySessionError = false;
  _acpAdapterDeps.sleep = async (_ms: number) => {};
});

afterEach(() => {
  _fallbackDeps.parseAgentError = origParseAgentError;
  _fallbackDeps.sleep = origFallbackSleep;
  _acpAdapterDeps.createClient = origCreateClient;
  _acpAdapterDeps.sleep = origAcpSleep;
  _acpAdapterDeps.shouldRetrySessionError = origShouldRetrySessionError;
  loggerSpy?.mockRestore();
  loggerSpy = null;
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 1 & 2: complete() logs at info level with stage 'agent-fallback' and correct fields
// ─────────────────────────────────────────────────────────────────────────────

describe("complete() — fallback logging on rate-limit", () => {
  test("logs info with stage 'agent-fallback' when rate-limit fallback occurs", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "rate-limit" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("429 rate limit"),
      makeSuccessClient("fallback result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.complete("prompt", {
        config: makeConfig(["claude", "codex"]),
        storyId: "US-001-1",
      });

      // AC 1: logger.info called with stage 'agent-fallback'
      const fallbackLogs = logger.infoCalls.filter((c) => c.stage === "agent-fallback");
      expect(fallbackLogs.length).toBeGreaterThanOrEqual(1);
    } finally {
      restore();
    }
  });

  test("log data contains storyId as first key on rate-limit fallback in complete()", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "rate-limit" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("429 rate limit"),
      makeSuccessClient("fallback result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.complete("prompt", {
        config: makeConfig(["claude", "codex"]),
        storyId: "US-001-1",
      });

      const fallbackLog = logger.infoCalls.find((c) => c.stage === "agent-fallback");
      expect(fallbackLog).toBeDefined();
      expect(fallbackLog?.data).toBeDefined();

      // AC 2: storyId is first key in data object
      const keys = Object.keys(fallbackLog!.data!);
      expect(keys[0]).toBe("storyId");
      expect(fallbackLog!.data!.storyId).toBe("US-001-1");
    } finally {
      restore();
    }
  });

  test("log data contains originalAgent, fallbackAgent, errorType, retryCount on rate-limit in complete()", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "rate-limit" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("429 rate limit"),
      makeSuccessClient("fallback result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.complete("prompt", {
        config: makeConfig(["claude", "codex"]),
        storyId: "US-001-1",
      });

      const fallbackLog = logger.infoCalls.find((c) => c.stage === "agent-fallback");
      expect(fallbackLog).toBeDefined();
      const data = fallbackLog!.data!;

      expect(data.originalAgent).toBe("claude");
      expect(data.fallbackAgent).toBe("codex");
      expect(data.errorType).toBe("rate-limit");
      expect(typeof data.retryCount).toBe("number");
    } finally {
      restore();
    }
  });
});

describe("complete() — fallback logging on auth error", () => {
  test("logs info with stage 'agent-fallback' when auth fallback occurs", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("401 Unauthorized"),
      makeSuccessClient("auth-fallback result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.complete("prompt", {
        config: makeConfig(["claude", "codex"]),
        storyId: "US-001-2",
      });

      const fallbackLogs = logger.infoCalls.filter((c) => c.stage === "agent-fallback");
      expect(fallbackLogs.length).toBeGreaterThanOrEqual(1);
      const data = fallbackLogs[0]?.data;
      expect(data?.errorType).toBe("auth");
      expect(data?.storyId).toBe("US-001-2");
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 3: complete() wait events log with waitMs field
// ─────────────────────────────────────────────────────────────────────────────

describe("complete() — wait event logging with waitMs", () => {
  test("logs wait event with waitMs when all agents are rate-limited and sleep is called", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({
      type: "rate-limit",
      retryAfterSeconds: 45,
    }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("429"),
      makeErrorClient("429"),
      makeSuccessClient("after-wait result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.complete("prompt", {
        config: makeConfig(["claude", "codex"]),
        storyId: "US-001-3",
      });

      // AC 3: a log entry with waitMs field should exist (logged when sleep is called)
      const waitLogs = logger.infoCalls.filter(
        (c) => c.stage === "agent-fallback" && typeof c.data?.waitMs === "number",
      );
      expect(waitLogs.length).toBeGreaterThanOrEqual(1);
      expect(waitLogs[0].data?.waitMs).toBe(45_000);
    } finally {
      restore();
    }
  });

  test("logs wait event with waitMs=30000 when no retryAfterSeconds is available", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "rate-limit" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("429"),
      makeErrorClient("429"),
      makeSuccessClient("result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.complete("prompt", {
        config: makeConfig(["claude", "codex"]),
        storyId: "US-001-4",
      });

      const waitLogs = logger.infoCalls.filter(
        (c) => c.stage === "agent-fallback" && typeof c.data?.waitMs === "number",
      );
      expect(waitLogs.length).toBeGreaterThanOrEqual(1);
      expect(waitLogs[0].data?.waitMs).toBe(30_000);
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 4: complete() AllAgentsUnavailableError path logs at error level
// ─────────────────────────────────────────────────────────────────────────────

describe("complete() — AllAgentsUnavailableError error logging", () => {
  test("logs at error level before throwing AllAgentsUnavailableError", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

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
          config: makeConfig(["claude", "codex"]),
          storyId: "US-001-5",
        }),
      ).rejects.toBeInstanceOf(AllAgentsUnavailableError);

      // AC 4: logger.error called with stage 'agent-fallback' before throwing
      expect(logger.errorCalls.length).toBeGreaterThanOrEqual(1);
      const errorLog = logger.errorCalls.find((c) => c.stage === "agent-fallback");
      expect(errorLog).toBeDefined();
    } finally {
      restore();
    }
  });

  test("error log includes full list of unavailable agents when all agents fail auth", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

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
          config: makeConfig(["claude", "codex"]),
          storyId: "US-001-6",
        }),
      ).rejects.toBeInstanceOf(AllAgentsUnavailableError);

      const errorLog = logger.errorCalls.find((c) => c.stage === "agent-fallback");
      expect(errorLog).toBeDefined();
      const unavailableAgents = errorLog?.data?.unavailableAgents as string[] | undefined;
      expect(Array.isArray(unavailableAgents)).toBe(true);
      expect(unavailableAgents).toContain("claude");
      expect(unavailableAgents).toContain("codex");
    } finally {
      restore();
    }
  });

  test("error log for AllAgentsUnavailableError includes storyId", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

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
          config: makeConfig(["claude", "codex"]),
          storyId: "US-001-7",
        }),
      ).rejects.toBeInstanceOf(AllAgentsUnavailableError);

      const errorLog = logger.errorCalls.find((c) => c.stage === "agent-fallback");
      expect(errorLog?.data?.storyId).toBe("US-001-7");
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// retryCount tracking: complete()
// ─────────────────────────────────────────────────────────────────────────────

describe("complete() — retryCount increments with each fallback", () => {
  test("retryCount starts at 1 on first fallback attempt", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "rate-limit" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("429"),
      makeSuccessClient("ok"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.complete("prompt", {
        config: makeConfig(["claude", "codex"]),
        storyId: "US-001-8",
      });

      const fallbackLogs = logger.infoCalls.filter((c) => c.stage === "agent-fallback" && !c.data?.waitMs);
      expect(fallbackLogs.length).toBeGreaterThanOrEqual(1);
      expect(fallbackLogs[0].data?.retryCount).toBe(1);
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 1 & 2: run() logs at info level with stage 'agent-fallback' and correct fields
// ─────────────────────────────────────────────────────────────────────────────

describe("run() — fallback logging on rate-limit", () => {
  test("logs info with stage 'agent-fallback' when rate-limit fallback occurs in run()", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "rate-limit" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("429 rate limit"),
      makeSuccessClient("fallback run result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.run(makeRunOptions(["claude", "codex"], { storyId: "US-002-1" }));

      const fallbackLogs = logger.infoCalls.filter((c) => c.stage === "agent-fallback");
      expect(fallbackLogs.length).toBeGreaterThanOrEqual(1);
    } finally {
      restore();
    }
  });

  test("log data contains storyId as first key on rate-limit fallback in run()", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "rate-limit" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("429"),
      makeSuccessClient("result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.run(makeRunOptions(["claude", "codex"], { storyId: "US-002-2" }));

      const fallbackLog = logger.infoCalls.find((c) => c.stage === "agent-fallback");
      expect(fallbackLog).toBeDefined();
      expect(fallbackLog?.data).toBeDefined();

      const keys = Object.keys(fallbackLog!.data!);
      expect(keys[0]).toBe("storyId");
      expect(fallbackLog!.data!.storyId).toBe("US-002-2");
    } finally {
      restore();
    }
  });

  test("log data contains originalAgent, fallbackAgent, errorType, retryCount on rate-limit in run()", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "rate-limit" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("429"),
      makeSuccessClient("result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.run(makeRunOptions(["claude", "codex"], { storyId: "US-002-3" }));

      const fallbackLog = logger.infoCalls.find((c) => c.stage === "agent-fallback");
      expect(fallbackLog).toBeDefined();
      const data = fallbackLog!.data!;

      expect(data.originalAgent).toBe("claude");
      expect(data.fallbackAgent).toBe("codex");
      expect(data.errorType).toBe("rate-limit");
      expect(typeof data.retryCount).toBe("number");
    } finally {
      restore();
    }
  });
});

describe("run() — fallback logging on auth error", () => {
  test("logs info with stage 'agent-fallback' and errorType auth when auth fallback occurs in run()", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("401 Unauthorized"),
      makeSuccessClient("auth-fallback run result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.run(makeRunOptions(["claude", "codex"], { storyId: "US-002-4" }));

      const fallbackLogs = logger.infoCalls.filter((c) => c.stage === "agent-fallback");
      expect(fallbackLogs.length).toBeGreaterThanOrEqual(1);
      expect(fallbackLogs[0].data?.errorType).toBe("auth");
      expect(fallbackLogs[0].data?.storyId).toBe("US-002-4");
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 3: run() wait events log with waitMs field
// ─────────────────────────────────────────────────────────────────────────────

describe("run() — wait event logging with waitMs", () => {
  test("logs wait event with waitMs when all agents are rate-limited in run()", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({
      type: "rate-limit",
      retryAfterSeconds: 60,
    }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("429"),
      makeErrorClient("429"),
      makeSuccessClient("after-wait result"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.run(makeRunOptions(["claude", "codex"], { storyId: "US-002-5" }));

      const waitLogs = logger.infoCalls.filter(
        (c) => c.stage === "agent-fallback" && typeof c.data?.waitMs === "number",
      );
      expect(waitLogs.length).toBeGreaterThanOrEqual(1);
      expect(waitLogs[0].data?.waitMs).toBe(60_000);
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 4: run() AllAgentsUnavailableError path logs at error level
// ─────────────────────────────────────────────────────────────────────────────

describe("run() — AllAgentsUnavailableError error logging", () => {
  test("logs at error level with stage 'agent-fallback' before throwing AllAgentsUnavailableError", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("401"),
      makeErrorClient("401"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await expect(
        adapter.run(makeRunOptions(["claude", "codex"], { storyId: "US-002-6" })),
      ).rejects.toBeInstanceOf(AllAgentsUnavailableError);

      expect(logger.errorCalls.length).toBeGreaterThanOrEqual(1);
      const errorLog = logger.errorCalls.find((c) => c.stage === "agent-fallback");
      expect(errorLog).toBeDefined();
    } finally {
      restore();
    }
  });

  test("error log for AllAgentsUnavailableError in run() includes unavailableAgents list and storyId", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "auth" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("401"),
      makeErrorClient("401"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await expect(
        adapter.run(makeRunOptions(["claude", "codex"], { storyId: "US-002-7" })),
      ).rejects.toBeInstanceOf(AllAgentsUnavailableError);

      const errorLog = logger.errorCalls.find((c) => c.stage === "agent-fallback");
      expect(errorLog).toBeDefined();

      const unavailableAgents = errorLog?.data?.unavailableAgents as string[] | undefined;
      expect(Array.isArray(unavailableAgents)).toBe(true);
      expect(unavailableAgents).toContain("claude");
      expect(unavailableAgents).toContain("codex");

      expect(errorLog?.data?.storyId).toBe("US-002-7");
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// retryCount tracking: run()
// ─────────────────────────────────────────────────────────────────────────────

describe("run() — retryCount increments with each fallback", () => {
  test("retryCount starts at 1 on first fallback in run()", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as any);

    _fallbackDeps.parseAgentError = mock((_s: string): AgentError => ({ type: "rate-limit" }));
    _fallbackDeps.sleep = mock(async (_ms: number) => {});

    const { restore } = mockClientQueue(
      makeErrorClient("429"),
      makeSuccessClient("ok"),
    );

    try {
      const adapter = new AcpAgentAdapter("claude");
      await adapter.run(makeRunOptions(["claude", "codex"], { storyId: "US-002-8" }));

      const fallbackLogs = logger.infoCalls.filter(
        (c) => c.stage === "agent-fallback" && !c.data?.waitMs,
      );
      expect(fallbackLogs.length).toBeGreaterThanOrEqual(1);
      expect(fallbackLogs[0].data?.retryCount).toBe(1);
    } finally {
      restore();
    }
  });
});
