import { describe, expect, test } from "bun:test";
import { dedupeKeyFor } from "@/advisor";

describe("dedupeKeyFor", () => {
  test("phase + title + first file path (line number dropped)", () => {
    expect(dedupeKeyFor("quality", { title: "Race", problem: "In src/a/b.ts:42 the lock…" })).toBe(
      "quality|Race|src/a/b.ts",
    );
  });
  test("rewording the problem keeps the key when title and file match (Review Focus 5)", () => {
    const a = dedupeKeyFor("spec", { title: "T", problem: "src/x.py:1 does A" });
    const b = dedupeKeyFor("spec", { title: "T", problem: "Look again: src/x.py:9 still does A, differently worded" });
    expect(a).toBe(b);
  });
  test("abbreviations and versions are not paths", () => {
    const k = dedupeKeyFor("spec", { title: "T", problem: "e.g. bump to v1.2 later" });
    expect(k.split("|")[2]?.startsWith("#")).toBe(true);
  });

  test("two generic findings with no path never share a key", () => {
    const a = dedupeKeyFor("quality", {
      title: "Missing error handling",
      problem: "the fetch call ignores rejections",
    });
    const b = dedupeKeyFor("quality", { title: "Missing error handling", problem: "the parser swallows a bad row" });
    expect(a).not.toBe(b);
  });

  test("no path: whitespace and case differences keep the key", () => {
    const a = dedupeKeyFor("spec", { title: "T", problem: "The  Parser swallows a row" });
    const b = dedupeKeyFor("spec", { title: "T", problem: "the parser swallows a row" });
    expect(a).toBe(b);
  });
});
