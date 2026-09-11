import { describe, expect, test } from "bun:test";
import { containsShellChain, normalizeCommandSpec } from "@/quality/command-spec";

describe("normalizeCommandSpec", () => {
  test("wraps a string into a single-entry list", () => {
    expect(normalizeCommandSpec("bun run lint")).toEqual(["bun run lint"]);
  });

  test("returns an empty list for undefined", () => {
    expect(normalizeCommandSpec(undefined)).toEqual([]);
  });

  test("returns an empty list for a whitespace-only string", () => {
    expect(normalizeCommandSpec("   ")).toEqual([]);
  });

  test("passes a list through, trimming each entry", () => {
    expect(normalizeCommandSpec([" tsc --noEmit ", "tsc -p tsconfig.test.json"])).toEqual([
      "tsc --noEmit",
      "tsc -p tsconfig.test.json",
    ]);
  });

  test("drops blank entries from a list", () => {
    expect(normalizeCommandSpec(["tsc --noEmit", "  ", ""])).toEqual(["tsc --noEmit"]);
  });

  test("returns an empty list when every list entry is blank", () => {
    expect(normalizeCommandSpec(["  ", ""])).toEqual([]);
  });
});

describe("containsShellChain", () => {
  test("detects && in a string spec", () => {
    expect(containsShellChain("tsc --noEmit && tsc -p tsconfig.test.json")).toBe(true);
  });

  test("detects && in any list entry", () => {
    expect(containsShellChain(["tsc --noEmit", "biome check && echo done"])).toBe(true);
  });

  test("is false for a clean string", () => {
    expect(containsShellChain("bun run lint")).toBe(false);
  });

  test("is false for a clean list", () => {
    expect(containsShellChain(["tsc --noEmit", "tsc -p tsconfig.test.json"])).toBe(false);
  });

  test("is false for undefined", () => {
    expect(containsShellChain(undefined)).toBe(false);
  });
});
