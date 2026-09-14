import { describe, expect, test } from "bun:test";
import type { AgentMessageUpdateEvent, AgentUsageUpdateEvent } from "@/runtime/agent-stream-events";
import { AgentStreamEventBus } from "@/runtime/agent-stream-events";
import { attachUsageAuditSubscriber } from "@/runtime/middleware/usage-audit";
import type { IUsageAuditor, UsageAuditEntry } from "@/runtime/usage-auditor";

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
    attachUsageAuditSubscriber(bus, makeAuditor(recorded), "run-001");

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
    attachUsageAuditSubscriber(bus, makeAuditor(recorded), "run-001");

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
    const off = attachUsageAuditSubscriber(bus, makeAuditor(recorded), "run-001");

    bus.emitAgentStream(makeUsageEvent());
    expect(recorded).toHaveLength(1);

    off();
    bus.emitAgentStream(makeUsageEvent({ callId: "call-003" }));
    expect(recorded).toHaveLength(1);
  });
});
