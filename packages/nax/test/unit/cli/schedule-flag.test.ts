import { describe, expect, test } from "bun:test";
import { resolveScheduleGate } from "@/schedule";

const NOW = new Date("2026-07-01T12:00:00");

describe("resolveScheduleGate", () => {
  test("undefined schedule → run immediately, no target", () => {
    const r = resolveScheduleGate(undefined, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toBeNull();
  });

  test("valid relative schedule → target set", () => {
    const r = resolveScheduleGate("30m", NOW);
    expect(r.ok).toBe(true);
    if (r.ok && r.target) expect(r.target.getTime()).toBe(NOW.getTime() + 30 * 60_000);
  });

  test("invalid schedule → error", () => {
    const r = resolveScheduleGate("nonsense", NOW);
    expect(r.ok).toBe(false);
  });

  test("past absolute → error", () => {
    const r = resolveScheduleGate("2026-06-01T00:00", NOW);
    expect(r.ok).toBe(false);
  });
});
