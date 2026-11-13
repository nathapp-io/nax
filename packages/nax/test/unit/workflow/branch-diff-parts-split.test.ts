import { describe, expect, test } from "bun:test";
import {
  DIFF_PART_MAX_BYTES,
  DIFF_PART_MAX_LINE_CHARS,
  DIFF_PART_MAX_LINES,
  splitDiffIntoParts,
} from "@/workflow/branch-diff-parts";

const header = (name: string) =>
  `diff --git a/${name} b/${name}\nindex 123..456 100644\n--- a/${name}\n+++ b/${name}\n`;
const section = (name: string, body = "+hello\n") => `${header(name)}@@ -1 +1 @@\n${body}`;
const lines = (text: string) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
const small = section("a.ts") + section("b.ts");

describe("splitDiffIntoParts", () => {
  test("returns no parts for an empty diff (AC-1)", () => {
    expect(splitDiffIntoParts("")).toEqual([]);
  });
  test("keeps two small sections together intact and lists files in order (AC-2–4)", () => {
    expect(splitDiffIntoParts(small)).toEqual([{ text: small, files: ["a.ts", "b.ts"] }]);
  });
  test("packs sections within byte limits and reconstructs the input (AC-5, AC-7)", () => {
    const diff = Array.from({ length: 40 }, (_, i) => section(`${i}.ts`, `+${"x".repeat(999)}\n`.repeat(2))).join("");
    const parts = splitDiffIntoParts(diff);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => Buffer.byteLength(part.text) <= DIFF_PART_MAX_BYTES)).toBe(true);
    expect(parts.map((part) => part.text).join("")).toBe(diff);
  });
  test("packs sections within line limits (AC-6)", () => {
    const diff = Array.from({ length: 40 }, (_, i) => section(`${i}.ts`, "+line\n".repeat(25))).join("");
    const parts = splitDiffIntoParts(diff);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => lines(part.text) <= DIFF_PART_MAX_LINES)).toBe(true);
    expect(parts.map((part) => part.text).join("")).toBe(diff);
  });
  test("splits on hunk boundaries with repeated headers and isolates the next file (AC-8–11)", () => {
    const h = header("large.ts");
    const hunks = Array.from(
      { length: 3 },
      (_, i) => `@@ -${i + 1} +${i + 1} @@\n${`+${"x".repeat(998)}\n`.repeat(15)}`,
    );
    const parts = splitDiffIntoParts(h + hunks.join("") + section("small.ts"));
    const large = parts.slice(0, -1);
    expect(large.length).toBeGreaterThanOrEqual(2);
    expect(large.every((part) => part.text.startsWith(h) && part.files.join() === "large.ts")).toBe(true);
    expect(large.map((part) => part.text.slice(h.length)).join("")).toBe(hunks.join(""));
    expect(parts.at(-1)).toEqual({ text: section("small.ts"), files: ["small.ts"] });
  });
  test("splits one oversized hunk with header and marker on each piece (AC-12–13)", () => {
    const h = header("long.ts");
    const marker = "@@ -1,2000 +1,2000 @@\n";
    const body = Array.from({ length: 2000 }, (_, i) => `+line ${i}\n`).join("");
    const parts = splitDiffIntoParts(h + marker + body);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => lines(part.text) <= DIFF_PART_MAX_LINES && part.text.startsWith(h + marker))).toBe(
      true,
    );
    expect(parts.map((part) => part.text.slice((h + marker).length)).join("")).toBe(body);
  });
  test("wraps long lines including the continuation prefix in the limit (AC-14)", () => {
    const result = splitDiffIntoParts(section("a.ts", `${"x".repeat(5000)}\n`))[0]
      .text.split("\n")
      .slice(5, -1);
    expect(result).toHaveLength(3);
    expect(result.every((line) => line.length <= DIFF_PART_MAX_LINE_CHARS)).toBe(true);
    expect(result.slice(1).every((line) => line.startsWith("\\ continued: "))).toBe(true);
    expect(
      result[0] +
        result
          .slice(1)
          .map((line) => line.slice("\\ continued: ".length))
          .join(""),
    ).toBe("x".repeat(5000));
  });
  test("extracts paths with spaces but not quoted paths (AC-15–16)", () => {
    const quoted = 'diff --git "a/q\\"x.ts" "b/q\\"x.ts"\nold mode 100644\n';
    expect(splitDiffIntoParts(section("dir with space/a.ts") + quoted)[0].files).toEqual(["dir with space/a.ts"]);
  });
  test("counts UTF-8 bytes, preserves surrogate pairs, and deduplicates repeated file names", () => {
    const body = `+${"😀".repeat(2000)}\n`;
    const parts = splitDiffIntoParts(section("a.ts", body) + section("a.ts"));
    expect(parts[0].files).toEqual(["a.ts"]);
    expect(parts[0].text).not.toContain("�");
    expect(parts.every((p) => Buffer.byteLength(p.text) <= DIFF_PART_MAX_BYTES)).toBe(true);
    expect(parts[0].text.replaceAll("\n\\ continued: ", "")).toBe(section("a.ts", body) + section("a.ts"));
  });
  test("splits oversized mode-only sections without losing lines", () => {
    const diff = `diff --git a/a b/a\n${"mode line\n".repeat(1000)}`;
    const parts = splitDiffIntoParts(diff);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => lines(p.text) <= DIFF_PART_MAX_LINES && p.files.join() === "a")).toBe(true);
    expect(parts.map((p) => p.text).join("")).toBe(diff);
  });
  test("exports the specified limits (AC-17)", () => {
    expect({ DIFF_PART_MAX_BYTES, DIFF_PART_MAX_LINES, DIFF_PART_MAX_LINE_CHARS }).toEqual({
      DIFF_PART_MAX_BYTES: 32_000,
      DIFF_PART_MAX_LINES: 900,
      DIFF_PART_MAX_LINE_CHARS: 1_900,
    });
  });
});
