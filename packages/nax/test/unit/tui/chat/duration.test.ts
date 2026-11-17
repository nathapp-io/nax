/**
 * US-002: the one duration format the chat states a span in — `42s` under a minute,
 * `20m 05s` under an hour, then `1h 06m 19s`. Every unit after the first is two digits, so
 * the seconds and minutes columns keep their width while the span grows.
 */
import { describe, expect, test } from "bun:test";
import { formatDuration } from "@/tui/chat/duration";

describe("formatDuration", () => {
  test.each([
    { ac: "AC-1", ms: 0, expected: "0s" },
    { ac: "AC-2", ms: 59_999, expected: "59s" },
    { ac: "AC-3", ms: 60_000, expected: "1m 00s" },
    { ac: "AC-4", ms: 1_255_000, expected: "20m 55s" },
    { ac: "AC-5", ms: 3_599_999, expected: "59m 59s" },
    { ac: "AC-6", ms: 3_600_000, expected: "1h 00m 00s" },
    { ac: "AC-7", ms: 6_379_000, expected: "1h 46m 19s" },
    { ac: "AC-8", ms: 90_000_000, expected: "25h 00m 00s" },
  ])("US-002 $ac formats $ms ms as $expected", ({ ms, expected }) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  test("US-002 AC-9 states a negative span as no time", () => {
    expect(formatDuration(-5)).toBe("0s");
  });

  test("US-002 AC-10 states a non-finite span as no time", () => {
    expect(formatDuration(Number.NaN)).toBe("0s");
  });

  test("floors a part-second span to whole seconds, so no step rounds up early", () => {
    expect(formatDuration(1_999)).toBe("1s");
    expect(formatDuration(59_000)).toBe("59s");
    expect(formatDuration(3_599_000)).toBe("59m 59s");
  });
});
