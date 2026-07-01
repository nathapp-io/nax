import { describe, expect, test } from "bun:test";
import { formatRemaining } from "@/schedule";

describe("formatRemaining", () => {
  test.each([
    [0, "00:00:00"],
    [-5_000, "00:00:00"],
    [1_000, "00:00:01"],
    [61_000, "00:01:01"],
    [3_661_000, "01:01:01"],
    [90_061_000, "25:01:01"], // > 24h stays in hours
  ])("%d ms → %s", (ms, expected) => {
    expect(formatRemaining(ms as number)).toBe(expected);
  });
});
