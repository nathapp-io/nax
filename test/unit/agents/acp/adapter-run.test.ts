/**
 * Tests for AcpAgentAdapter.run() — ACP-002
 *
 * Covers:
 * - run() creates AcpClient, starts session, sends prompt, returns AgentResult
 * - AgentResult.success maps from stopReason (end_turn=true, cancelled/error=false)
 * - AgentResult.estimatedCost uses cumulative_token_usage from ACP session
 * - AgentResult.output contains text extracted from session messages
 * - Rate limit retry with exponential backoff (3 attempts max)
 * - Timeout triggers cooperative cancel via cancelActivePrompt(), fallback to close()
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AcpAgentAdapter, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import { makeClient, makeRunOptions, makeSession } from "./adapter.test";

// ─────────────────────────────────────────────────────────────────────────────
// run() — core session flow
// ─────────────────────────────────────────────────────────────────────────────

describe("run() — session flow", () => {
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

  test("calls client.start() before createSession()", async () => {
    const order: string[] = [];
    const session = makeSession();
    const client = makeClient(session, {
      startFn: async () => {
        order.push("start");
      },
      createSessionFn: async (_opts) => {
        order.push("createSession");
        return session;
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => client);

    await new AcpAgentAdapter("claude").run(makeRunOptions());

    expect(order[0]).toBe("start");
    expect(order[1]).toBe("createSession");
  });

  test("sends prompt from run options to the session", async () => {
    let receivedPrompt = "";
    const session = makeSession({
      promptFn: async (text: string) => {
        receivedPrompt = text;
        return {
          messages: [{ role: "assistant", content: "Done." }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await new AcpAgentAdapter("claude").run(makeRunOptions({ prompt: "Implement fibonacci" }));
    expect(receivedPrompt).toBe("Implement fibonacci");
  });

  test("closes the session after completion", async () => {
    let closeCalled = false;
    const session = makeSession({
      closeFn: async () => {
        closeCalled = true;
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await new AcpAgentAdapter("claude").run(makeRunOptions());
    expect(closeCalled).toBe(true);
  });

  test("uses approve-all permission mode when permissionProfile is unrestricted", async () => {
    let capturedMode = "";
    const session = makeSession();
    const client = makeClient(session, {
      createSessionFn: async (opts) => {
        capturedMode = opts.permissionMode;
        return session;
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => client);

    await new AcpAgentAdapter("claude").run(
      makeRunOptions({
        config: { execution: { permissionProfile: "unrestricted" } } as import("../../../../src/config").NaxConfig,
      }),
    );
    expect(capturedMode).toBe("approve-all");
  });

  test("uses default permission mode when dangerouslySkipPermissions is false", async () => {
    let capturedMode = "";
    const session = makeSession();
    const client = makeClient(session, {
      createSessionFn: async (opts) => {
        capturedMode = opts.permissionMode;
        return session;
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => client);

    await new AcpAgentAdapter("claude").run(makeRunOptions({ dangerouslySkipPermissions: false }));
    expect(capturedMode).toBe("approve-reads");
  });

  test("durationMs is non-negative", async () => {
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(makeSession()));
    const result = await new AcpAgentAdapter("claude").run(makeRunOptions());
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// run() — AgentResult mapping
// ─────────────────────────────────────────────────────────────────────────────

describe("run() — AgentResult mapping", () => {
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

  test.each([
    ["end_turn", true],
    ["cancelled", false],
    ["error", false],
  ])("success=%s when stopReason is '%s'", async (stopReason, expected) => {
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [{ role: "assistant", content: "output" }],
        stopReason,
        cumulative_token_usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").run(makeRunOptions());
    expect(result.success).toBe(expected);
  });

  test("estimatedCost is non-zero when cumulative_token_usage is present", async () => {
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [{ role: "assistant", content: "Done." }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 1000, output_tokens: 500 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").run(makeRunOptions());
    expect(result.estimatedCost).toBeGreaterThan(0);
  });

  test("estimatedCost is 0 when cumulative_token_usage is absent", async () => {
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [{ role: "assistant", content: "Done." }],
        stopReason: "end_turn",
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").run(makeRunOptions());
    expect(result.estimatedCost).toBe(0);
  });

  test("output contains text from session messages", async () => {
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [{ role: "assistant", content: "Here is the implementation." }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").run(makeRunOptions());
    expect(result.output).toContain("Here is the implementation.");
  });

  test("rateLimited is false on a successful run", async () => {
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(makeSession()));
    const result = await new AcpAgentAdapter("claude").run(makeRunOptions());
    expect(result.rateLimited).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// run() — rate limit retry
// ─────────────────────────────────────────────────────────────────────────────

describe("run() — rate limit retry", () => {
  const origCreateClient = _acpAdapterDeps.createClient;
  const origSleep = _acpAdapterDeps.sleep;

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    _acpAdapterDeps.sleep = origSleep;
    mock.restore();
  });

  test("retries up to 3 attempts on rate limit error then succeeds", async () => {
    let attempts = 0;
    const sleepCalls: number[] = [];
    _acpAdapterDeps.sleep = mock(async (ms: number) => {
      sleepCalls.push(ms);
    });

    const session = makeSession({
      promptFn: async (_: string) => {
        attempts++;
        if (attempts < 3) throw new Error("statusCode=429");
        return {
          messages: [{ role: "assistant", content: "Done." }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").run(makeRunOptions());

    expect(attempts).toBe(3);
    expect(result.success).toBe(true);
    expect(sleepCalls.length).toBe(2);
  });

  test("backoff delay increases between retries", async () => {
    let attempts = 0;
    const sleepCalls: number[] = [];
    _acpAdapterDeps.sleep = mock(async (ms: number) => {
      sleepCalls.push(ms);
    });

    const session = makeSession({
      promptFn: async (_: string) => {
        attempts++;
        if (attempts < 3) throw new Error("statusCode=429");
        return {
          messages: [{ role: "assistant", content: "Done." }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await new AcpAgentAdapter("claude").run(makeRunOptions());

    expect(sleepCalls.length).toBe(2);
    expect(sleepCalls[1]).toBeGreaterThan(sleepCalls[0]);
  });

  test("marks result as rateLimited=true after exhausting all 3 attempts", async () => {
    const sleepCalls: number[] = [];
    _acpAdapterDeps.sleep = mock(async (ms: number) => {
      sleepCalls.push(ms);
    });

    const session = makeSession({
      promptFn: async (_: string) => {
        throw new Error("statusCode=429");
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").run(makeRunOptions());

    expect(result.rateLimited).toBe(true);
    expect(result.success).toBe(false);
    expect(sleepCalls.length).toBeLessThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// run() — timeout
// ─────────────────────────────────────────────────────────────────────────────

describe("run() — timeout", () => {
  const origCreateClient = _acpAdapterDeps.createClient;
  const origSleep = _acpAdapterDeps.sleep;

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    _acpAdapterDeps.sleep = origSleep;
    mock.restore();
  });

  test("calls cancelActivePrompt() when timeout fires", async () => {
    let cancelCalled = false;
    const neverResolve = new Promise<never>(() => {});
    const session = makeSession({
      promptFn: () => neverResolve,
      cancelFn: async () => {
        cancelCalled = true;
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").run(makeRunOptions({ timeoutSeconds: 0.05 }));

    expect(cancelCalled).toBe(true);
    expect(result.success).toBe(false);
  });

  test("falls back to session close() if cancelActivePrompt() throws", async () => {
    let closeCalled = false;
    const neverResolve = new Promise<never>(() => {});
    const session = makeSession({
      promptFn: () => neverResolve,
      cancelFn: async () => {
        throw new Error("cancel not supported");
      },
      closeFn: async () => {
        closeCalled = true;
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await new AcpAgentAdapter("claude").run(makeRunOptions({ timeoutSeconds: 0.05 }));

    expect(closeCalled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// run() — tokenUsage
// ─────────────────────────────────────────────────────────────────────────────

describe("run() — tokenUsage", () => {
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

  test("returns tokenUsage with inputTokens and outputTokens when cumulative_token_usage is present", async () => {
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [{ role: "assistant", content: "Done." }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 1000, output_tokens: 500 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").run(makeRunOptions());

    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage?.inputTokens).toBe(1000);
    expect(result.tokenUsage?.outputTokens).toBe(500);
  });

  test("returns tokenUsage with cache fields when cumulative_token_usage includes them", async () => {
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [{ role: "assistant", content: "Done." }],
        stopReason: "end_turn",
        cumulative_token_usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
        },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").run(makeRunOptions());

    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage?.inputTokens).toBe(1000);
    expect(result.tokenUsage?.outputTokens).toBe(500);
    expect((result.tokenUsage as Record<string, unknown>)["cache_read_input_tokens"]).toBe(100);
    expect((result.tokenUsage as Record<string, unknown>)["cache_creation_input_tokens"]).toBe(50);
  });

  test("omits cache fields from tokenUsage when both are 0", async () => {
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [{ role: "assistant", content: "Done." }],
        stopReason: "end_turn",
        cumulative_token_usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").run(makeRunOptions());

    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage?.inputTokens).toBe(1000);
    expect(result.tokenUsage?.outputTokens).toBe(500);
    expect(Object.prototype.hasOwnProperty.call(result.tokenUsage, "cache_read_input_tokens")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.tokenUsage, "cache_creation_input_tokens")).toBe(false);
  });

  test("returns undefined tokenUsage when cumulative_token_usage is absent", async () => {
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [{ role: "assistant", content: "Done." }],
        stopReason: "end_turn",
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").run(makeRunOptions());

    expect(result.tokenUsage).toBeUndefined();
  });

  test("accumulates tokenUsage across multiple turns in multi-turn session", async () => {
    let turnCount = 0;
    const session = makeSession({
      promptFn: async (_: string) => {
        turnCount++;
        return {
          messages: [{ role: "assistant", content: "Please confirm which approach to use?" }],
          stopReason: "end_turn",
          cumulative_token_usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
          },
        };
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").run(
      makeRunOptions({
        interactionBridge: { detectQuestion: async () => true, onQuestionDetected: async () => "answer" },
        maxInteractionTurns: 3,
      }),
    );

    expect(result.tokenUsage).toBeDefined();
    expect(turnCount).toBe(3);
    expect(result.tokenUsage?.inputTokens).toBe(300);
    expect(result.tokenUsage?.outputTokens).toBe(150);
    expect((result.tokenUsage as Record<string, unknown>)["cache_read_input_tokens"]).toBe(30);
    expect((result.tokenUsage as Record<string, unknown>)["cache_creation_input_tokens"]).toBe(15);
  });
});
