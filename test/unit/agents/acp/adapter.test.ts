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
  exactCostUsd?: number;
  retryable?: boolean;
  error?: string;
  cancelled?: boolean;
}

export interface MockAcpSession {
  prompt(text: string): Promise<AcpSessionResponse>;
  close(opts?: { forceTerminate?: boolean }): Promise<void>;
  cancelActivePrompt(): Promise<void>;
}

export interface MockAcpClient {
  start(): Promise<void>;
  createSession(opts: { agentName: string; permissionMode: string }): Promise<MockAcpSession>;
  loadSession?: (name: string, agentName: string, permissionMode: string) => Promise<MockAcpSession | null>;
  close(): Promise<void>;
  cancelActivePrompt(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers — also used by adapter-run.test.ts
// ─────────────────────────────────────────────────────────────────────────────

export function makeSession(overrides: {
  promptFn?: (text: string) => Promise<AcpSessionResponse>;
  closeFn?: (opts?: { forceTerminate?: boolean }) => Promise<void>;
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
    createSessionFn?: (opts: { agentName: string; permissionMode: string; sessionName?: string }) => Promise<MockAcpSession>;
    loadSessionFn?: (name: string, agentName: string, permissionMode: string) => Promise<MockAcpSession | null>;
  } = {},
): MockAcpClient {
  return {
    start: overrides.startFn ?? (async () => {}),
    createSession: overrides.createSessionFn ?? (async (_opts) => session),
    loadSession: overrides.loadSessionFn,
    close: async () => {},
    cancelActivePrompt: async () => {},
  };
}

const ACP_WORKDIR = `/tmp/nax-acp-test-${randomUUID()}`;

/** Default CompleteOptions with required primitives for unit tests. */
function makeCompleteOptions(overrides: Record<string, unknown> = {}): import("../../../../src/agents/types").ResolvedCompleteOptions {
  return {
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    workdir: ACP_WORKDIR,
    resolvedPermissions: { skipPermissions: false, mode: "approve-reads" as const },
    ...overrides,
  } as import("../../../../src/agents/types").ResolvedCompleteOptions;
}

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

    const result = await new AcpAgentAdapter("claude").complete("What is the answer?", makeCompleteOptions());
    expect(result.output).toBe("The answer is 42.");
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

    await new AcpAgentAdapter("claude").complete("Explain recursion", makeCompleteOptions());
    expect(received).toBe("Explain recursion");
  });

  test("throws CompleteError when stopReason is error", async () => {
    const session = makeSession({
      promptFn: async (_: string) => ({ messages: [], stopReason: "error" }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await expect(new AcpAgentAdapter("claude").complete("Hello", makeCompleteOptions())).rejects.toBeInstanceOf(CompleteError);
  });

  // BUG-1: the CompleteError built for a stop-reason-error response must carry the
  // parsed error text (surfaced via response.error) instead of a generic message,
  // and preserve the real retryable flag acpx reported.
  test("CompleteError built from a stop-reason-error response carries the parsed error text (BUG-1)", async () => {
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [],
        stopReason: "error",
        error: "QUEUE_DISCONNECTED_BEFORE_COMPLETION: queue disconnected",
        retryable: true,
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    // retryable:true is classifiable, so complete() returns a degraded result
    // instead of throwing — assert the message text made it into the output/adapterFailure.
    const result = await new AcpAgentAdapter("claude").complete("Hello", makeCompleteOptions());
    expect(result.adapterFailure?.retriable).toBe(true);
    expect(result.output).toContain("QUEUE_DISCONNECTED_BEFORE_COMPLETION: queue disconnected");
  });

  test("CompleteError message includes the parsed error text when retryable is unknown (BUG-1)", async () => {
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [],
        stopReason: "error",
        error: "acpx internal fault: session lost",
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await expect(new AcpAgentAdapter("claude").complete("Hello", makeCompleteOptions())).rejects.toThrow(
      /acpx internal fault: session lost/,
    );
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

    await expect(new AcpAgentAdapter("claude").complete("Hello", makeCompleteOptions())).rejects.toBeInstanceOf(CompleteError);
  });

  test("closes the session after one-shot completion", async () => {
    let closeCalled = false;
    const session = makeSession({ closeFn: async () => { closeCalled = true; } });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await new AcpAgentAdapter("claude").complete("Quick question", makeCompleteOptions());
    expect(closeCalled).toBe(true);
  });

  test("times out and throws if session.prompt() hangs beyond timeoutMs", async () => {
    const session = makeSession({
      promptFn: () => new Promise<never>(() => {}), // hangs forever
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await expect(
      new AcpAgentAdapter("claude").complete("Hang?", makeCompleteOptions({ timeoutMs: 50 })),
    ).rejects.toThrow(/timed out/i);
  });

  test("returns adapterFailure for rate-limit error instead of throwing", async () => {
    const session = makeSession({
      promptFn: async (_: string) => { throw new Error('{"statusCode":429}'); },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").complete("Rate limited", makeCompleteOptions());
    expect(result.adapterFailure).toBeDefined();
    expect(result.adapterFailure?.outcome).toBe("fail-rate-limit");
    expect(result.adapterFailure?.category).toBe("availability");
    expect(result.adapterFailure?.retriable).toBe(true);
  });

  test("still throws for unknown (non-classifiable) errors", async () => {
    const session = makeSession({
      promptFn: async (_: string) => { throw new Error("unexpected internal error"); },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await expect(
      new AcpAgentAdapter("claude").complete("Unknown fail", makeCompleteOptions()),
    ).rejects.toThrow(/unexpected internal error/);
  });

  // SIGINT-orphan fix — see docs/findings/2026-04-29-sigint-cleanup-rectification-and-adversarial-loops.md
  test("forwards onPidSpawned from CompleteOptions to createClient", async () => {
    let capturedOnPidSpawned: ((pid: number) => void) | undefined;
    const session = makeSession();
    _acpAdapterDeps.createClient = mock(
      (_cmd: string, _cwd: string, _timeout?: number, onPidSpawned?: (pid: number) => void) => {
        capturedOnPidSpawned = onPidSpawned;
        return makeClient(session) as unknown as ReturnType<typeof _acpAdapterDeps.createClient>;
      },
    );

    const tracker = mock((_pid: number) => {});
    await new AcpAgentAdapter("claude").complete("track-me", makeCompleteOptions({ onPidSpawned: tracker }));
    expect(capturedOnPidSpawned).toBe(tracker);
  });

  // BUG-15: modelDef.env (config.models.<agent>.<tier>.env) was accepted by
  // the schema but never forwarded to createClient — a per-model API
  // key/base URL override was silently dropped.
  test("forwards modelDef.env to createClient's AcpClientOptions", async () => {
    let capturedEnv: Record<string, string> | undefined;
    const session = makeSession();
    _acpAdapterDeps.createClient = mock(
      (
        _cmd: string,
        _cwd: string,
        _timeout?: number,
        _onPidSpawned?: (pid: number) => void,
        _promptRetries?: number,
        _onPidExited?: (pid: number) => void,
        opts?: { env?: Record<string, string> },
      ) => {
        capturedEnv = opts?.env;
        return makeClient(session) as unknown as ReturnType<typeof _acpAdapterDeps.createClient>; // test-ratchet-allow: as-unknown-as
      },
    );

    await new AcpAgentAdapter("claude").complete(
      "model-env-test",
      makeCompleteOptions({
        modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: { ANTHROPIC_BASE_URL: "https://custom" } },
      }),
    );
    expect(capturedEnv).toEqual({ ANTHROPIC_BASE_URL: "https://custom" });
  });

  test("force-terminates the session on successful completion (kills queue-owner)", async () => {
    let capturedCloseOpts: { forceTerminate?: boolean } | undefined;
    const session = makeSession({
      closeFn: async (opts) => { capturedCloseOpts = opts; },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await new AcpAgentAdapter("claude").complete("hello", makeCompleteOptions());
    expect(capturedCloseOpts?.forceTerminate).toBe(true);
  });

  test("force-terminates the session on error path as well", async () => {
    let capturedCloseOpts: { forceTerminate?: boolean } | undefined;
    const session = makeSession({
      promptFn: async (_: string) => ({ messages: [], stopReason: "error" }),
      closeFn: async (opts) => { capturedCloseOpts = opts; },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await expect(
      new AcpAgentAdapter("claude").complete("fail", makeCompleteOptions()),
    ).rejects.toBeInstanceOf(CompleteError);
    expect(capturedCloseOpts?.forceTerminate).toBe(true);
  });

  // BUG-57: a mid-flight cancel (cancelActivePrompt()) must not drop tokens
  // already burned before the cancel — the cancelled-path return previously
  // hardcoded { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0
  // unconditionally, discarding response.cumulative_token_usage entirely.
  test("cancelled path carries through tokens already burned before the cancel (BUG-57)", async () => {
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [],
        stopReason: "error",
        cancelled: true,
        cumulative_token_usage: { input_tokens: 500, output_tokens: 200 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").complete("Hello", makeCompleteOptions());
    expect(result.cancelled).toBe(true);
    expect(result.tokenUsage.inputTokens).toBe(500);
    expect(result.tokenUsage.outputTokens).toBe(200);
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
  });

  test("cancelled path with no usage reported still returns zero (not a regression)", async () => {
    const session = makeSession({
      promptFn: async (_: string) => ({ messages: [], stopReason: "error", cancelled: true }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").complete("Hello", makeCompleteOptions());
    expect(result.cancelled).toBe(true);
    expect(result.tokenUsage.inputTokens).toBe(0);
    expect(result.tokenUsage.outputTokens).toBe(0);
    expect(result.estimatedCostUsd).toBe(0);
  });

  // LOW: parity with spawn-client.ts, which truncates parsed error text with
  // .slice(0, 500) at every sibling site — the CompleteError message built
  // here was previously unbounded.
  test("CompleteError message truncates an oversized parsed error text to 500 chars", async () => {
    const hugeError = "x".repeat(2000);
    const session = makeSession({
      promptFn: async (_: string) => ({ messages: [], stopReason: "error", error: hugeError, retryable: undefined }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    try {
      await new AcpAgentAdapter("claude").complete("Hello", makeCompleteOptions());
      throw new Error("expected complete() to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CompleteError);
      const message = (err as Error).message;
      // Message = "complete() failed: stop reason is error: " + truncated(500) text
      expect(message.length).toBeLessThan(560);
    }
  });
});

// complete() — primitive model resolution (modelDef)
// ─────────────────────────────────────────────────────────────────────────────

describe("complete() — modelDef primitive consumption", () => {
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

  function makePassClient() {
    return makeClient(makeSession());
  }

  test("uses modelDef.model from options for the acpx command", async () => {
    let capturedCmd = "";
    _acpAdapterDeps.createClient = mock((cmd: string) => {
      capturedCmd = cmd;
      return makePassClient() as unknown as ReturnType<typeof _acpAdapterDeps.createClient>;
    });

    await new AcpAgentAdapter("claude").complete("test", makeCompleteOptions({
      modelDef: { provider: "anthropic", model: "claude-haiku-4-5-20250514", env: {} },
    }));
    expect(capturedCmd).toContain("--model claude-haiku-4-5-20250514");
  });

  test("uses resolvedPermissions.mode for the session permissionMode", async () => {
    let capturedPermissionMode = "";
    const session = makeSession();
    const client = makePassClient();
    _acpAdapterDeps.createClient = mock((_cmd: string) => {
      const origCreate = client.createSession.bind(client);
      (client as Record<string, unknown>).createSession = mock(async (opts: { agentName: string; permissionMode: string }) => {
        capturedPermissionMode = opts.permissionMode;
        return origCreate(opts);
      });
      return client as unknown as ReturnType<typeof _acpAdapterDeps.createClient>;
    });

    await new AcpAgentAdapter("claude").complete("test", makeCompleteOptions({
      resolvedPermissions: { skipPermissions: true, mode: "approve-all" as const },
    }));
    expect(capturedPermissionMode).toBe("approve-all");
  });

  test("uses promptRetries from options for createClient", async () => {
    let capturedRetries: number | undefined;
    _acpAdapterDeps.createClient = mock(
      (_cmd: string, _cwd: string, _timeout?: number, _onPid?: unknown, promptRetries?: number) => {
        capturedRetries = promptRetries;
        return makePassClient() as unknown as ReturnType<typeof _acpAdapterDeps.createClient>;
      },
    );

    await new AcpAgentAdapter("claude").complete("test", makeCompleteOptions({ promptRetries: 5 }));
    expect(capturedRetries).toBe(5);
  });

  test("model string from modelDef flows into the acpx command string", async () => {
    let capturedCmd = "";
    _acpAdapterDeps.createClient = mock((cmd: string) => {
      capturedCmd = cmd;
      return makePassClient() as unknown as ReturnType<typeof _acpAdapterDeps.createClient>;
    });

    await new AcpAgentAdapter("claude").complete("test", makeCompleteOptions({
      modelDef: { provider: "anthropic", model: "claude-default", env: {} },
    }));
    expect(capturedCmd).toContain("--model claude-default");
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
