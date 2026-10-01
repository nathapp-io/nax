/**
 * Pure `git status --porcelain` parser (split out of `src/utils/git.ts`).
 *
 * `src/utils/git.ts` re-exports the same functions and `test/unit/utils/git.test.ts`
 * already covers the parser's mainline behavior end-to-end; this file targets
 * the remaining escape-sequence branches of `unquotePorcelainPath` (a private
 * helper reachable only through the two exported parsers) and the
 * quoted-old-path backslash-skip branch of `splitRenameOldPath`.
 */
import { describe, expect, test } from "bun:test";
import { parsePorcelainForNaxPaths, parsePorcelainUntrackedPaths } from "@/utils/porcelain";

function untracked(quotedPath: string): string[] {
  return parsePorcelainUntrackedPaths(`?? ${quotedPath}`);
}

describe("unquotePorcelainPath — control-character escapes", () => {
  test("decodes \\a (bell)", () => {
    expect(untracked('"pre\\abell"')).toEqual([`pre${String.fromCharCode(0x07)}bell`]);
  });

  test("decodes \\b (backspace)", () => {
    expect(untracked('"pre\\bback"')).toEqual([`pre${String.fromCharCode(0x08)}back`]);
  });

  test("decodes \\t (tab)", () => {
    expect(untracked('"pre\\ttab"')).toEqual([`pre${String.fromCharCode(0x09)}tab`]);
  });

  test("decodes \\n (newline)", () => {
    expect(untracked('"pre\\nline"')).toEqual([`pre${String.fromCharCode(0x0a)}line`]);
  });

  test("decodes \\v (vertical tab)", () => {
    expect(untracked('"pre\\vvert"')).toEqual([`pre${String.fromCharCode(0x0b)}vert`]);
  });

  test("decodes \\f (form feed)", () => {
    expect(untracked('"pre\\fform"')).toEqual([`pre${String.fromCharCode(0x0c)}form`]);
  });

  test("decodes \\r (carriage return)", () => {
    expect(untracked('"pre\\rret"')).toEqual([`pre${String.fromCharCode(0x0d)}ret`]);
  });

  test("decodes an escaped quote and an escaped backslash", () => {
    expect(untracked('"say \\"hi\\" then \\\\ done"')).toEqual(['say "hi" then \\ done']);
  });
});

describe("unquotePorcelainPath — numeric escapes", () => {
  test("decodes a 3-digit octal escape (e.g. \\303\\251 -> é)", () => {
    expect(untracked('"caf\\303\\251"')).toEqual(["café"]);
  });

  test("decodes a short octal escape (fewer than 3 digits before a non-octal char)", () => {
    // \101 = octal 101 = 65 = 'A'
    expect(untracked('"pre\\101post"')).toEqual(["preApost"]);
  });

  test("decodes a \\xNN hex escape", () => {
    expect(untracked('"pre\\x41post"')).toEqual(["preApost"]);
  });

  test("falls back to a bare 'x' when the following two characters are not valid hex", () => {
    // Not a recognized \x escape (only one hex digit follows) — backslash is
    // preserved and 'x' is processed as its own literal character.
    expect(untracked('"pre\\xZpost"')).toEqual(["pre\\xZpost"]);
  });
});

describe("unquotePorcelainPath — unknown escape fallback", () => {
  test("preserves the backslash verbatim for an unrecognized escape letter", () => {
    expect(untracked('"a\\qb"')).toEqual(["a\\qb"]);
  });

  test("preserves a trailing lone backslash with nothing after it", () => {
    expect(untracked('"trailing\\"')).toEqual(["trailing\\"]);
  });
});

describe("splitRenameOldPath — backslash inside a quoted old path", () => {
  test("skips an escaped character while scanning for the closing quote", () => {
    // The quoted OLD path contains a literal backslash followed by a
    // character that is not itself a quote — the scan must step over both
    // rather than mistaking the backslash's escapee for the closing quote.
    const line = 'R  ".nax/f\\oo" -> .nax/new.txt';
    const result = parsePorcelainForNaxPaths(line);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(".nax/f\\oo");
    expect(result[0].staged).toBe(true);
  });
});
