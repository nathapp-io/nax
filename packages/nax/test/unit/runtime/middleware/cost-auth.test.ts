/**
 * US-006 — `attachCostSubscriber` records the credential identity that paid for
 * a successful row, and the row schema version moves to 8.
 *
 * `auth` reaches a row only through a successful dispatch event: error rows and
 * partial rows are explicitly out of scope (a failed call's credential is not
 * attributable, and a partial row is a still-unrecorded turn), so their schema
 * version bumps without gaining an `auth` key.
 *
 * Acceptance criteria covered: AC9, AC10, AC15, AC16, AC17, AC18.
 */

import { describe, expect, test } from "bun:test";
import type { AuthStamp } from "@/agents/session-types";
import type { CostErrorEvent, CostEvent, ICostAggregator } from "@/runtime/cost-aggregator";
import { createNoOpCostAggregator } from "@/runtime/cost-aggregator";
import type { CompleteDispatchEvent, DispatchErrorEvent, SessionTurnDispatchEvent } from "@/runtime/dispatch-events";
import { DispatchEventBus } from "@/runtime/dispatch-events";
import { attachCostSubscriber, COST_ROW_SCHEMA_VERSION } from "@/runtime/middleware/cost";

const PERMS = { mode: "approve-reads" as const, bashApproval: "raw" as const };

const STAMP: AuthStamp = { fingerprint: "0123456789ab", source: "file" };

function makeSessionTurnEvent(overrides: Partial<SessionTurnDispatchEvent> = {}): SessionTurnDispatchEvent {
  return {
    kind: "session-turn",
    sessionName: "nax-us006-feat-s1-main",
    sessionRole: "main",
    prompt: "hello",
    response: "world",
    agentName: "native",
    stage: "run",
    storyId: "US-006",
    resolvedPermissions: PERMS,
    roundTrips: 1,
    roundTripUnit: "model-call",
    protocolIds: { sessionId: "sess-1" },
    origin: "runAsSession",
    durationMs: 200,
    timestamp: 1_000,
    tokenUsage: { inputTokens: 100, outputTokens: 50 },
    exactCostUsd: 0.006,
    ...overrides,
  };
}

function makeCompleteEvent(overrides: Partial<CompleteDispatchEvent> = {}): CompleteDispatchEvent {
  return {
    kind: "complete",
    sessionName: "nax-us006-feat-s1-plan",
    sessionRole: "plan",
    prompt: "plan this",
    response: "planned",
    agentName: "native",
    stage: "plan",
    storyId: "US-006",
    resolvedPermissions: PERMS,
    durationMs: 80,
    timestamp: 2_000,
    tokenUsage: { inputTokens: 100, outputTokens: 50 },
    exactCostUsd: 0.003,
    ...overrides,
  };
}

function makeErrorEvent(overrides: Partial<DispatchErrorEvent> = {}): DispatchErrorEvent {
  return {
    kind: "error",
    origin: "runAsSession",
    agentName: "native",
    stage: "run",
    storyId: "US-006",
    errorCode: "SESSION_ERROR",
    errorMessage: "failed",
    durationMs: 50,
    timestamp: 3_000,
    resolvedPermissions: PERMS,
    ...overrides,
  };
}

/** Recording aggregator — captures both record and recordError calls. */
function makeRecordingAggregator(): ICostAggregator & {
  recordedCost: CostEvent[];
  recordedErrors: CostErrorEvent[];
} {
  const noop = createNoOpCostAggregator();
  const recordedCost: CostEvent[] = [];
  const recordedErrors: CostErrorEvent[] = [];
  return {
    ...noop,
    recordedCost,
    recordedErrors,
    record: (e: CostEvent) => recordedCost.push(e),
    recordError: (e: CostErrorEvent) => recordedErrors.push(e),
  };
}

describe("attachCostSubscriber — auth on successful rows (US-006)", () => {
  // AC9 (success): the identity stamped on the dispatch event is what the row
  // records. Asserting equality with the EVENT's auth (rather than a literal)
  // pins the copy, which is the subscriber's whole job here.
  test("AC9: a CostEvent recorded for a CompleteDispatchEvent carrying auth has that auth", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");
    const event = makeCompleteEvent({ auth: STAMP });

    bus.emitDispatch(event);

    expect(agg.recordedCost).toHaveLength(1);
    expect(agg.recordedCost[0].auth).toEqual(event.auth);
  });

  // AC10 (boundary): a session-turn dispatch with no stamp — every ACP turn —
  // records a row with no `auth` key at all. `in` rather than `toBeUndefined()`
  // so writing `auth: undefined` does not satisfy it.
  test("AC10: a CostEvent recorded for a SessionTurnDispatchEvent with no auth has no auth key", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent());

    expect(agg.recordedCost).toHaveLength(1);
    expect("auth" in agg.recordedCost[0]).toBe(false);
  });
});

describe("attachCostSubscriber — row schema version 8 (US-006)", () => {
  // AC15 (success): the constant itself.
  test("AC15: COST_ROW_SCHEMA_VERSION is 8", () => {
    expect(COST_ROW_SCHEMA_VERSION).toBe(8);
  });

  // AC16 (success): a row that gained the `auth` field is stamped with the
  // version that documents it, so a reader can tell an auth-carrying row from a
  // v7 one whose absence means "not recorded".
  test("AC16: a CostEvent recorded from a dispatch event carrying auth has schemaVersion 8", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ auth: STAMP }));

    expect(agg.recordedCost).toHaveLength(1);
    expect(agg.recordedCost[0].schemaVersion).toBe(8);
  });

  // AC17 (success): error rows are stamped from the same constant, so they move
  // to 8 with it even though they carry no auth.
  test("AC17: a cost error row recorded from a DispatchErrorEvent has schemaVersion 8", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatchError(makeErrorEvent());

    expect(agg.recordedErrors).toHaveLength(1);
    expect(agg.recordedErrors[0].schemaVersion).toBe(8);
  });

  // AC18 (boundary): a failed dispatch's credential is not attributable — the
  // error carrier has no `auth` slot and the row must not gain one.
  test("AC18: a cost error row recorded from a DispatchErrorEvent has no auth key", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatchError(makeErrorEvent());

    expect(agg.recordedErrors).toHaveLength(1);
    expect("auth" in agg.recordedErrors[0]).toBe(false);
  });
});
