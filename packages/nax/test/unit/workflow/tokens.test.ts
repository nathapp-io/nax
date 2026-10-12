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
