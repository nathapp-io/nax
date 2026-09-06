/**
 * US-001 (Failed dispatches record spent usage) — CostErrorEvent mapping.
 *
 * Covers acceptance criteria 8-11 (attachCostSubscriber copies
 * tokenUsage / estimatedCostUsd / exactCostUsd / sessionRole / costUsd off a
 * DispatchErrorEvent onto the recorded CostErrorEvent).
 *
 * The test names use `AC8`-`AC11` so the implementing session can grep them
 * directly. Each criterion has a success-path test; AC9 also has a
 * boundary test that pins the "tokens is undefined, not an object of zeros"
 * invariant — the kind-discriminator fix (#1433) hinges on it.
 */

import { describe, expect, test } from "bun:test";
import type { CostErrorEvent, CostEvent, ICostAggregator } from "@/runtime/cost-aggregator";
import { createNoOpCostAggregator } from "@/runtime/cost-aggregator";
import type { DispatchErrorEvent } from "@/runtime/dispatch-events";
import { DispatchEventBus } from "@/runtime/dispatch-events";
import { attachCostSubscriber } from "@/runtime/middleware/cost";

const PERMS = { mode: "approve-reads" as const };

function makeDispatchErrorEvent(overrides: Partial<DispatchErrorEvent> = {}): DispatchErrorEvent {
  return {
    kind: "error",
    origin: "runAsSession",
    agentName: "claude",
    stage: "run",
    storyId: "US-001",
    callId: "call-42",
    scopeId: "scope-eu",
    errorCode: "SESSION_ERROR",
    errorMessage: "queue owner disconnected",
    durationMs: 50,
    timestamp: 3000,
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

// ─── AC8: tokens and sessionRole carried over from DispatchErrorEvent ────────

describe("attachCostSubscriber — DispatchErrorEvent → CostErrorEvent (AC8)", () => {
  test("AC8: records a CostErrorEvent whose tokens.input / tokens.output / estimatedCostUsd / exactCostUsd / sessionRole match the emitted event", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatchError(
      makeDispatchErrorEvent({
        tokenUsage: { inputTokens: 123, outputTokens: 45, cacheReadInputTokens: 7, cacheCreationInputTokens: 3 },
        estimatedCostUsd: 0.005,
        exactCostUsd: 0.007,
        sessionRole: "implementer",
      }),
    );

    expect(agg.recordedErrors).toHaveLength(1);
    const row = agg.recordedErrors[0];
    expect(row.kind).toBe("error");
    expect(row.tokens?.input).toBe(123);
    expect(row.tokens?.output).toBe(45);
    expect(row.tokens?.cacheRead).toBe(7);
    expect(row.tokens?.cacheWrite).toBe(3);
    expect(row.estimatedCostUsd).toBe(0.005);
    expect(row.exactCostUsd).toBe(0.007);
    expect(row.sessionRole).toBe("implementer");
  });
});

// ─── AC9: tokens stays undefined when the dispatch error carried no usage ───

describe("attachCostSubscriber — boundary: tokens undefined, not zeros (AC9)", () => {
  test("AC9: DispatchErrorEvent without tokenUsage records a CostErrorEvent whose tokens is undefined (not an object of zeros)", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    // No tokenUsage, no estimated / exact — the dispatch error did not
    // accumulate any spent usage.
    bus.emitDispatchError(makeDispatchErrorEvent({ tokenUsage: undefined }));

    expect(agg.recordedErrors).toHaveLength(1);
    const row = agg.recordedErrors[0];

    // The invariant the AC names: a zeroed `tokens` object would re-create the
    // "failed vs cost zero" ambiguity the `kind: "error"` discriminator was
    // added for (#1433). The recorded row must leave it undefined.
    expect(row.tokens).toBeUndefined();
    expect("tokens" in row).toBe(false);
  });
});

// ─── AC10-11: CostErrorEvent.costUsd normalisation matches the dispatch path

describe("attachCostSubscriber — CostErrorEvent.costUsd normalisation (AC10-11)", () => {
  test("AC10: a DispatchErrorEvent with exactCostUsd records CostErrorEvent.costUsd equal to exactCostUsd", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatchError(
      makeDispatchErrorEvent({
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        exactCostUsd: 0.0123,
      }),
    );

    expect(agg.recordedErrors).toHaveLength(1);
    const row = agg.recordedErrors[0];
    expect(row.costUsd).toBe(0.0123);
    expect(row.exactCostUsd).toBe(0.0123);
  });

  test("AC11: a DispatchErrorEvent with only estimatedCostUsd records CostErrorEvent.costUsd equal to estimatedCostUsd", () => {
    const agg = makeRecordingAggregator();
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatchError(
      makeDispatchErrorEvent({
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        estimatedCostUsd: 0.0084,
        // exactCostUsd intentionally absent — only the estimate is on the wire.
      }),
    );

    expect(agg.recordedErrors).toHaveLength(1);
    const row = agg.recordedErrors[0];
    expect(row.costUsd).toBe(0.0084);
    expect(row.estimatedCostUsd).toBe(0.0084);
    expect(row.exactCostUsd).toBeUndefined();
  });
});
