import { describe, expect, test } from "bun:test";
import { matchesDenyPaths } from "#src/tools/deny-paths";

describe("matchesDenyPaths", () => {
  test("undefined and empty denylists deny nothing", () => {
    expect(matchesDenyPaths("secrets.env", undefined)).toBe(false);
    expect(matchesDenyPaths("secrets.env", [])).toBe(false);
  });

  test("an exact literal matches itself and only itself (anchored both ends)", () => {
    expect(matchesDenyPaths("secrets.env", ["secrets.env"])).toBe(true);
    expect(matchesDenyPaths("src/secrets.env", ["secrets.env"])).toBe(false);
    expect(matchesDenyPaths("not-secrets.env", ["secrets.env"])).toBe(false);
  });

  test("* does not span separators, ** does", () => {
    expect(matchesDenyPaths("src/a.ts", ["*.ts"])).toBe(false);
    expect(matchesDenyPaths("a.ts", ["*.ts"])).toBe(true);
    expect(matchesDenyPaths("deep/nested/a.ts", ["**/*.ts"])).toBe(true);
  });

  test("? matches exactly one non-separator character", () => {
    expect(matchesDenyPaths("a.ts", ["?.ts"])).toBe(true);
    expect(matchesDenyPaths("ab.ts", ["?.ts"])).toBe(false);
    expect(matchesDenyPaths("a/b.ts", ["?.ts"])).toBe(false);
  });

  test("glob characters in the pattern are literal, not regex", () => {
    expect(matchesDenyPaths("a.+x", ["a.+x"])).toBe(true);
    expect(matchesDenyPaths("aax", ["a.+x"])).toBe(false);
  });

  test("matching is case-insensitive: .ENV is denied by .env (nax#1972)", () => {
    expect(matchesDenyPaths("src/.ENV", ["**/.env"])).toBe(true);
  });

  test("both sides are NFC-normalized: an NFD path from disk matches an NFC pattern", () => {
    expect(matchesDenyPaths("cafe\u0301.env", ["café.env"])).toBe(true);
  });

  test("a directory subtree needs **: a trailing / alone matches only the literal entry", () => {
    expect(matchesDenyPaths(".nax-wt/US-003/a.ts", [".nax-wt/**"])).toBe(true);
    expect(matchesDenyPaths(".nax-wt", [".nax-wt/**"])).toBe(false);
    expect(matchesDenyPaths("other/a.ts", [".nax-wt/**"])).toBe(false);
  });
});
