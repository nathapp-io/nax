import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { initLogger, getLogger, resetLogger } from "../../../../src/logger";
import type { LogEntry } from "../../../../src/logger/types";
import { AgentStreamEventBus } from "../../../../src/runtime/agent-stream-events";
import type { AgentStreamEvent } from "../../../../src/runtime/agent-stream-events";
import { attachAgentStreamLogging } from "../../../../src/runtime/middleware/agent-stream-logging";
import { cleanupTempDir, makeTempDir } from "../../../helpers";

function makeCallStartedEvent(overrides: Partial<AgentStreamEvent> = {}): AgentStreamEvent {
  return {
    kind: "agent.call_started",
    callId: "call-001",
    runId: "run-001",
    agentName: "claude",
    sessionName: "nax-abc-feat-s1-main",
    storyId: "s-42",
    stage: "run",
    pid: 1234,
    timestamp: 1000,
    model: "claude-opus-4-5",
    timeoutSeconds: 60,
    ...overrides,
  } as AgentStreamEvent;
}

function makeCallEndedEvent(overrides: Partial<AgentStreamEvent> = {}): AgentStreamEvent {
  return {
    kind: "agent.call_ended",
    callId: "call-001",
    runId: "run-001",
    agentName: "claude",
    sessionName: "nax-abc-feat-s1-main",
    storyId: "s-42",
    stage: "run",
    timestamp: 5000,
    status: "success",
    ...overrides,
  } as AgentStreamEvent;
}

function makeMessageUpdateEvent(overrides: Partial<AgentStreamEvent> = {}): AgentStreamEvent {
  return {
    kind: "agent.message_update",
    callId: "call-001",
    runId: "run-001",
    agentName: "claude",
    sessionName: "nax-abc-feat-s1-main",
    storyId: "s-42",
    stage: "run",
    timestamp: 2000,
    deltaBytes: 100,
    ...overrides,
  } as AgentStreamEvent;
}

function makeThinkingUpdateEvent(overrides: Partial<AgentStreamEvent> = {}): AgentStreamEvent {
  return {
    kind: "agent.thinking_update",
    callId: "call-001",
    runId: "run-001",
    agentName: "claude",
    sessionName: "nax-abc-feat-s1-main",
    storyId: "s-42",
    stage: "run",
    timestamp: 3000,
    deltaBytes: 50,
    ...overrides,
  } as AgentStreamEvent;
}

function makeUsageUpdateEvent(overrides: Partial<AgentStreamEvent> = {}): AgentStreamEvent {
  return {
    kind: "agent.usage_update",
    callId: "call-001",
    runId: "run-001",
    agentName: "claude",
    sessionName: "nax-abc-feat-s1-main",
    storyId: "s-42",
    stage: "run",
    timestamp: 4000,
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  } as AgentStreamEvent;
}

async function parseAllEntries(logFile: string): Promise<LogEntry[]> {
  const content = await Bun.file(logFile).text();
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

async function parseLastEntry(logFile: string): Promise<LogEntry> {
  const entries = await parseAllEntries(logFile);
  return entries[entries.length - 1];
}

describe("attachAgentStreamLogging", () => {
  let logFile: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-test-agent-stream-logging-");
    logFile = join(tmpDir, `test-agent-stream-logging-${Date.now()}.jsonl`);
    initLogger({ level: "silent", filePath: logFile });
  });

  afterEach(async () => {
    await getLogger().flush();
    resetLogger();
    cleanupTempDir(tmpDir);
  });

  // AC1: logs agent.call_started events with required fields
  test("logs call_started event with callId, agentName, storyId, stage, model, timeoutSeconds", async () => {
    const bus = new AgentStreamEventBus();
    attachAgentStreamLogging(bus, "r-001");

    bus.emitAgentStream(
      makeCallStartedEvent({
        callId: "call-001",
        agentName: "claude",
        storyId: "s-42",
        stage: "run",
        model: "claude-opus-4-5",
        timeoutSeconds: 120,
      } as any),
    );
    await getLogger().flush();

    const entry = await parseLastEntry(logFile);
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("Agent call started");
    expect(entry.data).toMatchObject({
      storyId: "s-42",
      callId: "call-001",
      agentName: "claude",
      stage: "run",
      model: "claude-opus-4-5",
      timeoutSeconds: 120,
    });
  });

  // AC2: logs agent.call_ended events with completion counters and idleMs
  test("logs call_ended event with messageUpdates, thinkingUpdates, usageUpdates, lastActivityAt, idleMs", async () => {
    const bus = new AgentStreamEventBus();
    attachAgentStreamLogging(bus, "r-001");

    const startedAt = 1000;
    const lastActivityAt = 4000;
    const endedAt = 5000;

    bus.emitAgentStream(makeCallStartedEvent({ timestamp: startedAt } as any));
    bus.emitAgentStream(makeMessageUpdateEvent({ timestamp: 2000 } as any));
    bus.emitAgentStream(makeThinkingUpdateEvent({ timestamp: 3000 } as any));
    bus.emitAgentStream(makeUsageUpdateEvent({ timestamp: lastActivityAt } as any));
    bus.emitAgentStream(makeCallEndedEvent({ timestamp: endedAt } as any));
    await getLogger().flush();

    const entries = await parseAllEntries(logFile);
    const endedEntry = entries.find((e) => e.message === "Agent call ended");
    expect(endedEntry).toBeDefined();
    expect(endedEntry!.level).toBe("info");
    expect(endedEntry!.data).toMatchObject({
      storyId: "s-42",
      callId: "call-001",
      messageUpdates: 1,
      thinkingUpdates: 1,
      usageUpdates: 1,
      lastActivityAt: lastActivityAt,
      idleMs: endedAt - lastActivityAt,
    });
  });

  // AC3: log output never contains raw thinking content
  test("does not log raw thinking deltaBytes content — only metadata", async () => {
    const bus = new AgentStreamEventBus();
    attachAgentStreamLogging(bus, "r-001");

    bus.emitAgentStream(makeCallStartedEvent());
    bus.emitAgentStream(
      makeThinkingUpdateEvent({
        // deltaBytes is a byte count (number), not a string — verify no raw text leaks
        deltaBytes: 42,
      } as any),
    );
    bus.emitAgentStream(makeCallEndedEvent());
    await getLogger().flush();

    const content = await Bun.file(logFile).text();
    // The raw "thinking content" key should never appear in logs
    expect(content).not.toContain("agent_thought_chunk");
    // Thinking update events should not produce a separate log line
    const entries = await parseAllEntries(logFile);
    const thinkingEntries = entries.filter((e) => e.message?.includes("thinking") && e.data?.delta);
    expect(thinkingEntries.length).toBe(0);
  });

  // Unsubscribe stops logging
  test("unsubscribe stops logging stream events", async () => {
    const bus = new AgentStreamEventBus();
    const unsub = attachAgentStreamLogging(bus, "r-001");

    bus.emitAgentStream(makeCallStartedEvent({ callId: "call-A" } as any));
    await getLogger().flush();

    const contentBefore = await Bun.file(logFile).text();
    const linesBefore = contentBefore.trim().split("\n").filter(Boolean).length;

    unsub();
    bus.emitAgentStream(makeCallStartedEvent({ callId: "call-B" } as any));
    await getLogger().flush();

    const contentAfter = await Bun.file(logFile).text();
    const linesAfter = contentAfter.trim().split("\n").filter(Boolean).length;
    expect(linesAfter).toBe(linesBefore);
  });

  // No-op when logger not initialized
  test("is a no-op when logger is not initialized", () => {
    resetLogger();
    const bus = new AgentStreamEventBus();
    attachAgentStreamLogging(bus, "r-001");
    expect(() => bus.emitAgentStream(makeCallStartedEvent())).not.toThrow();
    expect(() => bus.emitAgentStream(makeCallEndedEvent())).not.toThrow();
  });

  // Multiple concurrent calls tracked independently
  test("tracks multiple concurrent calls with separate counters", async () => {
    const bus = new AgentStreamEventBus();
    attachAgentStreamLogging(bus, "r-001");

    bus.emitAgentStream(makeCallStartedEvent({ callId: "call-A", agentName: "claude", timestamp: 1000 } as any));
    bus.emitAgentStream(makeCallStartedEvent({ callId: "call-B", agentName: "codex", timestamp: 1000 } as any));

    bus.emitAgentStream(makeMessageUpdateEvent({ callId: "call-A", timestamp: 2000 } as any));
    bus.emitAgentStream(makeMessageUpdateEvent({ callId: "call-A", timestamp: 2100 } as any));
    bus.emitAgentStream(makeMessageUpdateEvent({ callId: "call-B", timestamp: 2200 } as any));

    bus.emitAgentStream(makeCallEndedEvent({ callId: "call-A", timestamp: 3000 } as any));
    bus.emitAgentStream(makeCallEndedEvent({ callId: "call-B", timestamp: 4000 } as any));
    await getLogger().flush();

    const entries = await parseAllEntries(logFile);
    const endedEntries = entries.filter((e) => e.message === "Agent call ended");
    expect(endedEntries.length).toBe(2);

    const callAEnded = endedEntries.find((e) => e.data?.callId === "call-A");
    const callBEnded = endedEntries.find((e) => e.data?.callId === "call-B");

    expect(callAEnded?.data?.messageUpdates).toBe(2);
    expect(callBEnded?.data?.messageUpdates).toBe(1);
  });
});
