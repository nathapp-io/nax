/**
 * US-003 (Persist rate provenance on cost rows) — rates / catalogVersion /
 * schemaVersion propagation from the dispatch event onto the recorded cost
 * row.
 *
 * Covers acceptance criteria 1-8, 10-12:
 *
 *   - AC1: every successful dispatch records `schemaVersion: 6` (bumped from 4).
 *   - AC2: a session-turn event carrying `rates` copies them onto the row.
 *   - AC3: a session-turn event carrying BOTH `rates` and a wire-exact cost
 *     records `pricingSource: "wire"` and still carries `rates` — the wire
 *     branch discards the producer's source but `rates` survives.
 *   - AC4: a session-turn event without `rates` records a row that OMITS
 *     `rates` (not undefined, not present).
 *   - AC5: a dispatch event whose producer `pricingSource: "catalog-rates"`
 *     records `catalogVersion: NAX_AI_VERSION` on the row.
 *   - AC6: a dispatch event whose producer `pricingSource: "config-override"`
 *     records NO `catalogVersion`.
 *   - AC7: a dispatch event whose producer `pricingSource: "fallback-rates"`
 *     records NO `catalogVersion`.
 *   - AC8: a catalog-rates dispatch with a wire-exact cost still records
 *     `catalogVersion: NAX_AI_VERSION` — the catalog stamp is independent of
 *     the row's final `pricingSource`.
 *   - AC10: a DispatchErrorEvent records an error row that carries NEITHER
 *     `rates` NOR `catalogVersion`.
 *   - AC11: a session-turn event with no `tokenUsage` records a row with
 *     `usageMissing: true` AND no `rates`.
 *   - AC12: a successful catalog-rates dispatch records `catalogVersion`
 *     omitted (not empty, not placeholder) when NAX_AI_VERSION is unreadable.
 *
 * Each test name uses `AC<number>` so the implementing session can grep them
 * directly.
 */

import { describe, expect, test } from "bun:test";
import type { CostErrorEvent, CostEvent, ICostAggregator } from "@/runtime/cost-aggregator";
import { createNoOpCostAggregator } from "@/runtime/cost-aggregator";
import type { CompleteDispatchEvent, DispatchErrorEvent, SessionTurnDispatchEvent } from "@/runtime/dispatch-events";
import { DispatchEventBus } from "@/runtime/dispatch-events";
import { _costSubscriberDeps, attachCostSubscriber, COST_ROW_SCHEMA_VERSION } from "@/runtime/middleware/cost";
import { NAX_AI_VERSION } from "@/version";

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

const RATES_4 = { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 3, cacheCreationPer1M: 3 };

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

// ─── AC1: schemaVersion bumps from 4 to 6 ──────────────────────────────────

describe("attachCostSubscriber — schemaVersion 6 (US-003 AC1)", () => {
  test("AC1: a successful dispatch records schemaVersion 6", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent());

    expect(agg.recordedCost).toHaveLength(1);
    expect(agg.recordedCost[0].schemaVersion).toBe(6);
    expect(COST_ROW_SCHEMA_VERSION).toBe(6);
  });

  test("AC1: complete events also record schemaVersion 6", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    // A complete event with token usage + exact cost forces a recorded row.
    bus.emitDispatch(makeCompleteEvent({ tokenUsage: { inputTokens: 100, outputTokens: 50 }, exactCostUsd: 0.003 }));

    expect(agg.recordedCost).toHaveLength(1);
    expect(agg.recordedCost[0].schemaVersion).toBe(6);
  });
});

// ─── AC2: rates carried from event to row ───────────────────────────────────

describe("attachCostSubscriber — rates on row (US-003 AC2)", () => {
  test("AC2: a session-turn event carrying rates records a row with the same four field values", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(
      makeSessionTurnEvent({
        exactCostUsd: undefined,
        estimatedCostUsd: 0.018,
        pricingSource: "catalog-rates",
        rates: RATES_4,
      }),
    );

    expect(agg.recordedCost).toHaveLength(1);
    const row = agg.recordedCost[0];
    expect(row.rates).toEqual(RATES_4);
  });

  test("AC2: complete event carrying rates records them on the row", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(
      makeCompleteEvent({
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        exactCostUsd: 0.003,
        rates: RATES_4,
      }),
    );

    expect(agg.recordedCost).toHaveLength(1);
    expect(agg.recordedCost[0].rates).toEqual(RATES_4);
  });
});

// ─── AC3: wire-exact cost wins but rates survive ────────────────────────────

describe("attachCostSubscriber — wire wins, rates survive (US-003 AC3)", () => {
  test("AC3: a dispatch event with rates AND a wire-exact cost records pricingSource: wire and still carries rates", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    // Producer reported catalog-rates; the wire branch discards that label,
    // but rates still describes estimatedCostUsd, so the row carries them.
    bus.emitDispatch(
      makeSessionTurnEvent({
        exactCostUsd: 0.012,
        pricingSource: "catalog-rates",
        rates: RATES_4,
      }),
    );

    expect(agg.recordedCost).toHaveLength(1);
    const row = agg.recordedCost[0];
    expect(row.pricingSource).toBe("wire");
    expect(row.rates).toEqual(RATES_4);
  });
});

// ─── AC4: no rates → no rates field on the row ──────────────────────────────

describe("attachCostSubscriber — no rates field when absent (US-003 AC4)", () => {
  test("AC4: a session-turn event without rates records a row that OMITS the rates field", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ rates: undefined }));

    expect(agg.recordedCost).toHaveLength(1);
    const row = agg.recordedCost[0];
    expect("rates" in row).toBe(false);
  });

  test("AC4: a complete event without rates also omits the field", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(
      makeCompleteEvent({
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        exactCostUsd: 0.003,
        rates: undefined,
      }),
    );

    expect(agg.recordedCost).toHaveLength(1);
    const row = agg.recordedCost[0];
    expect("rates" in row).toBe(false);
  });
});

// ─── AC5/AC6/AC7: catalogVersion is stamped only for catalog-rates ─────────

describe("attachCostSubscriber — catalogVersion stamping (US-003 AC5/AC6/AC7)", () => {
  test("AC5: a catalog-rates event records catalogVersion equal to NAX_AI_VERSION", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(
      makeSessionTurnEvent({
        exactCostUsd: undefined,
        estimatedCostUsd: 0.018,
        pricingSource: "catalog-rates",
        rates: RATES_4,
      }),
    );

    expect(agg.recordedCost).toHaveLength(1);
    expect(agg.recordedCost[0].catalogVersion).toBe(NAX_AI_VERSION);
  });

  test("AC6: a config-override event records NO catalogVersion", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(
      makeSessionTurnEvent({
        exactCostUsd: undefined,
        estimatedCostUsd: 0.018,
        pricingSource: "config-override",
        rates: RATES_4,
      }),
    );

    expect(agg.recordedCost).toHaveLength(1);
    expect("catalogVersion" in agg.recordedCost[0]).toBe(false);
  });

  test("AC7: a fallback-rates event records NO catalogVersion", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    // Producer stamps fallback-rates (the model-derived label when no card
    // resolved). It still carries rates (the post-selection effective rates)
    // but a config-override or fallback-rates row's rates came from operator
    // config or the generic card, so stamping a catalog version here would
    // assert a false origin.
    bus.emitDispatch(
      makeSessionTurnEvent({
        model: "haiku",
        exactCostUsd: undefined,
        estimatedCostUsd: 0.018,
        pricingSource: "fallback-rates",
        rates: RATES_4,
      }),
    );

    expect(agg.recordedCost).toHaveLength(1);
    expect("catalogVersion" in agg.recordedCost[0]).toBe(false);
  });

  test("AC8: a catalog-rates dispatch with a wire-exact cost still records catalogVersion even though pricingSource reads wire", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(
      makeSessionTurnEvent({
        exactCostUsd: 0.012,
        pricingSource: "catalog-rates",
        rates: RATES_4,
      }),
    );

    expect(agg.recordedCost).toHaveLength(1);
    const row = agg.recordedCost[0];
    expect(row.pricingSource).toBe("wire");
    expect(row.catalogVersion).toBe(NAX_AI_VERSION);
  });

  // The catalogVersion field is documented as "the version of the catalog
  // package those rates came from" — without `rates` present, no catalog
  // origin can be asserted, even if `pricingSource: "catalog-rates"` is
  // stamped unconditionally by the producer (the ACP path stamps
  // `pricingSource` but not `rates` when zero usage skips `priceCall`).
  // A row with `catalogVersion` and no `rates` would be a self-contradicting
  // record.
  test("a catalog-rates dispatch with no rates omits catalogVersion even when NAX_AI_VERSION is defined", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    // A session-turn event with non-zero tokens, an estimatedCostUsd (so
    // the row is recorded) but NO exactCostUsd (so the wire-exact branch
    // doesn't overwrite pricingSource). The ACP producer stamps
    // `pricingSource: rateCard.source` unconditionally but only stamps
    // `rates` when nonzero usage let `priceCall` run — that's the
    // divergent case the guard catches.
    bus.emitDispatch(
      makeSessionTurnEvent({
        exactCostUsd: undefined,
        estimatedCostUsd: 0.018,
        pricingSource: "catalog-rates",
        rates: undefined,
      }),
    );

    expect(agg.recordedCost).toHaveLength(1);
    const row = agg.recordedCost[0];
    expect(row.pricingSource).toBe("catalog-rates");
    // catalogVersion must NOT be present — there are no rates to version.
    expect("catalogVersion" in row).toBe(false);
  });
});

// ─── AC10: error rows carry neither rates nor catalogVersion ───────────────

describe("attachCostSubscriber — error rows (US-003 AC10)", () => {
  test("AC10: an error row carries neither rates nor catalogVersion", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatchError(
      makeErrorEvent({
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        estimatedCostUsd: 0.018,
        pricingSource: "catalog-rates",
        // Even if these leaked in, the error row should not record them.
      }),
    );

    expect(agg.recordedErrors).toHaveLength(1);
    const row = agg.recordedErrors[0];
    expect("rates" in row).toBe(false);
    expect("catalogVersion" in row).toBe(false);
  });
});

// ─── AC11: session-turn with no token usage → usageMissing, no rates ───────

describe("attachCostSubscriber — usageMissing session-turn (US-003 AC11)", () => {
  test("AC11: a session-turn event without token usage records usageMissing: true and no rates field", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(
      makeSessionTurnEvent({
        tokenUsage: undefined,
        exactCostUsd: 0,
        estimatedCostUsd: undefined,
        rates: undefined,
      }),
    );

    expect(agg.recordedCost).toHaveLength(1);
    const row = agg.recordedCost[0];
    expect(row.usageMissing).toBe(true);
    expect("rates" in row).toBe(false);
  });
});

// ─── AC12: catalog pin unreadable → omit catalogVersion ────────────────────

describe("attachCostSubscriber — catalogVersion omitted when pin unreadable (US-003 AC12)", () => {
  test("AC12: a catalog-rates dispatch omits catalogVersion (and never records empty/placeholder) when NAX_AI_VERSION is undefined", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();

    const origGetCatalogVersion = _costSubscriberDeps.getCatalogVersion;
    // Simulate the "catalog pin unreadable at build time" branch (US-003 AC12):
    // the static import of `@nathapp/nax-ai/package.json` failed or returned
    // an empty/non-string version. Under that state, a successful
    // catalog-priced row must omit `catalogVersion` rather than record an
    // empty string or placeholder.
    _costSubscriberDeps.getCatalogVersion = () => undefined;

    try {
      attachCostSubscriber(bus, agg, "r-001");

      bus.emitDispatch(
        makeSessionTurnEvent({
          exactCostUsd: undefined,
          estimatedCostUsd: 0.018,
          pricingSource: "catalog-rates",
          rates: RATES_4,
        }),
      );

      expect(agg.recordedCost).toHaveLength(1);
      const row = agg.recordedCost[0];
      expect(row.pricingSource).toBe("catalog-rates");
      // The field must be absent — never an empty or placeholder string.
      expect("catalogVersion" in row).toBe(false);
      expect((row as { catalogVersion?: unknown }).catalogVersion).toBeUndefined();
    } finally {
      _costSubscriberDeps.getCatalogVersion = origGetCatalogVersion;
    }
  });
});
