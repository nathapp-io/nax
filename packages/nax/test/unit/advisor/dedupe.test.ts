import { describe, expect, test } from "bun:test";
import { dedupeKeyFor } from "@/advisor";

describe("dedupeKeyFor", () => {
  test("phase + title + first file path (line number dropped)", () => {
    expect(dedupeKeyFor("quality", { title: "Race", problem: "In src/a/b.ts:42 the lock…" })).toBe(
      "quality|Race|src/a/b.ts",
    );
  });
  test("rewording the problem keeps the key when title and file match (Review Focus 5)", () => {
    const a = dedupeKeyFor("spec", { title: "T", problem: "x.py:1 does A" });
    const b = dedupeKeyFor("spec", { title: "T", problem: "Look again: x.py:9 still does A, differently worded" });
    expect(a).toBe(b);
  });
  test("no path → empty path segment", () => {
    expect(dedupeKeyFor("spec", { title: "T", problem: "no file here" })).toBe("spec|T|");
  });
});
