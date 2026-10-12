import { describe, expect, test } from "bun:test";
import { limitLabel } from "@/finish/limit-label";

describe("limitLabel", () => {
  test.each([
    [15_000, "15 s"],
    [1_000, "1 s"],
    [59_000, "59 s"],
    [1_500, "1.5 s"],
    [60_000, "1 min"],
    [900_000, "15 min"],
    [1_200_000, "20 min"],
    [90_000, "90 s"],
    [150_000, "150 s"],
    [100_500, "1.7 min"],
    [3_540_000, "59 min"],
    [3_600_000, "1 h"],
    [10_800_000, "3 h"],
    [5_400_000, "90 min"],
  ])("%d ms renders as %s", (ms, label) => {
    expect(limitLabel(ms)).toBe(label);
  });
});
