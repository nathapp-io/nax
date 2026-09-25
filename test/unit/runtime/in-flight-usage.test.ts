/**
 * US-003 (Track in-flight native spend and define partial cost rows) — the
 * in-flight tracker and the partial-row conversion.
 *
 * A native turn still running at shutdown has no finished dispatch row although
 * its usage beats report spend. These tests pin the accumulator rules that turn
 * those unrecorded beats into `InFlightResidual`s, the reconciliation events
 * that clear an entry, and the schema-v7 partial `CostEvent` they map to.
 */
import { describe, expect, test } from "bun:test";
import {
  type AgentCallEndedEvent,
  type AgentCallStartedEvent,
  AgentStreamEventBus,
  type AgentUsageUpdateEvent,
} from "@/runtime/agent-stream-events";
import { type CostEvent, createNoOpCostAggregator } from "@/runtime/cost-aggregator";
import { type DispatchErrorEvent, DispatchEventBus, type SessionTurnDispatchEvent } from "@/runtime/dispatch-events";
import { attachInFlightUsageTracker, type InFlightResidual, toPartialCostEvent } from "@/runtime/in-flight-usage";
import { attachCostSubscriber, COST_ROW_SCHEMA_VERSION } from "@/runtime/middleware/cost";

const PERMS = { mode: "approve-reads" as const, bashApproval: "raw" as const };

function makeBeat(overrides: Partial<AgentUsageUpdateEvent> = {}): AgentUsageUpdateEvent {
  return {
    kind: "agent.usage_update",
    callId: "c1",
    runId: "run-1",
    agentName: "native",
    sessionName: "n1",
    timestamp: 1_000,
    cadence: "round-trip",
    ...overrides,
  };
}

function makeCallStarted(overrides: Partial<AgentCallStartedEvent> = {}): AgentCallStartedEvent {
  return {
    kind: "agent.call_started",
    callId: "c1",
    runId: "run-1",
    agentName: "native",
    sessionName: "n1",
    timestamp: 1_000,
    model: "m1",
    timeoutSeconds: 300,
    ...overrides,
  };
}

function makeCallEnded(overrides: Partial<AgentCallEndedEvent> = {}): AgentCallEndedEvent {
  return {
    kind: "agent.call_ended",
    callId: "c1",
    runId: "run-1",
    agentName: "native",
    sessionName: "n1",
    timestamp: 1_000,
    status: "cancelled",
    ...overrides,
  };
}

function makeSessionTurn(overrides: Partial<SessionTurnDispatchEvent> = {}): SessionTurnDispatchEvent {
  return {
    kind: "session-turn",
    sessionName: "n1",
    sessionRole: "main",
    prompt: "hello",
    response: "world",
    agentName: "native",
    stage: "run",
    resolvedPermissions: PERMS,
    roundTrips: 1,
    roundTripUnit: "model-call",
    protocolIds: { sessionId: "sess-1" },
    origin: "runAsSession",
    durationMs: 200,
    timestamp: 2_000,
    ...overrides,
  };
}

function makeDispatchError(overrides: Partial<DispatchErrorEvent> = {}): DispatchErrorEvent {
  return {
    kind: "error",
    origin: "runAsSession",
    agentName: "native",
    stage: "run",
    errorCode: "SESSION_ERROR",
    errorMessage: "failed",
    durationMs: 50,
    timestamp: 3_000,
    resolvedPermissions: PERMS,
    ...overrides,
  };
}

function makeResidual(overrides: Partial<InFlightResidual> = {}): InFlightResidual {
  return {
    streamCallId: "c1",
    agentName: "native",
    model: "m1",
    sessionName: "feat-US-001-acceptance-gen",
    tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 2 },
    costUsd: 0.42,
    roundTrips: 3,
    ...overrides,
  };
}

function setup() {
  const stream = new AgentStreamEventBus();
  const dispatch = new DispatchEventBus();
  const { tracker, off } = attachInFlightUsageTracker(stream, dispatch);
  return { stream, dispatch, tracker, off };
}

describe("attachInFlightUsageTracker — accumulation (US-003 AC1-3, AC9, AC15-16)", () => {
  test("AC1: two round-trip beats on c1 accumulate costUsd 0.25 and roundTrips 2", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeBeat({ costUsd: 0.1, roundTrip: 1 }));
    stream.emitAgentStream(makeBeat({ costUsd: 0.15, roundTrip: 2 }));

    const residuals = tracker.residuals();
    expect(residuals).toHaveLength(1);
    expect(residuals[0].streamCallId).toBe("c1");
    expect(residuals[0].costUsd).toBeCloseTo(0.25, 10);
    expect(residuals[0].roundTrips).toBe(2);
  });

  test("AC1 boundary: a beat omitting costUsd contributes 0 to the accumulated cost", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeBeat({ costUsd: 0.2, roundTrip: 1 }));
    stream.emitAgentStream(makeBeat({ roundTrip: 2 }));

    expect(tracker.residuals()).toHaveLength(1);
    expect(tracker.residuals()[0].costUsd).toBeCloseTo(0.2, 10);
  });

  test("AC2: token deltas sum across beats and an absent cacheRead contributes 0", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeBeat({ inputTokens: 10, outputTokens: 2, cacheRead: 5, cacheWrite: 3, roundTrip: 1 }));
    stream.emitAgentStream(makeBeat({ inputTokens: 30, roundTrip: 2 }));

    const residuals = tracker.residuals();
    expect(residuals).toHaveLength(1);
    expect(residuals[0].tokens.input).toBe(40);
    expect(residuals[0].tokens.cacheRead).toBe(5);
    expect(residuals[0].tokens.output).toBe(2);
    expect(residuals[0].tokens.cacheWrite).toBe(3);
  });

  test("AC2 boundary: cache fields absent on every beat leave cacheRead and cacheWrite at 0", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeBeat({ inputTokens: 4, roundTrip: 1 }));
    stream.emitAgentStream(makeBeat({ inputTokens: 6, roundTrip: 2 }));

    const residuals = tracker.residuals();
    expect(residuals).toHaveLength(1);
    expect(residuals[0].tokens.input).toBe(10);
    expect(residuals[0].tokens.cacheRead).toBe(0);
    expect(residuals[0].tokens.cacheWrite).toBe(0);
  });

  test("AC9: only a beat carrying a roundTrip field increments roundTrips", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeBeat({ costUsd: 0.01, roundTrip: 1 }));
    stream.emitAgentStream(makeBeat({ costUsd: 0.01 }));

    const residuals = tracker.residuals();
    expect(residuals).toHaveLength(1);
    expect(residuals[0].roundTrips).toBe(1);
  });

  test("AC9 boundary: beats that never carry roundTrip leave roundTrips at 0", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeBeat({ costUsd: 0.01 }));
    stream.emitAgentStream(makeBeat({ costUsd: 0.01 }));

    const residuals = tracker.residuals();
    expect(residuals).toHaveLength(1);
    expect(residuals[0].roundTrips).toBe(0);
  });

  test("AC15: cadence 'agent' beats add nothing to the tracker", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeBeat({ cadence: "agent", costUsd: 0.5, inputTokens: 100, roundTrip: 1 }));

    expect(tracker.residuals()).toHaveLength(0);
  });

  test("AC15 boundary: a round-trip beat after an ignored 'agent' beat is still tracked", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeBeat({ cadence: "agent", costUsd: 0.5 }));
    stream.emitAgentStream(makeBeat({ costUsd: 0.25, roundTrip: 1 }));

    const residuals = tracker.residuals();
    expect(residuals).toHaveLength(1);
    expect(residuals[0].costUsd).toBeCloseTo(0.25, 10);
  });

  test("AC16: a stream whose only beat has cost 0 and zero tokens is omitted", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(
      makeBeat({ costUsd: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, roundTrip: 1 }),
    );

    expect(tracker.residuals()).toHaveLength(0);
  });

  test("AC16 boundary: a beat with zero cost but nonzero tokens is retained", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeBeat({ costUsd: 0, inputTokens: 5, roundTrip: 1 }));

    const residuals = tracker.residuals();
    expect(residuals).toHaveLength(1);
    expect(residuals[0].tokens.input).toBe(5);
  });
});

describe("attachInFlightUsageTracker — model attribution (US-003 AC3)", () => {
  test("AC3: agent.call_started records its model on the stream's residual", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeCallStarted({ callId: "c1", model: "m1" }));
    stream.emitAgentStream(makeBeat({ callId: "c1", costUsd: 0.1 }));

    expect(tracker.residuals()).toHaveLength(1);
    expect(tracker.residuals()[0].model).toBe("m1");
  });

  test("AC3 boundary: a stream that never saw call_started reports model 'unknown'", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", costUsd: 0.1 }));

    const residuals = tracker.residuals();
    expect(residuals).toHaveLength(1);
    expect(residuals[0].model).toBe("unknown");
  });

  test("AC3 boundary: an empty-string model is stored as 'unknown'", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeCallStarted({ callId: "c1", model: "" }));
    stream.emitAgentStream(makeBeat({ callId: "c1", costUsd: 0.1 }));

    const residuals = tracker.residuals();
    expect(residuals).toHaveLength(1);
    expect(residuals[0].model).toBe("unknown");
  });
});

describe("attachInFlightUsageTracker — call_ended resolution (US-003 AC4-6)", () => {
  test("AC4: agent.call_ended with status 'success' removes the stream's residual", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", costUsd: 0.1, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", status: "success" }));

    expect(tracker.residuals()).toHaveLength(0);
  });

  test("AC4 boundary: a 'success' end for a stream that accumulated nothing creates no residual", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeCallEnded({ callId: "c9", status: "success" }));

    expect(tracker.residuals()).toHaveLength(0);
  });

  test("AC5: agent.call_ended with status 'timeout' removes the stream's residual", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", costUsd: 0.1, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", status: "timeout" }));

    expect(tracker.residuals()).toHaveLength(0);
  });

  test("AC5 boundary: a timeout end removes only the ended stream's residual", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", costUsd: 0.1, roundTrip: 1 }));
    stream.emitAgentStream(makeBeat({ callId: "c2", costUsd: 0.2, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", status: "timeout" }));

    expect(tracker.residuals().map((r) => r.streamCallId)).toEqual(["c2"]);
  });

  test("AC6: agent.call_ended with status 'cancelled' retains the stream's residual", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", costUsd: 0.25, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", status: "cancelled" }));

    const residuals = tracker.residuals();
    expect(residuals).toHaveLength(1);
    expect(residuals[0].streamCallId).toBe("c1");
    expect(residuals[0].costUsd).toBeCloseTo(0.25, 10);
  });

  test("AC6 boundary: a cancelled stream with zero cost and zero tokens is omitted", () => {
    const { stream, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", costUsd: 0, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", status: "cancelled" }));

    expect(tracker.residuals()).toHaveLength(0);
  });
});

describe("attachInFlightUsageTracker — session-turn reconciliation (US-003 AC7-8)", () => {
  test("AC7: a session-turn dispatch clears that session's most recently cancelled stream", () => {
    const { stream, dispatch, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", sessionName: "n1", costUsd: 0.1, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", sessionName: "n1", status: "cancelled" }));
    dispatch.emitDispatch(makeSessionTurn({ sessionName: "n1" }));

    expect(tracker.residuals()).toHaveLength(0);
  });

  test("AC7 boundary: a session-turn for a different session leaves the cancelled stream alone", () => {
    const { stream, dispatch, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", sessionName: "n1", costUsd: 0.1, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", sessionName: "n1", status: "cancelled" }));
    dispatch.emitDispatch(makeSessionTurn({ sessionName: "n2" }));

    expect(tracker.residuals().map((r) => r.streamCallId)).toEqual(["c1"]);
  });

  test("AC8: a session-turn retains an errored stream while clearing a successfully ended one", () => {
    const { stream, dispatch, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", sessionName: "n1", costUsd: 0.1, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", sessionName: "n1", status: "error" }));
    stream.emitAgentStream(makeBeat({ callId: "c2", sessionName: "n1", costUsd: 0.2, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c2", sessionName: "n1", status: "success" }));
    dispatch.emitDispatch(makeSessionTurn({ sessionName: "n1" }));

    expect(tracker.residuals().map((r) => r.streamCallId)).toEqual(["c1"]);
  });

  test("AC8 boundary: a session-turn clears nothing when the session's latest end was an error", () => {
    const { stream, dispatch, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", sessionName: "n1", costUsd: 0.1, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", sessionName: "n1", status: "error" }));
    dispatch.emitDispatch(makeSessionTurn({ sessionName: "n1" }));

    expect(tracker.residuals().map((r) => r.streamCallId)).toEqual(["c1"]);
  });
});

describe("attachInFlightUsageTracker — dispatch-error reconciliation (US-003 AC10-14)", () => {
  test("AC10: a DispatchErrorEvent carrying tokenUsage clears the errored stream in its scope", () => {
    const { stream, dispatch, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", scopeId: "s1", costUsd: 0.1, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", scopeId: "s1", status: "error" }));
    dispatch.emitDispatchError(makeDispatchError({ scopeId: "s1", tokenUsage: { inputTokens: 10, outputTokens: 1 } }));

    expect(tracker.residuals()).toHaveLength(0);
  });

  test("AC10 boundary: a DispatchErrorEvent for a different scope leaves the errored stream alone", () => {
    const { stream, dispatch, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", scopeId: "s1", costUsd: 0.1, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", scopeId: "s1", status: "error" }));
    dispatch.emitDispatchError(makeDispatchError({ scopeId: "s2", tokenUsage: { inputTokens: 10, outputTokens: 1 } }));

    expect(tracker.residuals().map((r) => r.streamCallId)).toEqual(["c1"]);
  });

  test("AC10 boundary: an errored stream with no scopeId is never cleared by an error event", () => {
    const { stream, dispatch, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", costUsd: 0.1, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", status: "error" }));
    dispatch.emitDispatchError(makeDispatchError({ scopeId: "s1", tokenUsage: { inputTokens: 10, outputTokens: 1 } }));

    expect(tracker.residuals().map((r) => r.streamCallId)).toEqual(["c1"]);
  });

  test("AC11: only the most recently ended errored stream in the scope is cleared", () => {
    const { stream, dispatch, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", scopeId: "s1", costUsd: 0.1, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", scopeId: "s1", status: "error" }));
    stream.emitAgentStream(makeBeat({ callId: "c2", scopeId: "s1", costUsd: 0.2, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c2", scopeId: "s1", status: "error" }));
    dispatch.emitDispatchError(makeDispatchError({ scopeId: "s1", tokenUsage: { inputTokens: 10, outputTokens: 1 } }));

    expect(tracker.residuals().map((r) => r.streamCallId)).toEqual(["c1"]);
  });

  test("AC11 boundary: a second error event for the same scope clears the next errored stream", () => {
    const { stream, dispatch, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", scopeId: "s1", costUsd: 0.1, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", scopeId: "s1", status: "error" }));
    stream.emitAgentStream(makeBeat({ callId: "c2", scopeId: "s1", costUsd: 0.2, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c2", scopeId: "s1", status: "error" }));
    dispatch.emitDispatchError(makeDispatchError({ scopeId: "s1", tokenUsage: { inputTokens: 10, outputTokens: 1 } }));
    dispatch.emitDispatchError(makeDispatchError({ scopeId: "s1", tokenUsage: { inputTokens: 10, outputTokens: 1 } }));

    expect(tracker.residuals()).toHaveLength(0);
  });

  test("AC12: an error event matching the scope through its callId clears the errored stream", () => {
    const { stream, dispatch, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", scopeId: "s1", costUsd: 0.1, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", scopeId: "s1", status: "error" }));
    dispatch.emitDispatchError(makeDispatchError({ callId: "s1", exactCostUsd: 0.05 }));

    expect(tracker.residuals()).toHaveLength(0);
  });

  test("AC12 boundary: the same callId match with no usage and no cost clears nothing", () => {
    const { stream, dispatch, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", scopeId: "s1", costUsd: 0.1, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", scopeId: "s1", status: "error" }));
    dispatch.emitDispatchError(makeDispatchError({ callId: "s1", exactCostUsd: 0 }));

    expect(tracker.residuals().map((r) => r.streamCallId)).toEqual(["c1"]);
  });

  test("AC13: an error event with no tokenUsage and zero cost clears nothing", () => {
    const { stream, dispatch, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", scopeId: "s1", costUsd: 0.1, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", scopeId: "s1", status: "error" }));
    dispatch.emitDispatchError(makeDispatchError({ scopeId: "s1", estimatedCostUsd: 0 }));

    expect(tracker.residuals().map((r) => r.streamCallId)).toEqual(["c1"]);
  });

  test("AC13 boundary: an estimated cost above zero is enough to clear the errored stream", () => {
    const { stream, dispatch, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", scopeId: "s1", costUsd: 0.1, roundTrip: 1 }));
    stream.emitAgentStream(makeCallEnded({ callId: "c1", scopeId: "s1", status: "error" }));
    dispatch.emitDispatchError(makeDispatchError({ scopeId: "s1", estimatedCostUsd: 0.02 }));

    expect(tracker.residuals()).toHaveLength(0);
  });

  test("AC14: a DispatchErrorEvent never clears a still-open stream", () => {
    const { stream, dispatch, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", scopeId: "s1", costUsd: 0.1, roundTrip: 1 }));
    dispatch.emitDispatchError(makeDispatchError({ scopeId: "s1", tokenUsage: { inputTokens: 10, outputTokens: 1 } }));

    expect(tracker.residuals().map((r) => r.streamCallId)).toEqual(["c1"]);
  });

  test("AC14 boundary: a still-open stream survives an error event that carries only a cost", () => {
    const { stream, dispatch, tracker } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", scopeId: "s1", costUsd: 0.1, roundTrip: 1 }));
    dispatch.emitDispatchError(makeDispatchError({ scopeId: "s1", exactCostUsd: 0.03 }));

    expect(tracker.residuals().map((r) => r.streamCallId)).toEqual(["c1"]);
  });
});

describe("attachInFlightUsageTracker — detaching (US-003 interface)", () => {
  test("off() detaches both buses so later events are not accumulated", () => {
    const { stream, dispatch, tracker, off } = setup();

    stream.emitAgentStream(makeBeat({ callId: "c1", costUsd: 0.1, roundTrip: 1 }));
    off();
    stream.emitAgentStream(makeBeat({ callId: "c2", costUsd: 5, roundTrip: 1 }));
    dispatch.emitDispatch(makeSessionTurn({ sessionName: "n1" }));

    const residuals = tracker.residuals();
    expect(residuals.map((r) => r.streamCallId)).toEqual(["c1"]);
    expect(residuals[0].costUsd).toBeCloseTo(0.1, 10);
  });
});

describe("toPartialCostEvent (US-003 AC17-18)", () => {
  test("AC17: maps a residual onto a schema-v7 partial cost row", () => {
    const residual = makeResidual();
    const before = Date.now();
    const row = toPartialCostEvent(residual, "run-9", "proj");
    const after = Date.now();

    expect(row.partial).toBe(true);
    expect(row.schemaVersion).toBe(7);
    expect(row.runId).toBe("run-9");
    expect(row.projectKey).toBe("proj");
    expect(row.agentName).toBe("native");
    expect(row.model).toBe("m1");
    expect(row.sessionRole).toBe("acceptance-gen");
    expect(row.callId).toBe("c1");
    expect(row.tokens).toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 2 });
    expect(row.roundTrips).toBe(3);
    expect(row.roundTripUnit).toBe("model-call");
    expect(row.costUsd).toBe(residual.costUsd);
    expect(row.estimatedCostUsd).toBe(residual.costUsd);
    expect(row.exactCostUsd).toBe(residual.costUsd);
    expect(row.confidence).toBe("estimated");
    expect(row.durationMs).toBe(0);
    expect("pricingSource" in row).toBe(false);
    expect(row.ts).toBeGreaterThanOrEqual(before);
    expect(row.ts).toBeLessThanOrEqual(after);
  });

  test("AC17 boundary: storyId, stage and scopeId are carried only when the residual has them", () => {
    const attributed = toPartialCostEvent(makeResidual({ storyId: "s-1", stage: "run", scopeId: "s1" }), "run-9");

    expect(attributed.storyId).toBe("s-1");
    expect(attributed.stage).toBe("run");
    expect(attributed.scopeId).toBe("s1");

    const bare = toPartialCostEvent(makeResidual(), "run-9");
    expect("storyId" in bare).toBe(false);
    expect("stage" in bare).toBe(false);
    expect("scopeId" in bare).toBe(false);
  });

  test("AC18: a sessionName mapping to no known role omits sessionRole", () => {
    const row = toPartialCostEvent(makeResidual({ sessionName: "feat-us-001-something-else" }), "run-9");

    expect("sessionRole" in row).toBe(false);
  });
});

describe("cost-row schema v7 (US-003 AC19)", () => {
  test("AC19: COST_ROW_SCHEMA_VERSION is 7", () => {
    expect(COST_ROW_SCHEMA_VERSION).toBe(7);
  });

  test("AC19: a successful session-turn cost row carries no partial field", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "run-9");

    bus.emitDispatch(
      makeSessionTurn({
        sessionName: "feat-US-003-acceptance-gen",
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
      }),
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0].schemaVersion).toBe(7);
    expect("partial" in recorded[0]).toBe(false);
  });
});
