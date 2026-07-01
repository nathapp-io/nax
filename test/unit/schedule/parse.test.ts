import { describe, expect, test } from "bun:test";
import { parseSchedule } from "@/schedule";

const NOW = new Date("2026-07-01T12:00:00"); // local

describe("parseSchedule — relative durations", () => {
  test.each([
    ["30m", 30 * 60_000],
    ["2h", 2 * 3_600_000],
    ["90s", 90_000],
    ["1h30m", 90 * 60_000],
    ["1d", 86_400_000],
  ])("%s → now + %d ms", (input, deltaMs) => {
    const r = parseSchedule(input as string, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target.getTime()).toBe(NOW.getTime() + (deltaMs as number));
  });

  test.each(["0s", "5x", "m30", "1h30", "-5m", ""])("rejects %p", (input) => {
    const r = parseSchedule(input as string, NOW);
    expect(r.ok).toBe(false);
  });
});
