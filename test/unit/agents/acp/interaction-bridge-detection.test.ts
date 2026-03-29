/**
 * Unit Tests: AcpInteractionBridge — Question Detection and Routing — ACP-004
 *
 * Covers:
 * - Question pattern detection in sessionUpdate notifications
 * - Forwarding detected questions as InteractionRequests to the plugin
 * - Non-question messages are ignored (no false positives)
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
    ["BUG-097: nullish coalescing in code snippet", "Here's what was changed:\n\n**AC-2 fix**: Replaced with `batchResult.storyDurations?.get(story.id) ?? 0`"],
    ["BUG-097: optional chaining in status update", "Updated src/foo.ts to use config?.timeout instead of hardcoded value."],
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
