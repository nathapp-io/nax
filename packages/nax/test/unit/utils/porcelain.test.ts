/**
 * Pure `git status --porcelain` parser (split out of `src/utils/git.ts`).
 *
 * `src/utils/git.ts` re-exports the parser and `test/unit/utils/git.test.ts`
 * already covers its mainline behavior end-to-end; this file targets the
 * escape-sequence branches of `unquotePorcelainPath` (a private helper
 * reachable only through the exported `parsePorcelainForNaxPaths`) and the
 * quoted-old-path backslash-skip branch of `splitRenameOldPath`.
 */
import { describe, expect, test } from "bun:test";
import { parsePorcelainForNaxPaths } from "@/utils/porcelain";

/**
 * Feed one quoted path through the surviving public parser as an unstaged
 * deletion under `.nax/`, returning the decoded paths. The `.nax/` segment is
 * what the parser keeps, so every escape-decoding branch of the private
 * `unquotePorcelainPath` stays covered through a live API.
 */
function deleted(quotedPath: string): string[] {
  return parsePorcelainForNaxPaths(` D ${quotedPath}`).map((entry) => entry.path);
}

describe("unquotePorcelainPath — control-character escapes", () => {
  test("decodes \\a (bell)", () => {
    expect(deleted('".nax/pre\\abell"')).toEqual([`.nax/pre${String.fromCharCode(0x07)}bell`]);
  });

  test("decodes \\b (backspace)", () => {
    expect(deleted('".nax/pre\\bback"')).toEqual([`.nax/pre${String.fromCharCode(0x08)}back`]);
  });

  test("decodes \\t (tab)", () => {
    expect(deleted('".nax/pre\\ttab"')).toEqual([`.nax/pre${String.fromCharCode(0x09)}tab`]);
  });

  test("decodes \\n (newline)", () => {
    expect(deleted('".nax/pre\\nline"')).toEqual([`.nax/pre${String.fromCharCode(0x0a)}line`]);
  });

  test("decodes \\v (vertical tab)", () => {
    expect(deleted('".nax/pre\\vvert"')).toEqual([`.nax/pre${String.fromCharCode(0x0b)}vert`]);
  });

  test("decodes \\f (form feed)", () => {
    expect(deleted('".nax/pre\\fform"')).toEqual([`.nax/pre${String.fromCharCode(0x0c)}form`]);
  });

  test("decodes \\r (carriage return)", () => {
    expect(deleted('".nax/pre\\rret"')).toEqual([`.nax/pre${String.fromCharCode(0x0d)}ret`]);
  });

  test("decodes an escaped quote and an escaped backslash", () => {
    expect(deleted('".nax/say \\"hi\\" then \\\\ done"')).toEqual(['.nax/say "hi" then \\ done']);
  });
});

describe("unquotePorcelainPath — numeric escapes", () => {
  test("decodes a 3-digit octal escape (e.g. \\303\\251 -> é)", () => {
    expect(deleted('".nax/caf\\303\\251"')).toEqual([".nax/café"]);
  });

  test("decodes a short octal escape (fewer than 3 digits before a non-octal char)", () => {
    // \101 = octal 101 = 65 = 'A'
    expect(deleted('".nax/pre\\101post"')).toEqual([".nax/preApost"]);
  });

  test("decodes a \\xNN hex escape", () => {
    expect(deleted('".nax/pre\\x41post"')).toEqual([".nax/preApost"]);
  });

  test("falls back to a bare 'x' when the following two characters are not valid hex", () => {
    // Not a recognized \x escape (only one hex digit follows) — backslash is
    // preserved and 'x' is processed as its own literal character.
    expect(deleted('".nax/pre\\xZpost"')).toEqual([".nax/pre\\xZpost"]);
  });
});

describe("unquotePorcelainPath — unknown escape fallback", () => {
  test("preserves the backslash verbatim for an unrecognized escape letter", () => {
    expect(deleted('".nax/a\\qb"')).toEqual([".nax/a\\qb"]);
  });

  test("preserves a trailing lone backslash with nothing after it", () => {
    expect(deleted('".nax/trailing\\"')).toEqual([".nax/trailing\\"]);
  });
});

describe("parsePorcelainForNaxPaths — .nax decoding preserved (regression guard)", () => {
  // The `\t` in this literal is a backslash followed by "t" — git's C-style
  // quoting for a path whose real character is a TAB. This is the only
  // surviving public path into the private `unquotePorcelainPath`.
  const QUOTED_TAB_DELETION = ' D ".nax/a\\tb.ts"';

  test("AC-1: one unstaged deletion of a quoted .nax path yields exactly one entry", () => {
    expect(parsePorcelainForNaxPaths(QUOTED_TAB_DELETION)).toHaveLength(1);
  });

  test("AC-2: the entry's path decodes the \\t escape into a TAB", () => {
    const [entry] = parsePorcelainForNaxPaths(QUOTED_TAB_DELETION);
    expect(entry?.path).toBe(`.nax/a${String.fromCharCode(0x09)}b.ts`);
  });

  test("AC-3: an unstaged deletion is reported as not staged", () => {
    const [entry] = parsePorcelainForNaxPaths(QUOTED_TAB_DELETION);
    expect(entry?.staged).toBe(false);
  });

  test("AC-4: a malformed record with no path field is rejected", () => {
    expect(parsePorcelainForNaxPaths(" D")).toEqual([]);
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
