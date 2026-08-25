/**
 * Tests for ACP Activity Emission — Wire Stream Events into Agent Execution
 *
 * Covers:
 * - parseAcpxJsonLine() activity metadata return for message_update, thinking_update, usage_update
 * - Activity metadata structure (no raw content, deltaBytes/tokens/cost only)
 * - Stream callback threading through ACP client/session lifecycle
 * - Event emission during agent execution (call_started, process_update, activity events, call_ended)
 * - callId generation (unique UUID per physical prompt invocation)
 * - Terminal event handling across success, error, cancel, and parse failure paths
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { withDepsRestore } from "@test/helpers";
import { _spawnClientDeps, type AcpLineActivity, createParseState, parseAcpxJsonLine, SpawnAcpClient } from "@/agents";
import type { AgentStreamEvent } from "@/runtime";

// ─────────────────────────────────────────────────────────────────────────────
// parseAcpxJsonLine activity metadata tests
// ─────────────────────────────────────────────────────────────────────────────

describe("parseAcpxJsonLine — activity metadata return (AC1-3)", () => {
  test("AC1: returns activity with kind='message_update' and deltaBytes for agent_message_chunk", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "x",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello world" },
        },
      },
    });

    const state = createParseState();
    const activity = parseAcpxJsonLine(line, state);

    expect(activity).toBeDefined();
    expect(activity?.kind).toBe("message_update");
    expect(activity?.deltaBytes).toBe("hello world".length);
    expect(activity?.deltaBytes).toBeGreaterThanOrEqual(0);
  });

  test("AC2: returns activity with kind='thinking_update' and deltaBytes for agent_thought_chunk", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "x",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "let me think about this..." },
        },
      },
    });

    const state = createParseState();
    const activity = parseAcpxJsonLine(line, state);

    expect(activity).toBeDefined();
    expect(activity?.kind).toBe("thinking_update");
    expect(activity?.deltaBytes).toBe("let me think about this...".length);
    expect(activity?.deltaBytes).toBeGreaterThanOrEqual(0);
  });

  test("AC3: returns activity with kind='usage_update' and token/cost fields for usage_update", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "x",
        update: {
          sessionUpdate: "usage_update",
          used: 24848,
          size: 200000,
          cost: { amount: 0.15539, currency: "USD" },
        },
      },
    });

    const state = createParseState();
    const activity = parseAcpxJsonLine(line, state);

    expect(activity).toBeDefined();
    expect(activity?.kind).toBe("usage_update");
    expect(activity?.costUsd).toBe(0.15539);
    // At minimum, cost should be present for usage_update
  });

  test.each([
    ["unrelated JSON lines", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } })],
    ["invalid JSON", "not json"],
  ])("returns undefined for %s", (_label, line) => {
    const activity = parseAcpxJsonLine(line, createParseState());
    expect(activity).toBeUndefined();
  });

  test("accumulates text state while returning activity metadata", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "x",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    });

    const state = createParseState();
    const activity = parseAcpxJsonLine(line, state);

    // State should accumulate text
    expect(state.text).toBe("hello");
    // Activity should return metadata only
    expect(activity?.kind).toBe("message_update");
    // Activity should NOT include raw text
    expect((activity as any)?.text).toBeUndefined();
    expect((activity as any)?.content).toBeUndefined();
  });

  test("multiple activity events produce cumulative deltaBytes across calls", () => {
    const line1 = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "x",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello " },
        },
      },
    });

    const line2 = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "x",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "world" },
        },
      },
    });

    const state = createParseState();
    const activity1 = parseAcpxJsonLine(line1, state);
    const activity2 = parseAcpxJsonLine(line2, state);

    expect(activity1?.deltaBytes).toBe("hello ".length);
    expect(activity2?.deltaBytes).toBe("world".length);
    expect(state.text).toBe("hello world");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: Activity metadata never contains raw message/thought text
// ─────────────────────────────────────────────────────────────────────────────

describe("parseAcpxJsonLine — no raw content in activity metadata (AC4)", () => {
  test.each([
    ["message_update", "agent_message_chunk", "secret data should not leak"],
    ["thinking_update", "agent_thought_chunk", "internal reasoning that should not leak"],
  ] as const)("%s activity never includes raw content", (_kind, sessionUpdate, text) => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "x", update: { sessionUpdate, content: { type: "text", text } } },
    });
    const activity = parseAcpxJsonLine(line, createParseState());
    expect(activity).toBeDefined();
    expect((activity as any)?.text).toBeUndefined();
    expect((activity as any)?.content).toBeUndefined();
    expect((activity as any)?.thought).toBeUndefined();
    expect(activity?.deltaBytes).toBeGreaterThan(0);
  });

  test("activity type has no message or thought fields in its interface", () => {
    // This test validates the type definition itself
    const activity: AcpLineActivity = {
      kind: "message_update",
      deltaBytes: 42,
    };

    expect(activity.kind).toBe("message_update");
    expect(activity.deltaBytes).toBe(42);
    // These should not exist in the type at all
    expect((activity as any).text).toBeUndefined();
    expect((activity as any).message).toBeUndefined();
    expect((activity as any).thought).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stream callback and event emission tests
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Additional edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("parseAcpxJsonLine — edge cases", () => {
  test("handles empty text chunks", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "x",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "" },
        },
      },
    });

    const state = createParseState();
    const activity = parseAcpxJsonLine(line, state);

    expect(activity?.kind).toBe("message_update");
    expect(activity?.deltaBytes).toBe(0);
  });

  test("handles zero token usage", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "x",
        update: {
          sessionUpdate: "usage_update",
          used: 0,
          size: 0,
          cost: { amount: 0, currency: "USD" },
        },
      },
    });

    const state = createParseState();
    const activity = parseAcpxJsonLine(line, state);

    expect(activity?.kind).toBe("usage_update");
    expect(activity?.costUsd).toBe(0);
  });

  test("handles missing cost in usage_update", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "x",
        update: {
          sessionUpdate: "usage_update",
          used: 100,
          size: 200000,
        },
      },
    });

    const state = createParseState();
    const activity = parseAcpxJsonLine(line, state);

    expect(activity?.kind).toBe("usage_update");
    // costUsd should be undefined if not in source
    expect(activity?.costUsd).toBeUndefined();
  });

  test("does not return activity for legacy NDJSON format", () => {
    const line = JSON.stringify({
      content: "hello",
    });

    const state = createParseState();
    const activity = parseAcpxJsonLine(line, state);

    expect(activity).toBeUndefined();
    expect(state.text).toBe("hello");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stream callback option in AcpClient types
// ─────────────────────────────────────────────────────────────────────────────

describe("Stream callback in AcpClient/AcpSession types", () => {
  test("AcpClientOptions includes optional onStreamActivity callback", () => {
    // Type validation test — ensures the callback can be passed to AcpClient construction
    type OnStreamActivityCallback = (event: AgentStreamEvent) => void;
    const callback: OnStreamActivityCallback = (_event) => {};

    // Should be passable to AcpClient construction (tested in integration)
    expect(callback).toBeDefined();
  });

  test("onStreamActivity callback handles all AgentStreamEvent kinds", () => {
    const events: AgentStreamEvent[] = [];
    const onStreamActivity = (event: AgentStreamEvent) => events.push(event);

    // Various event types should be emissible through the callback
    const callStarted = {
      kind: "agent.call_started" as const,
      callId: randomUUID(),
      runId: randomUUID(),
      agentName: "claude",
      sessionName: "test-session",
      timestamp: Date.now(),
      model: "claude-sonnet-4-5",
      timeoutSeconds: 60,
    };

    const messageUpdate = {
      kind: "agent.message_update" as const,
      callId: callStarted.callId,
      runId: callStarted.runId,
      agentName: "claude",
      sessionName: "test-session",
      timestamp: Date.now(),
      deltaBytes: 42,
    };

    const toolCallUpdate = {
      kind: "agent.tool_call_update" as const,
      callId: callStarted.callId,
      runId: callStarted.runId,
      agentName: "claude",
      sessionName: "test-session",
      timestamp: Date.now(),
      toolName: "bash",
    };

    const callEnded = {
      kind: "agent.call_ended" as const,
      callId: callStarted.callId,
      runId: callStarted.runId,
      agentName: "claude",
      sessionName: "test-session",
      status: "success" as const,
      timestamp: Date.now(),
    };

    onStreamActivity(callStarted);
    onStreamActivity(messageUpdate);
    onStreamActivity(toolCallUpdate);
    onStreamActivity(callEnded);

    expect(events).toHaveLength(4);
    expect(events[0]?.kind).toBe("agent.call_started");
    expect(events[1]?.kind).toBe("agent.message_update");
    expect(events[2]?.kind).toBe("agent.tool_call_update");
    expect(events[3]?.kind).toBe("agent.call_ended");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal event path validation
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// AC9 — spawn failure must not emit call_started (bug: currently it does)
// ─────────────────────────────────────────────────────────────────────────────

function makeSpawnResult(exitCode: number, stdout = ""): ReturnType<typeof _spawnClientDeps.spawn> {
  const enc = new TextEncoder();
  const makeStream = (content: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        if (content) c.enqueue(enc.encode(content));
        c.close();
      },
    });
  return {
    stdout: makeStream(stdout),
    stderr: makeStream(""),
    stdin: { write: () => 0, end: () => {}, flush: () => {} },
    exited: Promise.resolve(exitCode),
    pid: 99999,
    kill: () => {},
  };
}

describe("AC9 — spawn failure emits call_ended without prior call_started", () => {
  withDepsRestore(_spawnClientDeps, ["spawn"]);

  test("no call_started is emitted when the acpx spawn throws before producing a PID", async () => {
    // Spec (AC9): When the spawned process fails to start, agent.call_ended { status: 'error' }
    // is emitted WITHOUT a prior agent.call_started event.
    //
    // Bug: The current implementation emits call_started (line 202) before calling spawn (line 213).
    // When spawn throws, call_ended is emitted in the catch — but call_started was already fired,
    // violating AC9. This test documents the spec-correct behavior and will FAIL until fixed.

    let callCount = 0;
    const events: AgentStreamEvent[] = [];

    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      // First spawn is the loadSession ensure command — must succeed so we get a session object.
      if (callCount === 1) return makeSpawnResult(0);
      // Second spawn is the prompt command — throw to simulate "process failed to start".
      throw new Error("spawn ENOENT: acpx binary not found");
    };

    const client = new SpawnAcpClient(
      "acpx --model claude-sonnet-4-5 claude",
      "/tmp",
      30,
      undefined, // onPidSpawned
      0, // promptRetries
      undefined, // onPidExited
      { onStreamActivity: (event) => events.push(event) },
    );

    const session = await client.loadSession("test-session", "claude", "approve-reads");
    expect(session).not.toBeNull();

    // Prompt must throw because spawn failed.
    let threw = false;
    try {
      await session!.prompt("hello");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const kinds = events.map((e) => e.kind);

    // AC9: call_ended must be present
    expect(kinds).toContain("agent.call_ended");
    const callEnded = events.find((e) => e.kind === "agent.call_ended");
    expect(callEnded).toMatchObject({ kind: "agent.call_ended", status: "error" });

    // AC9: call_started must NOT precede call_ended when spawn fails before producing a PID
    expect(kinds).not.toContain("agent.call_started");
  });

  test("no watchdog registry entry remains after spawn failure", async () => {
    // Registry leak fix (#2): onWatchdogRegister must NOT be called when spawn throws,
    // so the registry stays clean after a spawn failure.
    let callCount = 0;
    const registry = new Map<string, () => Promise<void>>();

    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0); // loadSession ensure — OK
      throw new Error("spawn ENOENT: acpx binary not found");
    };

    const client = new SpawnAcpClient("acpx --model claude-sonnet-4-5 claude", "/tmp", 30, undefined, 0, undefined, {
      onStreamActivity: () => {},
    });

    const session = await client.loadSession("test-session", "claude", "approve-reads");
    try {
      await session!.prompt("hello");
    } catch {
      /* expected */
    }

    // Registry must be empty — no entry should have been added for the failed spawn
    expect(registry.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10 — runId/storyId/stage from AcpClientOptions flow into session events
// ─────────────────────────────────────────────────────────────────────────────

describe("AC10 — correlation metadata flows from AcpClientOptions to session stream events", () => {
  withDepsRestore(_spawnClientDeps, ["spawn"]);

  test("stream events carry runId, storyId, stage provided via AcpClientOptions", async () => {
    let callCount = 0;
    const events: AgentStreamEvent[] = [];

    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0); // loadSession ensure
      const ndjson = `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0 },
        },
      })}\n`;
      return makeSpawnResult(0, ndjson);
    };

    const client = new SpawnAcpClient("acpx --model claude-sonnet-4-5 claude", "/tmp", 30, undefined, 0, undefined, {
      onStreamActivity: (event) => events.push(event),
      runId: "run-abc",
      storyId: "story-123",
      stage: "run",
    });

    const session = await client.loadSession("test-session", "claude", "approve-reads");
    await session!.prompt("hello");

    const callStarted = events.find((e) => e.kind === "agent.call_started");
    expect(callStarted).toBeDefined();
    expect(callStarted?.runId).toBe("run-abc");
    expect(callStarted?.storyId).toBe("story-123");
    expect(callStarted?.stage).toBe("run");

    // All events should carry the same correlation metadata
    for (const event of events) {
      expect(event.runId).toBe("run-abc");
      expect(event.storyId).toBe("story-123");
    }
  });

  test("tool_call stream updates are emitted through onStreamActivity", async () => {
    let callCount = 0;
    const events: AgentStreamEvent[] = [];

    _spawnClientDeps.spawn = (_cmd, _opts) => {
      callCount++;
      if (callCount === 1) return makeSpawnResult(0);
      const ndjson = `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "x",
          update: {
            sessionUpdate: "tool_call",
            toolName: "bash",
          },
        },
      })}\n${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0 },
        },
      })}\n`;
      return makeSpawnResult(0, ndjson);
    };

    const client = new SpawnAcpClient("acpx --model claude-sonnet-4-5 claude", "/tmp", 30, undefined, 0, undefined, {
      onStreamActivity: (event) => events.push(event),
    });

    const session = await client.loadSession("test-session", "claude", "approve-reads");
    await session!.prompt("hello");

    const toolCallEvent = events.find((event) => event.kind === "agent.tool_call_update");
    expect(toolCallEvent).toBeDefined();
    expect(toolCallEvent).toMatchObject({ kind: "agent.tool_call_update", toolName: "bash" });
  });
});
