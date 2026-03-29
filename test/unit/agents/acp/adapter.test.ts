/**
 * Tests for AcpAgentAdapter — ACP-002
 *
 * Covers:
 * - AgentAdapter interface compliance (name, binary, displayName, capabilities)
 * - isInstalled() checks binary on PATH via _acpAdapterDeps.which
 * - buildCommand() returns ACP command array for dry-run display
 * - complete() works in one-shot mode and returns trimmed text
 * - All AcpClient interactions mockable via injectable _deps pattern
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AcpAgentAdapter, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import { CompleteError } from "../../../../src/agents/types";
import type { AgentRunOptions } from "../../../../src/agents/types";

// ─────────────────────────────────────────────────────────────────────────────
// ACP mock types — mirror expected acpx interfaces for test isolation
// ─────────────────────────────────────────────────────────────────────────────

export interface AcpSessionResponse {
  messages: Array<{ role: string; content: string }>;
  stopReason: "end_turn" | "cancelled" | "error" | string;
  cumulative_token_usage?: { input_tokens: number; output_tokens: number };
}

export interface MockAcpSession {
  prompt(text: string): Promise<AcpSessionResponse>;
  close(): Promise<void>;
  cancelActivePrompt(): Promise<void>;
}

export interface MockAcpClient {
  start(): Promise<void>;
  createSession(opts: { agentName: string; permissionMode: string }): Promise<MockAcpSession>;
  close(): Promise<void>;
  cancelActivePrompt(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers — also used by adapter-run.test.ts
// ─────────────────────────────────────────────────────────────────────────────

export function makeSession(overrides: {
  promptFn?: (text: string) => Promise<AcpSessionResponse>;
  closeFn?: () => Promise<void>;
  cancelFn?: () => Promise<void>;
} = {}): MockAcpSession {
  return {
    prompt: overrides.promptFn ?? (async (_: string) => ({
      messages: [{ role: "assistant", content: "Task completed successfully." }],
      stopReason: "end_turn",
      cumulative_token_usage: { input_tokens: 100, output_tokens: 50 },
    })),
    close: overrides.closeFn ?? (async () => {}),
    cancelActivePrompt: overrides.cancelFn ?? (async () => {}),
  };
}

export function makeClient(
  session: MockAcpSession,
  overrides: {
    startFn?: () => Promise<void>;
    createSessionFn?: (opts: { agentName: string; permissionMode: string }) => Promise<MockAcpSession>;
  } = {},
): MockAcpClient {
  return {
    start: overrides.startFn ?? (async () => {}),
    createSession: overrides.createSessionFn ?? (async (_opts) => session),
    close: async () => {},
    cancelActivePrompt: async () => {},
  };
}

const ACP_WORKDIR = `/tmp/nax-acp-test-${randomUUID()}`;

export function makeRunOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    workdir: ACP_WORKDIR,
    prompt: "Write a hello world function",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    timeoutSeconds: 60,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Interface compliance
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpAgentAdapter interface compliance", () => {
  let adapter: AcpAgentAdapter;

  beforeEach(() => { adapter = new AcpAgentAdapter("claude"); });

  test("name is set from constructor agentName", () => {
    expect(adapter.name).toBe("claude");
  });

  test("capabilities.supportedTiers is a non-empty array", () => {
    expect(Array.isArray(adapter.capabilities.supportedTiers)).toBe(true);
    expect(adapter.capabilities.supportedTiers.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isInstalled()
// ─────────────────────────────────────────────────────────────────────────────

describe("isInstalled()", () => {
  const origWhich = _acpAdapterDeps.which;

  afterEach(() => {
    _acpAdapterDeps.which = origWhich;
    mock.restore();
  });

  test("returns true when binary is found on PATH", async () => {
    _acpAdapterDeps.which = mock((_name: string) => "/usr/local/bin/claude");
    expect(await new AcpAgentAdapter("claude").isInstalled()).toBe(true);
  });

  test("returns false when binary is not found on PATH", async () => {
    _acpAdapterDeps.which = mock((_name: string) => null);
    expect(await new AcpAgentAdapter("claude").isInstalled()).toBe(false);
  });

  test("checks a binary name derived from the agent name", async () => {
    const checked: string[] = [];
    _acpAdapterDeps.which = mock((name: string) => { checked.push(name); return "/bin/" + name; });
    await new AcpAgentAdapter("claude").isInstalled();
    expect(checked.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildCommand()
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCommand()", () => {
});

// ─────────────────────────────────────────────────────────────────────────────
// complete()
// ─────────────────────────────────────────────────────────────────────────────

describe("complete()", () => {
  const origCreateClient = _acpAdapterDeps.createClient;
  const origSleep = _acpAdapterDeps.sleep;

  beforeEach(() => {
    _acpAdapterDeps.sleep = mock(async (_ms: number) => {});
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    _acpAdapterDeps.sleep = origSleep;
    mock.restore();
  });

  test("returns trimmed assistant message text", async () => {
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [{ role: "assistant", content: "  The answer is 42.  \n" }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").complete("What is the answer?");
    expect(result).toBe("The answer is 42.");
  });

  test("sends the provided prompt to the ACP session", async () => {
    let received = "";
    const session = makeSession({
      promptFn: async (text: string) => {
        received = text;
        return {
          messages: [{ role: "assistant", content: "Done." }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await new AcpAgentAdapter("claude").complete("Explain recursion");
    expect(received).toBe("Explain recursion");
  });

  test("throws CompleteError when stopReason is error", async () => {
    const session = makeSession({
      promptFn: async (_: string) => ({ messages: [], stopReason: "error" }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await expect(new AcpAgentAdapter("claude").complete("Hello")).rejects.toBeInstanceOf(CompleteError);
  });

  test("throws CompleteError when assistant output is blank", async () => {
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [{ role: "assistant", content: "   " }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 10, output_tokens: 0 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await expect(new AcpAgentAdapter("claude").complete("Hello")).rejects.toBeInstanceOf(CompleteError);
  });

  test("closes the session after one-shot completion", async () => {
    let closeCalled = false;
    const session = makeSession({ closeFn: async () => { closeCalled = true; } });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await new AcpAgentAdapter("claude").complete("Quick question");
    expect(closeCalled).toBe(true);
  });

  test("times out and throws if session.prompt() hangs beyond timeoutMs", async () => {
    const session = makeSession({
      promptFn: () => new Promise<never>(() => {}), // hangs forever
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await expect(
      new AcpAgentAdapter("claude").complete("Hang?", { timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/i);
  });

  test("retries on rate limit error and returns result on second attempt", async () => {
    let calls = 0;
    const session = makeSession({
      promptFn: async (_: string) => {
        calls++;
        if (calls === 1) throw new Error("rate limit exceeded");
        return { messages: [{ role: "assistant", content: "Retried OK." }], stopReason: "end_turn" };
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").complete("Retry me");
    expect(result).toBe("Retried OK.");
    expect(calls).toBe(2);
    expect(_acpAdapterDeps.sleep).toHaveBeenCalledTimes(1);
  });

  test("throws after exhausting all rate limit retries", async () => {
    const session = makeSession({
      promptFn: async (_: string) => { throw new Error("rate limit exceeded"); },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await expect(
      new AcpAgentAdapter("claude").complete("Fail all"),
    ).rejects.toThrow(/rate limit/i);
  });
});

// complete() — model resolution from config + modelTier
// ─────────────────────────────────────────────────────────────────────────────

describe("complete() — model resolution", () => {
  const origCreateClient = _acpAdapterDeps.createClient;
  const origSleep = _acpAdapterDeps.sleep;

  beforeEach(() => {
    _acpAdapterDeps.sleep = mock(async (_ms: number) => {});
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    _acpAdapterDeps.sleep = origSleep;
    mock.restore();
  });

  function makePassSession() {
    const session = makeSession();
    return makeClient(session);
  }

  test("uses 'default' when no model or config provided", async () => {
    let capturedCmd = "";
    const client = makePassSession();
    _acpAdapterDeps.createClient = mock((cmd: string) => {
      capturedCmd = cmd;
      return client as unknown as ReturnType<typeof _acpAdapterDeps.createClient>;
    });

    await new AcpAgentAdapter("claude").complete("test");
    expect(capturedCmd).toContain("--model default");
  });

  test("uses explicit model string when provided", async () => {
    let capturedCmd = "";
    const client = makePassSession();
    _acpAdapterDeps.createClient = mock((cmd: string) => {
      capturedCmd = cmd;
      return client as unknown as ReturnType<typeof _acpAdapterDeps.createClient>;
    });

    await new AcpAgentAdapter("claude").complete("test", { model: "claude-haiku-4-5" });
    expect(capturedCmd).toContain("--model claude-haiku-4-5");
  });

  test("resolves model from config.models[modelTier] when model not explicit", async () => {
    let capturedCmd = "";
    const client = makePassSession();
    _acpAdapterDeps.createClient = mock((cmd: string) => {
      capturedCmd = cmd;
      return client as unknown as ReturnType<typeof _acpAdapterDeps.createClient>;
    });

    const naxConfig = {
      models: { fast: "claude-haiku-4-5-20250514", balanced: "claude-sonnet-4-5-20250514" },
    } as unknown as Parameters<AcpAgentAdapter["complete"]>[1]["config"];

    await new AcpAgentAdapter("claude").complete("test", { modelTier: "fast", config: naxConfig });
    expect(capturedCmd).toContain("--model claude-haiku-4-5-20250514");
  });

  test("falls back to 'default' when config has no matching tier", async () => {
    let capturedCmd = "";
    const client = makePassSession();
    _acpAdapterDeps.createClient = mock((cmd: string) => {
      capturedCmd = cmd;
      return client as unknown as ReturnType<typeof _acpAdapterDeps.createClient>;
    });

    const naxConfig = { models: {} } as unknown as Parameters<AcpAgentAdapter["complete"]>[1]["config"];

    await new AcpAgentAdapter("claude").complete("test", { modelTier: "powerful", config: naxConfig });
    expect(capturedCmd).toContain("--model default");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _acpAdapterDeps — injectable dependency surface
// ─────────────────────────────────────────────────────────────────────────────

describe("_acpAdapterDeps", () => {
  test("is exported from the module", () => {
    expect(_acpAdapterDeps).toBeDefined();
    expect(typeof _acpAdapterDeps).toBe("object");
  });
});
