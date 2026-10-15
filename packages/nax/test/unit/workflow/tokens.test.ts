import { describe, expect, test } from "bun:test";
import { addRoleTokens, type MeterEvent, startTokenMeter } from "@/workflow/tokens";

type Listener = (e: MeterEvent) => void;

function source() {
  const listeners: Listener[] = [];
  let off = 0;
  return {
    onDispatch(l: Listener) {
      listeners.push(l);
      return () => {
        off++;
      };
    },
    emit: (e: MeterEvent) => {
      for (const l of listeners) l(e);
    },
    offCount: () => off,
  };
}

describe("startTokenMeter", () => {
  test("totals and per-role buckets; exact cost wins over estimated", () => {
    const s = source();
    const meter = startTokenMeter(s);
    s.emit({
      sessionRole: "wf-implementer",
      exactCostUsd: 0.25,
      estimatedCostUsd: 9,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
    });
    s.emit({ sessionRole: "wf-implementer", estimatedCostUsd: 0.5, tokenUsage: { inputTokens: 20, outputTokens: 7 } });
    s.emit({ sessionRole: "wf-story-review" });
    expect(meter.byRole()).toEqual({
      "wf-implementer": { inputTokens: 30, outputTokens: 12, costUsd: 0.75, calls: 2 },
      "wf-story-review": { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 1 },
    });
    expect(meter.totals()).toEqual({ inputTokens: 30, outputTokens: 12, costUsd: 0.75, calls: 3 });
    meter.stop();
    expect(s.offCount()).toBe(1);
  });

  test("no source -> zero totals, stop is a no-op", () => {
    const meter = startTokenMeter(undefined);
    meter.stop();
    expect(meter.totals()).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });
  });

  test("addRoleTokens merges role by role", () => {
    const one = { inputTokens: 1, outputTokens: 1, costUsd: 1, calls: 1 };
    expect(addRoleTokens({ a: one }, { a: one, b: one })).toEqual({
      a: { inputTokens: 2, outputTokens: 2, costUsd: 2, calls: 2 },
      b: one,
    });
  });
});

// US-005 (nax#2525): cache reads and writes are additive telemetry, emitted only when non-zero.
describe("cache tokens", () => {
  test("AC-1/AC-2: an event's cache reads and writes reach its role entry", () => {
    const s = source();
    const meter = startTokenMeter(s);
    s.emit({
      sessionRole: "advisor",
      tokenUsage: { inputTokens: 4, outputTokens: 10, cacheReadTokens: 54627, cacheWriteTokens: 57056 },
    });
    expect(meter.byRole().advisor?.cacheReadTokens).toBe(54627);
    expect(meter.byRole().advisor?.cacheWriteTokens).toBe(57056);
  });

  test("AC-3: an event without cache fields reports neither cache key", () => {
    const s = source();
    const meter = startTokenMeter(s);
    s.emit({ sessionRole: "advisor", tokenUsage: { inputTokens: 4, outputTokens: 10 } });
    const entry = meter.byRole().advisor;
    expect(entry?.inputTokens).toBe(4);
    expect(entry ?? {}).not.toHaveProperty("cacheReadTokens");
    expect(entry ?? {}).not.toHaveProperty("cacheWriteTokens");
    expect(Object.keys(entry ?? {}).sort()).toEqual(["calls", "costUsd", "inputTokens", "outputTokens"]);
  });

  test("AC-4: addRoleTokens carries a cache read across the merge", () => {
    const merged = addRoleTokens(
      { a: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 } },
      { a: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1, cacheReadTokens: 7 } },
    );
    expect(merged.a?.cacheReadTokens).toBe(7);
    expect(merged.a).not.toHaveProperty("cacheWriteTokens");
  });

  test("zero cache traffic adds no key, and two cache-carrying entries sum", () => {
    const none = addRoleTokens({ a: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 } }, {});
    expect(none.a).not.toHaveProperty("cacheReadTokens");
    const both = addRoleTokens(
      { a: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1, cacheReadTokens: 7 } },
      { a: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1, cacheReadTokens: 3, cacheWriteTokens: 5 } },
    );
    expect(both.a?.cacheReadTokens).toBe(10);
    expect(both.a?.cacheWriteTokens).toBe(5);
  });
});
