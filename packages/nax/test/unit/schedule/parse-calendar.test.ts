/**
 * Impossible calendar components are rejected before JavaScript normalises them
 * (US-002 of review-0b834).
 *
 * `new Date(2027, 1, 29, 2, 0)` silently becomes 2027-03-01T02:00 and
 * `new Date(2027, 3, 31, 2, 0)` becomes 2027-05-01, so `--schedule` accepted a
 * date that does not exist and simply ran later. The gate now reads the leading
 * `YYYY-MM-DDTHH:MM(:SS)?` of the naive and offset forms and rejects a month,
 * day, hour, minute or second outside its range.
 */

import { describe, expect, test } from "bun:test";
import { parseSchedule, resolveScheduleGate } from "@/schedule";

const NOW = new Date(2026, 0, 1, 0, 0, 0);

/** The error for a value the gate must reject, or a failure if it parsed. */
function rejection(input: string): string {
  const result = parseSchedule(input, NOW);
  if (result.ok) throw new Error(`expected "${input}" to be rejected, got ${result.target.toISOString()}`);
  return result.error;
}

describe("parseSchedule — a date that does not exist is rejected", () => {
  test("AC-8: 2027-02-29 does not exist and is rejected by name", () => {
    expect(rejection("2027-02-29T02:00")).toBe('Schedule "2027-02-29T02:00" names a date or time that does not exist.');
  });

  test("AC-10: 2027-04-31 does not exist (April has 30 days)", () => {
    expect(rejection("2027-04-31T02:00")).toContain("does not exist");
  });

  test("AC-11: month 13 does not exist", () => {
    expect(rejection("2027-13-01T02:00")).toContain("does not exist");
  });

  test("AC-18: 2100 is not a leap year, so 2100-02-29 does not exist", () => {
    expect(rejection("2100-02-29T02:00")).toContain("does not exist");
  });
});

describe("parseSchedule — a time of day that does not exist is rejected", () => {
  test("AC-12: hour 24 does not exist", () => {
    expect(rejection("2027-03-01T24:00")).toContain("does not exist");
  });

  test("AC-13: minute 60 does not exist", () => {
    expect(rejection("2027-03-01T02:60")).toContain("does not exist");
  });

  test("AC-19: second 60 does not exist (no leap-second notation here)", () => {
    expect(rejection("2027-03-01T02:00:60")).toContain("does not exist");
  });
});

describe("parseSchedule — the offset form is checked before the platform parses it", () => {
  test("AC-14: 2027-02-29T02:00Z does not exist", () => {
    expect(rejection("2027-02-29T02:00Z")).toContain("does not exist");
  });

  test("AC-15 (control): a real offset-form instant keeps its UTC epoch", () => {
    const result = parseSchedule("2027-03-01T02:00Z", NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.target.getTime()).toBe(Date.UTC(2027, 2, 1, 2, 0));
  });

  test("an offset-form value with no leading YYYY-MM-DDTHH:MM is still Unrecognized", () => {
    expect(rejection("bogus-2027-04-31T02:00Z")).toContain("Unrecognized schedule");
  });
});

describe("parseSchedule — real dates and the other shapes are untouched", () => {
  test("AC-9 (control): 2028-02-29 is a real leap day and parses as local time", () => {
    const result = parseSchedule("2028-02-29T02:00", NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect([result.target.getMonth(), result.target.getDate(), result.target.getHours()]).toEqual([1, 29, 2]);
  });

  test("AC-17 (control): a bare date still takes the Date-only rejection", () => {
    expect(rejection("2027-02-29")).toContain("Date-only");
  });

  test("AC-16: resolveScheduleGate rejects the same impossible date", () => {
    const gate = resolveScheduleGate("2027-02-29T02:00", NOW);

    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("expected the gate to reject");
    expect(gate.error).toContain("does not exist");
  });
});
