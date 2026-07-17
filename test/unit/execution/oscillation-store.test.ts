import { describe, expect, test } from "bun:test";
import { getOscillations, recordOscillations } from "@/execution";

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
