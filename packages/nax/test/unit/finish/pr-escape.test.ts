/**
 * Finish A 7: escaping and capping of reviewer- or user-sourced text in the PR body.
 */
import { describe, expect, test } from "bun:test";
import { capEscaped, escapeInline, escapeTableCell } from "@/finish/pr/escape";

describe("capEscaped", () => {
  test("never splits a surrogate pair", () => {
    expect(capEscaped("😀".repeat(20), 5)).toBe("😀😀…");
  });

  test("never splits an entity", () => {
    expect(escapeTableCell("<".repeat(10), 6)).toBe("&lt;…");
  });

  test("never splits a backslash escape", () => {
    expect(escapeTableCell("|||", 3)).toBe("\\|…");
  });

  test("leaves a string within the cap alone", () => {
    expect(capEscaped("short", 10)).toBe("short");
  });
});

describe("escapeInline", () => {
  test("flattens backticks, tags and newlines, then caps the escaped text", () => {
    expect(escapeInline("a`b<c>\nd")).toBe("a'b&lt;c&gt; d");
    expect(escapeInline("<".repeat(100), 9)).toBe("&lt;&lt;…");
  });
});
