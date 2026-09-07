/**
 * US-001 (Cost ledger records existing dispatch attribution) — round-trip /
 * model / usageMissing / schemaVersion propagation.
 *
 * Covers the new in-scope acceptance criteria 1-4, 6-7, 8-13:
 *
 *   - AC1-2: session-turn `roundTrips` / `roundTripUnit` (`"model-call"`) reach the
 *     recorded cost row verbatim.
 *   - AC3: session-turn `roundTripUnit: "agent-run"` is recorded verbatim.
 *   - AC4: a `complete` event records a row that omits both `roundTrips` and
 *     `roundTripUnit` — complete dispatches have neither, so the defaulting
 *     that would mask this must be removed.
 *   - AC6-7: a dispatch error event's `model` is copied onto the recorded
 *     error row, and is omitted (not defaulted to `"unknown"`) when absent.
 *   - AC8-10: a successful session-turn event with no tokenUsage and
 *     exactCostUsd:0 records exactly one cost row, with `usageMissing: true`
 *     and no `tokens` field — a zeroed `tokens` object would re-create the
 *     "failed vs cost zero" ambiguity.
 *   - AC11: a successful session-turn event with token usage omits
 *     `usageMissing`.
 *   - AC12-13: both successful session-turn and dispatch-error rows record
 *     `schemaVersion: 4` (bumped from 3 with the new field set).
 */

import { describe, expect, test } from "bun:test";
import { type CostErrorEvent, type CostEvent, createNoOpCostAggregator } from "@/runtime/cost-aggregator";
import type { CompleteDispatchEvent, DispatchErrorEvent, SessionTurnDispatchEvent } from "@/runtime/dispatch-events";
import { DispatchEventBus } from "@/runtime/dispatch-events";
import { attachCostSubscriber, COST_ROW_SCHEMA_VERSION } from "@/runtime/middleware/cost";

const PERMS = { mode: "approve-reads" as const };

function makeSessionTurnEvent(overrides: Partial<SessionTurnDispatchEvent> = {}): SessionTurnDispatchEvent {
  return {
    kind: "session-turn",
    sessionName: "nax-abc-feat-s1-main",
    sessionRole: "main",
    prompt: "hello",
    response: "world",
    agentName: "claude",
    stage: "run",
    storyId: "s-1",
    resolvedPermissions: PERMS,
    roundTrips: 1,
    roundTripUnit: "agent-run",
    protocolIds: { sessionId: "sess-1" },
    origin: "runAsSession",
    durationMs: 200,
    timestamp: 1000,
    tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheCreationInputTokens: 5 },
    exactCostUsd: 0.006,
    ...overrides,
  };
}

function makeCompleteEvent(overrides: Partial<CompleteDispatchEvent> = {}): CompleteDispatchEvent {
  return {
    kind: "complete",
    sessionName: "nax-abc-feat-s1-plan",
    sessionRole: "plan",
    prompt: "plan this",
    response: "planned",
    agentName: "claude",
    stage: "plan",
    storyId: "s-1",
    resolvedPermissions: PERMS,
    durationMs: 80,
    timestamp: 2000,
    tokenUsage: { inputTokens: 100, outputTokens: 50 },
    exactCostUsd: 0.003,
    ...overrides,
  };
}

function makeErrorEvent(overrides: Partial<DispatchErrorEvent> = {}): DispatchErrorEvent {
  return {
    kind: "error",
    origin: "runAsSession",
    agentName: "claude",
    stage: "run",
    storyId: "s-1",
    errorCode: "SESSION_ERROR",
    errorMessage: "failed",
    durationMs: 50,
    timestamp: 3000,
    resolvedPermissions: PERMS,
    ...overrides,
  };
}

// ─── AC1-3: roundTrips / roundTripUnit copied from session-turn to cost row ─

describe("attachCostSubscriber — roundTrips / roundTripUnit (AC1-3)", () => {
  test("AC1: a session-turn event with roundTrips: 7 records a cost row whose roundTrips is 7", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ roundTrips: 7, roundTripUnit: "model-call" }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].roundTrips).toBe(7);
  });

  test("AC2: a session-turn event with roundTripUnit: 'model-call' records a cost row whose roundTripUnit is 'model-call'", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ roundTrips: 7, roundTripUnit: "model-call" }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].roundTripUnit).toBe("model-call");
  });

  test("AC3: a session-turn event with roundTripUnit: 'agent-run' records a cost row whose roundTripUnit is 'agent-run'", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ roundTrips: 3, roundTripUnit: "agent-run" }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].roundTripUnit).toBe("agent-run");
  });
});

// ─── AC4: complete events omit both fields, rather than defaulting to 1 ─────

describe("attachCostSubscriber — complete events omit roundTrips/roundTripUnit (AC4)", () => {
  test("AC4: a complete-kind event records a cost row that omits both roundTrips and roundTripUnit (no defaulting to 1)", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    // Use a complete event with token usage + exact cost so the row is recorded
    // (the skip condition only fires when both are absent — separate test).
    bus.emitDispatch(makeCompleteEvent({ exactCostUsd: 0.01 }));

    expect(recorded).toHaveLength(1);
    expect("roundTrips" in recorded[0]).toBe(false);
    expect("roundTripUnit" in recorded[0]).toBe(false);
  });
});

// ─── AC6-7: error model propagation ─────────────────────────────────────────

describe("attachCostSubscriber — DispatchErrorEvent.model (AC6-7)", () => {
  test("AC6: a dispatch error event with model: 'anthropic/claude-sonnet-5' records an error row whose model is 'anthropic/claude-sonnet-5'", () => {
    const errors: CostErrorEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), recordError: (e: CostErrorEvent) => errors.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatchError(makeErrorEvent({ model: "anthropic/claude-sonnet-5" }));

    expect(errors).toHaveLength(1);
    expect(errors[0].model).toBe("anthropic/claude-sonnet-5");
  });

  test("AC7: a dispatch error event without a model records an error row that omits model (not the string 'unknown')", () => {
    const errors: CostErrorEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), recordError: (e: CostErrorEvent) => errors.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatchError(makeErrorEvent({ model: undefined }));

    expect(errors).toHaveLength(1);
    expect("model" in errors[0]).toBe(false);
    expect(errors[0].model).toBeUndefined();
  });
});

// ─── AC8-10: usage-less session-turn still records a row ────────────────────

describe("attachCostSubscriber — usage-less session-turn still records a row (AC8-10)", () => {
  test("AC8: a session-turn event with undefined tokenUsage and exactCostUsd: 0 records exactly one cost row", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    // The skip condition the old behaviour relied on (no tokenUsage AND no
    // exactCostUsd) is no longer enough to suppress a session-turn event —
    // the cost row carries usageMissing: true instead, so the loop length
    // signal is preserved even when token accounting is absent.
    bus.emitDispatch(makeSessionTurnEvent({ tokenUsage: undefined, exactCostUsd: 0, estimatedCostUsd: undefined }));

    expect(recorded).toHaveLength(1);
  });

  test("AC9: that usage-less session-turn records a cost row whose usageMissing is true", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ tokenUsage: undefined, exactCostUsd: 0, estimatedCostUsd: undefined }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].usageMissing).toBe(true);
  });

  test("AC10: that usage-less session-turn records a cost row with no tokens field (not an object of zeros)", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ tokenUsage: undefined, exactCostUsd: 0, estimatedCostUsd: undefined }));

    expect(recorded).toHaveLength(1);
    // A zeroed tokens object would re-create the "failed vs cost zero" ambiguity
    // that the kind:"error" discriminator was added for (#1433). When usage is
    // genuinely absent, the field is omitted entirely.
    expect("tokens" in recorded[0]).toBe(false);
    expect(recorded[0].tokens).toBeUndefined();
  });
});

// ─── AC11: a row with token usage omits usageMissing ─────────────────────────

describe("attachCostSubscriber — session-turn with token usage omits usageMissing (AC11)", () => {
  test("AC11: a session-turn event carrying token usage records a cost row that omits usageMissing", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    // The default fixture carries tokenUsage + exactCostUsd; usageMissing
    // must not appear on a row that has real token accounting.
    bus.emitDispatch(makeSessionTurnEvent());

    expect(recorded).toHaveLength(1);
    expect("usageMissing" in recorded[0]).toBe(false);
    expect(recorded[0].usageMissing).toBeUndefined();
  });
});

// ─── AC12-13: schemaVersion 4 for both event kinds ──────────────────────────

describe("attachCostSubscriber — schemaVersion 4 for session-turn and error rows (AC12-13)", () => {
  test("AC12: a session-turn event records a cost row with schemaVersion 4", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent());

    expect(recorded).toHaveLength(1);
    expect(recorded[0].schemaVersion).toBe(4);
    expect(COST_ROW_SCHEMA_VERSION).toBe(4);
  });

  test("AC13: a dispatch error event records an error row with schemaVersion 4", () => {
    const errors: CostErrorEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), recordError: (e: CostErrorEvent) => errors.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatchError(makeErrorEvent());

    expect(errors).toHaveLength(1);
    expect(errors[0].schemaVersion).toBe(4);
  });
});
