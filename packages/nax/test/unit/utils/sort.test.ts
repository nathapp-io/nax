import { describe, expect, test } from "bun:test";
import { byCodePoint, byNumber } from "@/utils/sort";

describe("byCodePoint", () => {
  test("orders strings identically to a bare .sort()", () => {
    const input = ["b.md", "A.md", "a.md", "10.md", "2.md", "_.md", "É.md", "e.md"];
    expect([...input].sort(byCodePoint)).toEqual([...input].sort());
  });

  test("returns 0 for equal strings", () => {
    expect(byCodePoint("a", "a")).toBe(0);
  });

  test("is not locale-aware — uppercase sorts before lowercase", () => {
    expect(["a", "B"].sort(byCodePoint)).toEqual(["B", "a"]);
  });
});

describe("byNumber", () => {
  test("orders numbers numerically, unlike a bare .sort()", () => {
    const input = [10, 2, 33, 1];
    expect([...input].sort(byNumber)).toEqual([1, 2, 10, 33]);
    expect([...input].sort()).toEqual([1, 10, 2, 33]);
  });

  test("handles negatives", () => {
    expect([3, -1, 0, -20].sort(byNumber)).toEqual([-20, -1, 0, 3]);
  });
});
