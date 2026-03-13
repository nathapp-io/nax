/**
 * Unit Tests: AcpInteractionBridge — ACP-004
 *
 * Covers:
 * - Question pattern detection in sessionUpdate notifications
 * - Forwarding detected questions as InteractionRequests to the plugin
 * - Formatting human responses as follow-up prompts
 * - Timeout fallback: agent continues if no human response within timeout
 * - Non-question messages are ignored (no false positives)
 * - Bridge lifecycle (created, used, destroyed)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { InteractionPlugin, InteractionRequest, InteractionResponse } from "../../../../src/interaction/types";
import {
  AcpInteractionBridge,
  type BridgeConfig,
  type SessionNotification,
} from "../../../../src/agents/acp/interaction-bridge";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeNotification(content: string, overrides: Partial<SessionNotification> = {}): SessionNotification {
  return {
    sessionId: "sess-001",
    role: "assistant",
    content,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makePlugin(overrides: {
  sendFn?: (req: InteractionRequest) => Promise<void>;
  receiveFn?: (requestId: string, timeout?: number) => Promise<InteractionResponse>;
} = {}): InteractionPlugin {
  return {
    name: "mock-plugin",
    send: overrides.sendFn ?? mock(async (_req: InteractionRequest) => {}),
    receive: overrides.receiveFn ?? mock(async (_requestId: string, _timeout?: number): Promise<InteractionResponse> => ({
      requestId: _requestId,
      action: "input",
      value: "Continue with the default approach.",
      respondedBy: "user",
      respondedAt: Date.now(),
    })),
  };
}

function makeBridgeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    featureName: "test-feature",
    storyId: "STORY-001",
    responseTimeoutMs: 5_000,
    fallbackPrompt: "continue",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Question pattern detection
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpInteractionBridge — question pattern detection", () => {
  let plugin: InteractionPlugin;
  let bridge: AcpInteractionBridge;

  beforeEach(() => {
    plugin = makePlugin();
    bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());
  });

  afterEach(() => {
    mock.restore();
  });

  test.each([
    ["ends with question mark", "Should I proceed with this approach?"],
    ["contains 'which'", "which option do you prefer"],
    ["contains 'should I'", "should I use TypeScript or JavaScript here"],
    ["contains 'unclear'", "The requirements are unclear to me"],
    ["contains 'please clarify'", "please clarify what format you need"],
    ["question mark mid-sentence", "Do you want Option A? Or Option B?"],
  ])("detects question: %s", (_label, content) => {
    const notification = makeNotification(content);
    expect(bridge.isQuestion(notification)).toBe(true);
  });

  test.each([
    ["plain statement", "Task completed successfully."],
    ["status update", "Running tests now."],
    ["code output", "function hello() { return 42; }"],
    ["progress report", "Wrote 3 files to disk."],
    ["empty content", ""],
  ])("non-question ignored: %s", (_label, content) => {
    const notification = makeNotification(content);
    expect(bridge.isQuestion(notification)).toBe(false);
  });

  test("only assistant messages are treated as questions", () => {
    const userNotification = makeNotification("which approach?", { role: "user" });
    const systemNotification = makeNotification("should I proceed?", { role: "system" });
    expect(bridge.isQuestion(userNotification)).toBe(false);
    expect(bridge.isQuestion(systemNotification)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// onSessionUpdate — routing questions to interaction chain
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpInteractionBridge — onSessionUpdate forwards questions", () => {
  afterEach(() => {
    mock.restore();
  });

  test("calls plugin.send with an InteractionRequest when a question is detected", async () => {
    const sent: InteractionRequest[] = [];
    const plugin = makePlugin({
      sendFn: async (req) => { sent.push(req); },
    });
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());

    await bridge.onSessionUpdate(makeNotification("Which approach should I use?"));

    expect(sent.length).toBe(1);
    expect(sent[0].type).toBe("input");
  });

  test("InteractionRequest contains the agent question as summary", async () => {
    const sent: InteractionRequest[] = [];
    const plugin = makePlugin({
      sendFn: async (req) => { sent.push(req); },
    });
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());

    const question = "Should I use PostgreSQL or SQLite?";
    await bridge.onSessionUpdate(makeNotification(question));

    expect(sent[0].summary).toContain(question);
  });

  test("InteractionRequest stage is 'execution'", async () => {
    const sent: InteractionRequest[] = [];
    const plugin = makePlugin({ sendFn: async (req) => { sent.push(req); } });
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());

    await bridge.onSessionUpdate(makeNotification("unclear — should I continue?"));

    expect(sent[0].stage).toBe("execution");
  });

  test("InteractionRequest includes featureName and storyId from config", async () => {
    const sent: InteractionRequest[] = [];
    const plugin = makePlugin({ sendFn: async (req) => { sent.push(req); } });
    const config = makeBridgeConfig({ featureName: "my-feature", storyId: "FEAT-007" });
    const bridge = new AcpInteractionBridge(plugin, config);

    await bridge.onSessionUpdate(makeNotification("please clarify the requirements"));

    expect(sent[0].featureName).toBe("my-feature");
    expect(sent[0].storyId).toBe("FEAT-007");
  });

  test("InteractionRequest fallback is 'continue'", async () => {
    const sent: InteractionRequest[] = [];
    const plugin = makePlugin({ sendFn: async (req) => { sent.push(req); } });
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());

    await bridge.onSessionUpdate(makeNotification("should I add error handling?"));

    expect(sent[0].fallback).toBe("continue");
  });

  test("does not call plugin.send when message is not a question", async () => {
    const sent: InteractionRequest[] = [];
    const plugin = makePlugin({ sendFn: async (req) => { sent.push(req); } });
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());

    await bridge.onSessionUpdate(makeNotification("Task completed successfully."));

    expect(sent.length).toBe(0);
  });

  test("does not call plugin.send for non-assistant messages", async () => {
    const sent: InteractionRequest[] = [];
    const plugin = makePlugin({ sendFn: async (req) => { sent.push(req); } });
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());

    await bridge.onSessionUpdate(makeNotification("which approach?", { role: "user" }));

    expect(sent.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// waitForResponse — blocks and resolves with human input
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpInteractionBridge — waitForResponse", () => {
  afterEach(() => {
    mock.restore();
  });

  test("returns the InteractionResponse from the plugin", async () => {
    const expectedResponse: InteractionResponse = {
      requestId: "req-001",
      action: "input",
      value: "Use PostgreSQL",
      respondedBy: "user",
      respondedAt: Date.now(),
    };
    const plugin = makePlugin({
      receiveFn: async (_id, _timeout) => expectedResponse,
    });
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());

    const result = await bridge.waitForResponse("req-001", 5_000);

    expect(result).toEqual(expectedResponse);
  });

  test("passes timeout to plugin.receive", async () => {
    let receivedTimeout: number | undefined;
    const plugin = makePlugin({
      receiveFn: async (_id, timeout) => {
        receivedTimeout = timeout;
        return {
          requestId: _id,
          action: "input",
          value: "ok",
          respondedBy: "user",
          respondedAt: Date.now(),
        };
      },
    });
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());

    await bridge.waitForResponse("req-002", 10_000);

    expect(receivedTimeout).toBe(10_000);
  });

  test("returns timeout fallback response when plugin.receive throws", async () => {
    const plugin = makePlugin({
      receiveFn: async (_id, _timeout) => {
        throw new Error("Timeout");
      },
    });
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());

    const result = await bridge.waitForResponse("req-003", 100);

    expect(result.respondedBy).toBe("timeout");
    expect(result.action).toBe("input");
    expect(result.value).toBe("continue");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getFollowUpPrompt — formats human response as follow-up prompt
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpInteractionBridge — getFollowUpPrompt", () => {
  afterEach(() => {
    mock.restore();
  });

  test("returns a non-empty string when given a response with value", () => {
    const plugin = makePlugin();
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());
    const response: InteractionResponse = {
      requestId: "req-001",
      action: "input",
      value: "Use PostgreSQL for the database.",
      respondedBy: "user",
      respondedAt: Date.now(),
    };

    const prompt = bridge.getFollowUpPrompt(response);

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("includes the human response value in the follow-up prompt", () => {
    const plugin = makePlugin();
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());
    const response: InteractionResponse = {
      requestId: "req-001",
      action: "input",
      value: "Please use the Builder pattern here.",
      respondedBy: "user",
      respondedAt: Date.now(),
    };

    const prompt = bridge.getFollowUpPrompt(response);

    expect(prompt).toContain("Please use the Builder pattern here.");
  });

  test("returns fallback prompt string when response has no value", () => {
    const plugin = makePlugin();
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig({ fallbackPrompt: "continue" }));
    const response: InteractionResponse = {
      requestId: "req-001",
      action: "input",
      value: undefined,
      respondedBy: "timeout",
      respondedAt: Date.now(),
    };

    const prompt = bridge.getFollowUpPrompt(response);

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("continue");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Timeout fallback — agent continues autonomously when no human responds
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpInteractionBridge — timeout fallback behavior", () => {
  afterEach(() => {
    mock.restore();
  });

  test("uses config.responseTimeoutMs as the receive timeout", async () => {
    let receivedTimeout: number | undefined;
    const plugin = makePlugin({
      receiveFn: async (_id, timeout) => {
        receivedTimeout = timeout;
        return {
          requestId: _id,
          action: "input",
          value: "ok",
          respondedBy: "user",
          respondedAt: Date.now(),
        };
      },
    });
    const config = makeBridgeConfig({ responseTimeoutMs: 7_500 });
    const bridge = new AcpInteractionBridge(plugin, config);

    await bridge.waitForResponse("req-001", config.responseTimeoutMs);

    expect(receivedTimeout).toBe(7_500);
  });

  test("fallback response value is 'continue' when timed out", async () => {
    const plugin = makePlugin({
      receiveFn: async () => { throw new Error("Timed out waiting for user"); },
    });
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());

    const result = await bridge.waitForResponse("req-timeout", 100);

    expect(result.value).toBe("continue");
    expect(result.respondedBy).toBe("timeout");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bridge lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpInteractionBridge — lifecycle", () => {
  afterEach(() => {
    mock.restore();
  });

  test("destroy() completes without throwing", async () => {
    const plugin = makePlugin();
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());

    await bridge.destroy();
  });

  test("after destroy(), bridge no longer processes updates", async () => {
    const sent: InteractionRequest[] = [];
    const plugin = makePlugin({ sendFn: async (req) => { sent.push(req); } });
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());

    await bridge.destroy();
    await bridge.onSessionUpdate(makeNotification("should I proceed?"));

    expect(sent.length).toBe(0);
  });

  test("bridge emits a structured event when a question is detected", async () => {
    const events: unknown[] = [];
    const plugin = makePlugin();
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());
    bridge.on("question-detected", (event: unknown) => { events.push(event); });

    await bridge.onSessionUpdate(makeNotification("which library should I use?"));

    expect(events.length).toBe(1);
  });

  test("bridge emits a structured event when a response is received", async () => {
    const events: unknown[] = [];
    const plugin = makePlugin();
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());
    bridge.on("response-received", (event: unknown) => { events.push(event); });

    await bridge.waitForResponse("req-001", 5_000);

    // Event must have been emitted (plugin returns a response by default)
    expect(events.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration with existing interaction plugins
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpInteractionBridge — plugin integration", () => {
  afterEach(() => {
    mock.restore();
  });

  test("works with any InteractionPlugin (duck-type compatible)", async () => {
    // Simulates a Telegram/CLI/webhook plugin via the shared interface
    const telegramLikePlugin: InteractionPlugin = {
      name: "telegram",
      send: mock(async () => {}),
      receive: mock(async (_id: string, _timeout?: number): Promise<InteractionResponse> => ({
        requestId: _id,
        action: "input",
        value: "Confirmed via Telegram.",
        respondedBy: "telegram-user",
        respondedAt: Date.now(),
      })),
    };

    const bridge = new AcpInteractionBridge(telegramLikePlugin, makeBridgeConfig());
    const result = await bridge.waitForResponse("req-tg-001", 5_000);

    expect(result.value).toBe("Confirmed via Telegram.");
    expect(result.respondedBy).toBe("telegram-user");
  });

  test("send is called with the correct requestId", async () => {
    const sent: InteractionRequest[] = [];
    const plugin = makePlugin({ sendFn: async (req) => { sent.push(req); } });
    const bridge = new AcpInteractionBridge(plugin, makeBridgeConfig());

    await bridge.onSessionUpdate(makeNotification("please clarify the output format"));

    expect(sent.length).toBe(1);
    expect(typeof sent[0].id).toBe("string");
    expect(sent[0].id.length).toBeGreaterThan(0);
  });
});
