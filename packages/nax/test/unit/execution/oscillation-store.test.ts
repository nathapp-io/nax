import { describe, expect, test } from "bun:test";
import { countOscillationOutcomes, getOscillations, recordOscillations } from "@/execution";
import type { Finding, Iteration } from "@/findings";

/** Minimal Finding carrying only what the oscillation counter reads (source). */
function finding(source: Finding["source"], message = source): Finding {
  return { source, severity: "error", category: "test", message } as Finding;
}

/** Build one iteration from before/after source lists. */
function iteration(before: Finding["source"][], after: Finding["source"][]): Iteration {
  return {
    iterationNum: 1,
    findingsBefore: before.map((s) => finding(s)),
    fixesApplied: [],
    findingsAfter: after.map((s) => finding(s)),
    outcome: "partial",
    startedAt: "2026-07-21T00:00:00.000Z",
    finishedAt: "2026-07-21T00:00:01.000Z",
  };
}

describe("oscillation store", () => {
  test("exports callable helpers", () => {
    expect(typeof recordOscillations).toBe("function");
    expect(typeof getOscillations).toBe("function");
  });

  test("returns zero for an unseen story", () => {
    expect(getOscillations(new Map(), "US-9")).toBe(0);
  });

  test("records and returns a story total", () => {
    const store = new Map<string, number>();
    expect(recordOscillations(store, "US-1", 2)).toBe(2);
    expect(getOscillations(store, "US-1")).toBe(2);
  });

  test("accumulates repeated records for one story", () => {
    const store = new Map<string, number>();
    recordOscillations(store, "US-1", 1);
    expect(recordOscillations(store, "US-1", 2)).toBe(3);
  });

  test.each([
    [0, "zero"],
    [-1, "negative"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "infinity"],
    [Number.MAX_SAFE_INTEGER + 1, "unsafe integer"],
  ])("rejects %s %s delta", (delta) => {
    const store = new Map<string, number>();
    expect(() => recordOscillations(store, "US-1", delta)).toThrow();
    expect(store.has("US-1")).toBe(false);
  });

  test("keeps totals isolated by story", () => {
    const store = new Map<string, number>();
    recordOscillations(store, "A", 2);
    recordOscillations(store, "B", 5);
    recordOscillations(store, "A", 1);
    expect(getOscillations(store, "A")).toBe(3);
    expect(getOscillations(store, "B")).toBe(5);
  });
});

describe("countOscillationOutcomes — ping-pong detection (issue #1355)", () => {
  test("empty iteration list counts zero", () => {
    expect(countOscillationOutcomes([])).toBe(0);
  });

  test("forward reveal chain counts zero (no false oscillation)", () => {
    // The US-003 shape: a typecheck seed reveals semantic, then adversarial —
    // each source appears once, none reappears after being resolved.
    const iterations = [
      iteration(["typecheck"], ["semantic-review"]),
      iteration(["semantic-review"], ["semantic-review"]),
      iteration(["semantic-review"], ["adversarial-review"]),
    ];
    expect(countOscillationOutcomes(iterations)).toBe(0);
  });

  test("a source coming back after being resolved counts as one reversal", () => {
    // semantic resolved in iter1, then reappears in iter2's findingsAfter.
    const iterations = [
      iteration(["semantic-review"], ["adversarial-review"]),
      iteration(["adversarial-review"], ["semantic-review"]),
    ];
    expect(countOscillationOutcomes(iterations)).toBe(1);
  });

  test("two full round-trips count two reversals (trips default max=2)", () => {
    // semantic ↔ adversarial ping-pong: A→B→A→B.
    const iterations = [
      iteration(["semantic-review"], ["adversarial-review"]),
      iteration(["adversarial-review"], ["semantic-review"]),
      iteration(["semantic-review"], ["adversarial-review"]),
    ];
    expect(countOscillationOutcomes(iterations)).toBe(2);
  });

  test("monotonic progress within a single source counts zero", () => {
    const iterations = [iteration(["semantic-review"], ["semantic-review"]), iteration(["semantic-review"], [])];
    expect(countOscillationOutcomes(iterations)).toBe(0);
  });

  test("multiple resolved sources reappearing in one iteration each count", () => {
    const iterations = [
      iteration(["lint"], ["semantic-review"]), // lint resolved
      iteration(["semantic-review"], ["typecheck"]), // semantic resolved
      iteration(["typecheck"], ["lint", "semantic-review"]), // both reappear
    ];
    expect(countOscillationOutcomes(iterations)).toBe(2);
  });
});
