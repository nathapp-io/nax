import { describe, expect, test } from "bun:test";
import type {
  AgentAwaitingHumanEvent,
  AgentMessageUpdateEvent,
  AgentUsageUpdateEvent,
} from "@/runtime/agent-stream-events";
import { AgentStreamEventBus } from "@/runtime/agent-stream-events";
import { type CompleteDispatchEvent, DispatchEventBus, type SessionTurnDispatchEvent } from "@/runtime/dispatch-events";
import { attachUsageAuditSubscriber } from "@/runtime/middleware/usage-audit";
import type { IUsageAuditor, UsageAuditEntry } from "@/runtime/usage-auditor";

const PERMS = { mode: "approve-reads" as const, bashApproval: "raw" as const };

function makeUsageEvent(overrides: Partial<AgentUsageUpdateEvent> = {}): AgentUsageUpdateEvent {
  return {
    kind: "agent.usage_update",
    callId: "call-001",
    runId: "run-001",
    agentName: "claude",
    sessionName: "nax-abc-feat-US-001-implementer",
    storyId: "US-001",
    stage: "run",
    timestamp: 4_000,
    scopeId: "scope-1",
    inputTokens: 120,
    outputTokens: 45,
    cacheRead: 30,
    cacheWrite: 12,
    roundTrip: 37,
    cadence: "round-trip",
    costUsd: 0.0042,
    ...overrides,
  };
}

function makeMessageEvent(): AgentMessageUpdateEvent {
  return {
    kind: "agent.message_update",
    callId: "call-001",
    runId: "run-001",
    agentName: "claude",
    sessionName: "nax-abc-feat-US-001-implementer",
    timestamp: 4_500,
    deltaBytes: 10,
  };
}

function makeAwaitingHumanEvent(): AgentAwaitingHumanEvent {
  return {
    kind: "agent.awaiting_human",
    callId: "call-001",
    runId: "run-001",
    agentName: "claude",
    sessionName: "nax-abc-feat-US-001-implementer",
    storyId: "US-001",
    stage: "run",
    timestamp: 5_000,
  };
}

function makeCompleteEvent(overrides: Partial<CompleteDispatchEvent> = {}): CompleteDispatchEvent {
  return {
    kind: "complete",
    sessionName: "nax-abc-feat-US-002-auto",
    sessionRole: "auto",
    prompt: "summarise",
    response: "done",
    agentName: "claude",
    stage: "run",
    resolvedPermissions: PERMS,
    durationMs: 100,
    timestamp: 4_000,
    ...overrides,
  };
}

function makeSessionTurnEvent(overrides: Partial<SessionTurnDispatchEvent> = {}): SessionTurnDispatchEvent {
  return {
    kind: "session-turn",
    sessionName: "nax-abc-feat-US-002-main",
    sessionRole: "main",
    prompt: "hello",
    response: "world",
    agentName: "claude",
    stage: "run",
    resolvedPermissions: PERMS,
    roundTrips: 1,
    roundTripUnit: "agent-run",
    protocolIds: { sessionId: "sess-1" },
    origin: "runAsSession",
    durationMs: 100,
    timestamp: 4_000,
    ...overrides,
  };
}

function makeAuditor(recorded: UsageAuditEntry[]): IUsageAuditor {
  return {
    record: (entry) => recorded.push(entry),
    async flush() {},
  };
}

describe("attachUsageAuditSubscriber", () => {
  test("records one row per agent.usage_update and maps the event fields", () => {
    const recorded: UsageAuditEntry[] = [];
    const bus = new AgentStreamEventBus();
    attachUsageAuditSubscriber(bus, new DispatchEventBus(), makeAuditor(recorded), "run-001");

    bus.emitAgentStream(makeUsageEvent());
    bus.emitAgentStream(makeMessageEvent());
    bus.emitAgentStream(makeUsageEvent({ callId: "call-002", roundTrip: 38 }));

    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toEqual({
      ts: 4_000,
      runId: "run-001",
      scopeId: "scope-1",
      streamCallId: "call-001",
      sessionName: "nax-abc-feat-US-001-implementer",
      storyId: "US-001",
      stage: "run",
      agentName: "claude",
      roundTrip: 37,
      cadence: "round-trip",
      input: 120,
      output: 45,
      cacheRead: 30,
      cacheWrite: 12,
      costUsd: 0.0042,
    });
    expect(recorded[1].streamCallId).toBe("call-002");
    expect(recorded[1].roundTrip).toBe(38);
  });

  test("carries absent optional fields through as absent", () => {
    const recorded: UsageAuditEntry[] = [];
    const bus = new AgentStreamEventBus();
    attachUsageAuditSubscriber(bus, new DispatchEventBus(), makeAuditor(recorded), "run-001");

    bus.emitAgentStream(
      makeUsageEvent({
        scopeId: undefined,
        storyId: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
        roundTrip: undefined,
        cadence: undefined,
        costUsd: undefined,
      }),
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0].scopeId).toBeUndefined();
    expect(recorded[0].cacheRead).toBeUndefined();
    expect(recorded[0].cacheWrite).toBeUndefined();
    expect(recorded[0].roundTrip).toBeUndefined();
    expect(recorded[0].cadence).toBeUndefined();
  });

  test("returns a working unsubscribe", () => {
    const recorded: UsageAuditEntry[] = [];
    const bus = new AgentStreamEventBus();
    const off = attachUsageAuditSubscriber(bus, new DispatchEventBus(), makeAuditor(recorded), "run-001");

    bus.emitAgentStream(makeUsageEvent());
    expect(recorded).toHaveLength(1);

    off();
    bus.emitAgentStream(makeUsageEvent({ callId: "call-003" }));
    expect(recorded).toHaveLength(1);
  });

  test("US-004: agent.awaiting_human is ignored without error or a recorded row", () => {
    const recorded: UsageAuditEntry[] = [];
    const bus = new AgentStreamEventBus();
    attachUsageAuditSubscriber(bus, new DispatchEventBus(), makeAuditor(recorded), "run-001");

    // The awaiting-human kind carries no usage payload and must not reach the
    // auditor — and the listener must not throw (the bus would log that).
    bus.emitAgentStream(makeAwaitingHumanEvent());

    expect(recorded).toHaveLength(0);
  });

  test("US-002 AC1: records one one-shot row for a complete dispatch, mapping tokenUsage and exact cost", () => {
    const recorded: UsageAuditEntry[] = [];
    const dispatchEvents = new DispatchEventBus();
    attachUsageAuditSubscriber(new AgentStreamEventBus(), dispatchEvents, makeAuditor(recorded), "run-1");

    dispatchEvents.emitDispatch(
      makeCompleteEvent({
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 1,
        },
        exactCostUsd: 0.01,
      }),
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      runId: "run-1",
      cadence: "one-shot",
      input: 100,
      output: 20,
      cacheRead: 5,
      cacheWrite: 1,
      costUsd: 0.01,
    });
  });

  test("US-002 AC2: falls back to estimatedCostUsd when exactCostUsd is absent", () => {
    const recorded: UsageAuditEntry[] = [];
    const dispatchEvents = new DispatchEventBus();
    attachUsageAuditSubscriber(new AgentStreamEventBus(), dispatchEvents, makeAuditor(recorded), "run-1");

    dispatchEvents.emitDispatch(
      makeCompleteEvent({
        tokenUsage: { inputTokens: 10, outputTokens: 2 },
        estimatedCostUsd: 0.02,
      }),
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0].costUsd).toBe(0.02);
  });

  test("US-002 AC3: copies attribution fields and sets streamCallId from callId", () => {
    const recorded: UsageAuditEntry[] = [];
    const dispatchEvents = new DispatchEventBus();
    attachUsageAuditSubscriber(new AgentStreamEventBus(), dispatchEvents, makeAuditor(recorded), "run-1");

    dispatchEvents.emitDispatch(
      makeCompleteEvent({
        scopeId: "scope-9",
        sessionName: "nax-abc-feat-US-002-auto",
        storyId: "US-002",
        stage: "acceptance",
        agentName: "codex",
        callId: "call-777",
        tokenUsage: { inputTokens: 1, outputTokens: 1 },
        exactCostUsd: 0.001,
      }),
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      scopeId: "scope-9",
      sessionName: "nax-abc-feat-US-002-auto",
      storyId: "US-002",
      stage: "acceptance",
      agentName: "codex",
      streamCallId: "call-777",
    });
  });

  test("US-002 AC4: sets streamCallId to the literal 'one-shot' when the event has no callId", () => {
    const recorded: UsageAuditEntry[] = [];
    const dispatchEvents = new DispatchEventBus();
    attachUsageAuditSubscriber(new AgentStreamEventBus(), dispatchEvents, makeAuditor(recorded), "run-1");

    dispatchEvents.emitDispatch(
      makeCompleteEvent({
        tokenUsage: { inputTokens: 1, outputTokens: 1 },
        exactCostUsd: 0.001,
      }),
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0].streamCallId).toBe("one-shot");
  });

  test("treats non-finite exactCostUsd as absent, mirroring the cost subscriber", () => {
    const recorded: UsageAuditEntry[] = [];
    const dispatchEvents = new DispatchEventBus();
    attachUsageAuditSubscriber(new AgentStreamEventBus(), dispatchEvents, makeAuditor(recorded), "run-1");

    dispatchEvents.emitDispatch(
      makeCompleteEvent({
        tokenUsage: { inputTokens: 10, outputTokens: 2 },
        exactCostUsd: Number.NaN,
        estimatedCostUsd: 0.02,
      }),
    );
    dispatchEvents.emitDispatch(
      makeCompleteEvent({
        tokenUsage: { inputTokens: 10, outputTokens: 2 },
        exactCostUsd: Number.POSITIVE_INFINITY,
        estimatedCostUsd: 0.03,
      }),
    );

    expect(recorded).toHaveLength(2);
    expect(recorded[0].costUsd).toBe(0.02);
    expect(recorded[1].costUsd).toBe(0.03);
  });

  test("US-002 AC5: a session-turn dispatch event records no usage row", () => {
    const recorded: UsageAuditEntry[] = [];
    const dispatchEvents = new DispatchEventBus();
    attachUsageAuditSubscriber(new AgentStreamEventBus(), dispatchEvents, makeAuditor(recorded), "run-1");

    dispatchEvents.emitDispatch(
      makeSessionTurnEvent({ tokenUsage: { inputTokens: 5, outputTokens: 5 }, estimatedCostUsd: 0.5 }),
    );

    expect(recorded).toHaveLength(0);
  });

  test("US-002 AC6: a complete event with no tokenUsage and cost 0 records no usage row", () => {
    const recorded: UsageAuditEntry[] = [];
    const dispatchEvents = new DispatchEventBus();
    attachUsageAuditSubscriber(new AgentStreamEventBus(), dispatchEvents, makeAuditor(recorded), "run-1");

    dispatchEvents.emitDispatch(makeCompleteEvent({ estimatedCostUsd: 0 }));

    expect(recorded).toHaveLength(0);
  });

  test("US-002 AC7: the returned function detaches both the dispatch and the stream subscription", () => {
    const recorded: UsageAuditEntry[] = [];
    const bus = new AgentStreamEventBus();
    const dispatchEvents = new DispatchEventBus();
    const off = attachUsageAuditSubscriber(bus, dispatchEvents, makeAuditor(recorded), "run-1");

    off();
    dispatchEvents.emitDispatch(
      makeCompleteEvent({ tokenUsage: { inputTokens: 1, outputTokens: 1 }, exactCostUsd: 0.001 }),
    );
    bus.emitAgentStream(makeUsageEvent());

    expect(recorded).toHaveLength(0);
  });
});
