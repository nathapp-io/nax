import { describe, expect, test } from "bun:test";
import type { AgentStreamEvent } from "@nathapp/nax-agent";
import { type StreamContext, startCall } from "@/agents/acp/stream-bridge";

function context(events: AgentStreamEvent[], pid?: number): StreamContext {
  return {
    emit: (event) => events.push(event),
    agentName: "claude",
    sessionName: "nax-s",
    runId: "run-1",
    storyId: "US-001",
    model: "sonnet",
    timeoutSeconds: 600,
    pid: () => pid,
  };
}

describe("startCall (S4b spec §6.2.1)", () => {
  test("starts with call_started carrying the run identifiers", () => {
    const events: AgentStreamEvent[] = [];
    const call = startCall(context(events), () => 7);
    expect(events).toEqual([
      {
        callId: call.callId,
        runId: "run-1",
        agentName: "claude",
        sessionName: "nax-s",
        storyId: "US-001",
        kind: "agent.call_started",
        model: "sonnet",
        timeoutSeconds: 600,
        timestamp: 7,
      },
    ]);
  });

  test("emits process_update only when a pid is known", () => {
    const events: AgentStreamEvent[] = [];
    startCall(context(events, 4242));
    expect(events.map((e) => e.kind)).toEqual(["agent.call_started", "agent.process_update"]);
    expect(events[1]).toMatchObject({ status: "spawned", pid: 4242 });
  });

  test("maps text, thinking, tool and usage events; deltaBytes is UTF-8 bytes", () => {
    const events: AgentStreamEvent[] = [];
    const call = startCall(context(events));
    call.sink({ type: "text_delta", round: 1, text: "hé" });
    call.sink({ type: "thinking_delta", round: 1, text: "abc" });
    call.sink({ type: "tool_call", callId: "t1", name: "Read", input: {} });
    call.sink({ type: "tool_progress", callId: "t1" });
    call.sink({ type: "tool_result", callId: "t1", isError: false, preview: "ok" });
    call.sink({
      type: "usage",
      round: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheRead: 2,
      costUsd: 0.01,
      costSource: "reported",
    });
    call.sink({ type: "stream_reset", round: 1, attempt: 2 });
    expect(events.slice(1)).toMatchObject([
      { kind: "agent.message_update", deltaBytes: 3 },
      { kind: "agent.thinking_update", deltaBytes: 3 },
      { kind: "agent.tool_call_update", toolName: "Read" },
      { kind: "agent.tool_call_update", toolName: "Read" },
      { kind: "agent.tool_call_update", toolName: "Read" },
      {
        kind: "agent.usage_update",
        inputTokens: 10,
        outputTokens: 5,
        cacheRead: 2,
        costUsd: 0.01,
        cadence: "agent",
      },
    ]);
  });

  test("an unpriced usage event carries no costUsd", () => {
    const events: AgentStreamEvent[] = [];
    const call = startCall(context(events));
    call.sink({ type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, costSource: "unpriced" });
    expect(events.at(-1)).not.toHaveProperty("costUsd");
  });

  test("call_ended is emitted exactly once and silences the call", () => {
    const events: AgentStreamEvent[] = [];
    const call = startCall(context(events));
    call.end("error");
    call.end("success");
    call.sink({ type: "text_delta", round: 1, text: "late" });
    call.awaitingHuman();
    expect(events.map((e) => e.kind)).toEqual(["agent.call_started", "agent.call_ended"]);
    expect(events[1]).toMatchObject({ status: "error" });
  });

  test("every event reaches the audit recorder, also after call_ended", () => {
    const seen: string[] = [];
    const audit = { onEvent: (e: { type: string }) => seen.push(e.type), denied: () => {}, flush: async () => {} };
    const call = startCall({ ...context([]), audit });
    call.sink({ type: "tool_call", callId: "c1", name: "Read", input: {} });
    call.end("error");
    call.sink({ type: "tool_result", callId: "c1", isError: false, preview: "" });
    expect(seen).toEqual(["tool_call", "tool_result"]);
  });

  test("tracks side effects: text or a tool call, not thinking", () => {
    const events: AgentStreamEvent[] = [];
    const thinking = startCall(context(events));
    thinking.sink({ type: "thinking_delta", round: 1, text: "hm" });
    expect(thinking.sideEffects()).toBe(false);
    const tool = startCall(context(events));
    tool.sink({ type: "tool_call", callId: "t", name: "Bash", input: {} });
    expect(tool.sideEffects()).toBe(true);
  });

  test("anyEvent is true after any turn event, thinking and usage included (T1-1)", () => {
    for (const event of [
      { type: "thinking_delta", text: "hm", round: 1 },
      { type: "usage", round: 1, inputTokens: 1, outputTokens: 0, costUsd: 0, costSource: "unpriced" },
      { type: "tool_progress", callId: "c1" },
    ] as const) {
      const call = startCall(context([]));
      expect(call.anyEvent()).toBe(false);
      call.sink(event);
      expect(call.anyEvent()).toBe(true);
      expect(call.sideEffects()).toBe(false);
    }
  });

  test("awaitingHuman emits agent.awaiting_human on the call", () => {
    const events: AgentStreamEvent[] = [];
    const call = startCall(context(events));
    call.awaitingHuman();
    expect(events.at(-1)).toMatchObject({ kind: "agent.awaiting_human", callId: call.callId });
  });

  test("a throwing listener never reaches the turn; no listener is fine", () => {
    const call = startCall({
      ...context([]),
      emit: () => {
        throw new Error("listener bug");
      },
    });
    expect(() => call.sink({ type: "text_delta", round: 1, text: "x" })).not.toThrow();
    expect(() => startCall({ ...context([]), emit: undefined }).end("success")).not.toThrow();
  });

  test("storyId is omitted when absent", () => {
    const events: AgentStreamEvent[] = [];
    startCall({ ...context(events), storyId: undefined });
    expect(events[0]).not.toHaveProperty("storyId");
  });
});
