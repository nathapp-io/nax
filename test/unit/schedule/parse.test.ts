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

describe("parseSchedule — time of day", () => {
  const noon = new Date("2026-07-01T12:00:00");

  test("future time today stays today", () => {
    const r = parseSchedule("17:00", noon);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target.getFullYear()).toBe(2026);
      expect(r.target.getMonth()).toBe(6); // July
      expect(r.target.getDate()).toBe(1);
      expect(r.target.getHours()).toBe(17);
      expect(r.target.getMinutes()).toBe(0);
      expect(r.target.getSeconds()).toBe(0);
    }
  });

  test("past time today rolls to tomorrow", () => {
    const r = parseSchedule("09:30", noon);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target.getDate()).toBe(2); // rolled to July 2
      expect(r.target.getHours()).toBe(9);
      expect(r.target.getMinutes()).toBe(30);
    }
  });

  test.each(["24:00", "12:60", "9:5", "17:0"])("rejects malformed %p", (input) => {
    expect(parseSchedule(input as string, noon).ok).toBe(false);
  });
});
