import { describe, expect, test } from "bun:test";
import { relativeTime } from "@/tui/chat/relative-time";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const NOW_MS = Date.parse("2026-10-26T10:00:00Z");

function isoAgo(elapsedMs: number): string {
  return new Date(NOW_MS - elapsedMs).toISOString();
}

describe("relativeTime", () => {
  test("AC-9 a timestamp 30 s old reads just now", () => {
    expect(relativeTime(isoAgo(30 * SECOND), NOW_MS)).toBe("just now");
  });

  test("AC-10 a timestamp 5 min old reads 5 min ago", () => {
    expect(relativeTime(isoAgo(5 * MINUTE), NOW_MS)).toBe("5 min ago");
  });

  test("AC-11 a timestamp 3 h old reads 3 h ago", () => {
    expect(relativeTime(isoAgo(3 * HOUR), NOW_MS)).toBe("3 h ago");
  });

  test("AC-12 a timestamp 30 h old reads yesterday", () => {
    expect(relativeTime(isoAgo(30 * HOUR), NOW_MS)).toBe("yesterday");
  });

  test("AC-13 a timestamp older than two days names its UTC month and day", () => {
    expect(relativeTime("2026-10-20T10:00:00Z", NOW_MS)).toBe("Oct 20");
  });

  test("AC-14 a null updatedAt has no relative time", () => {
    expect(relativeTime(null, NOW_MS)).toBe("");
  });

  test("AC-15 an unparsable updatedAt has no relative time", () => {
    expect(relativeTime("not-a-date", NOW_MS)).toBe("");
  });

  test.each([
    ["59 s", 59 * SECOND, "just now"],
    ["60 s", 60 * SECOND, "1 min ago"],
    ["59 min", 59 * MINUTE, "59 min ago"],
    ["60 min", 60 * MINUTE, "1 h ago"],
    ["23 h 59 min", 23 * HOUR + 59 * MINUTE, "23 h ago"],
    ["48 h", 2 * 24 * HOUR, "Oct 24"],
  ] as const)("the %s boundary reads %p", (_label, elapsedMs, expected) => {
    expect(relativeTime(isoAgo(elapsedMs), NOW_MS)).toBe(expected);
  });

  test("a timestamp from the future reads just now rather than a negative count", () => {
    expect(relativeTime(isoAgo(-5 * MINUTE), NOW_MS)).toBe("just now");
  });
});
