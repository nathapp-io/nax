/**
 * US-001 (Failed dispatches record spent usage) — failed-spend aggregation.
 *
 * Covers acceptance criteria 12 and 13 (CostAggregator.snapshot exposes a
 * `totalErrorCostUsd` that sums recorded error-row `costUsd`, and a single
 * `recorded` error row persists with its `tokens` / `costUsd` field
 * alongside `errorCode` after `drain()`).
 *
 * Companion tests for the dispatcher / cost-middleware side live in:
 *   - test/unit/agents/manager-dispatch-error-event.test.ts (AC1-7, AC14)
 *   - test/unit/runtime/middleware/cost-dispatch-error.test.ts (AC8-11)
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { _costAggDeps, CostAggregator, type CostErrorEvent, type CostEvent } from "@/runtime/cost-aggregator";

function makeCostEvent(overrides: Partial<CostEvent> = {}): CostEvent {
  return {
    ts: Date.now(),
    runId: "r-001",
    agentName: "claude",
    model: "claude-sonnet-4-6",
    tokens: { input: 100, output: 50 },
    estimatedCostUsd: 0.001,
    exactCostUsd: 0.001,
    costUsd: 0.001,
    confidence: "estimated",
    durationMs: 500,
    ...overrides,
  };
}

function makeErrorEvent(overrides: Partial<CostErrorEvent> = {}): CostErrorEvent {
  return {
    kind: "error",
    ts: Date.now(),
    runId: "r-001",
    agentName: "claude",
    errorCode: "SESSION_ERROR",
    durationMs: 50,
    ...overrides,
  };
}

// AC12: snapshot().totalErrorCostUsd = sum(error.costUsd); totalCostUsd unchanged

describe("CostAggregator.snapshot — failed-spend total (AC12)", () => {
  test("AC12 (success): totalErrorCostUsd equals the summed costUsd of recorded error events", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.recordError(makeErrorEvent({ costUsd: 0.01 }));
    agg.recordError(makeErrorEvent({ costUsd: 0.02 }));
    agg.recordError(makeErrorEvent({ costUsd: 0.005 }));

    const snap = agg.snapshot();
    expect(snap.totalErrorCostUsd).toBeCloseTo(0.035);
    expect(snap.errorCount).toBe(3);
  });

  test("AC12 (boundary): totalCostUsd on snapshot is unaffected by recorded error events", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");

    // One successful cost event worth 0.5 USD.
    agg.record(makeCostEvent({ costUsd: 0.5, tokens: { input: 100, output: 50 } }));

    // Two failed dispatches worth a combined 0.07 USD — successful spend must
    // not silently absorb this; totalCostUsd keeps its successful-spend meaning
    // and the failure is surfaced via totalErrorCostUsd.
    agg.recordError(makeErrorEvent({ costUsd: 0.05 }));
    agg.recordError(makeErrorEvent({ costUsd: 0.02 }));

    const snap = agg.snapshot();
    expect(snap.totalCostUsd).toBeCloseTo(0.5);
    expect(snap.totalErrorCostUsd).toBeCloseTo(0.07);
  });

  test("AC12 (boundary): totalErrorCostUsd is 0 when no error events have been recorded", () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    agg.record(makeCostEvent({ costUsd: 0.25, tokens: { input: 100, output: 50 } }));

    const snap = agg.snapshot();
    expect(snap.totalErrorCostUsd).toBe(0);
    expect(snap.totalCostUsd).toBeCloseTo(0.25);
    expect(snap.errorCount).toBe(0);
  });
});

// AC13: drain() persists the error row with its tokens and costUsd alongside errorCode

describe("CostAggregator.drain — failed-spend rows reach the JSONL (AC13)", () => {
  test("AC13: drain() writes the recorded error row with its tokens, costUsd, and errorCode into <runId>.jsonl", async () => {
    await withTempDir(async (dir) => {
      const drainDir = join(dir, "cost");
      let captured = "";
      const origWrite = _costAggDeps.write;
      _costAggDeps.write = async (_p, data) => {
        captured = String(data);
        return 0;
      };

      try {
        const agg = new CostAggregator("r-error", drainDir);
        agg.recordError(
          makeErrorEvent({
            ts: 1000,
            errorCode: "SESSION_ERROR",
            costUsd: 0.0123,
            tokens: { input: 200, output: 80, cacheRead: 7, cacheWrite: 3 },
          }),
        );

        await agg.drain();

        const lines = captured.trim().split("\n");
        expect(lines).toHaveLength(1);
        const row = JSON.parse(lines[0]);
        // The exact invariant AC13 names: the error row carries tokens and
        // costUsd alongside its errorCode. (See AC9 for the no-usage case:
        // when the dispatch carried no tokens, `tokens` stays absent — a
        // zeroed tokens object would re-create the kind:"error" ambiguity.)
        expect(row.errorCode).toBe("SESSION_ERROR");
        expect(row.costUsd).toBe(0.0123);
        expect(row.tokens.input).toBe(200);
        expect(row.tokens.output).toBe(80);
        expect(row.tokens.cacheRead).toBe(7);
        expect(row.tokens.cacheWrite).toBe(3);
      } finally {
        _costAggDeps.write = origWrite;
      }
    });
  });
});
