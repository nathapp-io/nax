/**
 * Directory-grouped Glob output and existence-probe description.
 *
 * Each acceptance criterion below exercises a piece of the new shape — one
 * line per parent directory, basenames sorted ascending, quoted basenames
 * round-tripping losslessly — and the `_globDeps` scan injection that lets a
 * test provoke the catch path without planting a malformed pattern on disk.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _globDeps, DEFAULT_TOOL_MAX_FILE_BYTES, globTool } from "@/tools";

let root: string;

// Capture the production scanner at module-load time so the afterEach hook
// restores the real Bun.Glob scanner, not a placeholder. The capture must
// happen after `_globDeps` has been imported above (so the export is bound)
// and before any test substitutes a stub.
const productionScan = _globDeps.scan;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nax-glob-"));
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "deep", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(root, "notes.md"), "hello\n");
  writeFileSync(join(root, "docs", "intro.md"), "intro\n");
  writeFileSync(join(root, "docs", "release notes.md"), "release\n");
});

afterEach(() => {
  // _globDeps.scan is test-only; production wires it to a real Bun.Glob
  // scanner. Restore the original scanner between cases so a stub from one
  // test never leaks into the next.
  _globDeps.scan = productionScan;
});

function ctx() {
  return { root, resolvedPaths: [], maxBytes: 10_000, maxFileBytes: DEFAULT_TOOL_MAX_FILE_BYTES };
}

/**
 * Unescape a quoted-form basename back into its real characters. The renderer
 * uses a JSON-style escape (`\"`, `\\`, `\n`, `\r`, `\t`); everything else
 * passes through so the parser can survive an unrecognised escape rather than
 * silently swallowing characters.
 */
function unescapeBasename(s: string): string {
  let result = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === "\\") {
        result += "\\";
        i += 2;
        continue;
      }
      if (next === '"') {
        result += '"';
        i += 2;
        continue;
      }
      if (next === "n") {
        result += "\n";
        i += 2;
        continue;
      }
      if (next === "r") {
        result += "\r";
        i += 2;
        continue;
      }
      if (next === "t") {
        result += "\t";
        i += 2;
        continue;
      }
    }
    result += s[i];
    i++;
  }
  return result;
}

/**
 * Parse a group line into its leading directory prefix and basenames. Each
 * line is `<dir>/ <b1> <b2> ...` with basenames that contain whitespace or
 * `"` wrapped in `"..."` and special characters escaped. The parser is what
 * the agent would do to recover the matched paths; if the format ever
 * changes, the round-trip AC (#5) must still match.
 */
function parseGroupLine(line: string): { dir: string; basenames: string[] } {
  // A line is `<dir>/ <b1> <b2> ...` — the directory prefix always ends in
  // "/" (the leading "./" case is just `./<basename>` with a trailing space).
  expect(line).toMatch(/^\S+\/\s/);
  const spaceIdx = line.indexOf(" ");
  const dir = line.slice(0, spaceIdx);
  const rest = line.slice(spaceIdx + 1);
  const basenames: string[] = [];
  // Walk basenames separated by single spaces. A basename is either an
  // unquoted run of non-space characters, or a double-quoted run with
  // backslash escapes. The unquoted case reads up to the next space; the
  // quoted case reads until the unescaped close quote.
  let i = 0;
  while (i < rest.length) {
    if (rest[i] === '"') {
      i++;
      let body = "";
      while (i < rest.length && rest[i] !== '"') {
        // A backslash escapes the next character, including `\"` — the scan
        // for the closing quote must skip the pair, or an escaped quote would
        // be read as the end of the basename.
        if (rest[i] === "\\" && i + 1 < rest.length) {
          body += rest[i] + rest[i + 1];
          i += 2;
          continue;
        }
        body += rest[i];
        i++;
      }
      expect(rest[i]).toBe('"');
      i++;
      basenames.push(unescapeBasename(body));
    } else {
      const next = rest.indexOf(" ", i);
      if (next === -1) {
        basenames.push(rest.slice(i));
        i = rest.length;
        continue;
      }
      basenames.push(rest.slice(i, next));
      i = next;
    }
    // Between basenames: skip the single space. The next iteration's `while`
    // guard handles end-of-string naturally.
    if (i < rest.length) {
      expect(rest[i]).toBe(" ");
      i++;
    }
  }
  return { dir, basenames };
}

describe("globTool — directory-grouped output", () => {
  test("AC1: src/**/*.ts yields one group line per parent directory", async () => {
    const res = await globTool.run({ pattern: "src/**/*.ts" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("src/ a.ts\nsrc/deep/ b.ts");
  });

  test("AC2: a file directly at the root is grouped under './'", async () => {
    const res = await globTool.run({ pattern: "*.md" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("./ notes.md");
  });

  test("AC3: group lines are ordered by ascending directory prefix", async () => {
    const res = await globTool.run({ pattern: "**/*.ts" }, ctx());
    const lines = res.content.split("\n");
    const idxSrc = lines.findIndex((l) => l.startsWith("src/ "));
    const idxDeep = lines.findIndex((l) => l.startsWith("src/deep/ "));
    expect(idxSrc).toBeGreaterThanOrEqual(0);
    expect(idxDeep).toBeGreaterThanOrEqual(0);
    expect(idxSrc).toBeLessThan(idxDeep);
  });

  test("AC4: basenames within a group are ordered ascending", async () => {
    const res = await globTool.run({ pattern: "src/**" }, ctx());
    const lines = res.content.split("\n");
    // Two groups exist: "src/ a.ts" and "src/deep/ b.ts". The basenames on
    // each line must be ascending within that line.
    for (const line of lines) {
      const { basenames } = parseGroupLine(line);
      const sorted = [...basenames].sort();
      expect(basenames).toEqual(sorted);
    }
  });

  test("AC4 (extended): basenames are ordered ascending even when the disk order is shuffled", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "nax-glob-shuffle-"));
    mkdirSync(join(fixtureRoot, "dir"), { recursive: true });
    // Write in reverse order to make sure the sort is the renderer's doing.
    writeFileSync(join(fixtureRoot, "dir", "c.ts"), "");
    writeFileSync(join(fixtureRoot, "dir", "b.ts"), "");
    writeFileSync(join(fixtureRoot, "dir", "a.ts"), "");
    const res = await globTool.run(
      { pattern: "**/*.ts" },
      {
        root: fixtureRoot,
        resolvedPaths: [],
        maxBytes: 10_000,
        maxFileBytes: DEFAULT_TOOL_MAX_FILE_BYTES,
      },
    );
    expect(res.content).toBe("dir/ a.ts b.ts c.ts");
  });

  test("AC5: round-tripping through the group format reconstructs the matched set", async () => {
    const res = await globTool.run({ pattern: "**/*" }, ctx());
    expect(res.isError).toBeFalsy();
    const reconstructed = new Set<string>();
    for (const line of res.content.split("\n")) {
      const { dir, basenames } = parseGroupLine(line);
      for (const b of basenames) {
        reconstructed.add(`${dir}${b}`);
      }
    }
    expect(reconstructed).toEqual(
      new Set(["./notes.md", "src/a.ts", "src/deep/b.ts", "docs/intro.md", "docs/release notes.md"]),
    );
  });

  test("AC6: a basename with a space is wrapped in double quotes", async () => {
    const res = await globTool.run({ pattern: "docs/*" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('"release notes.md"');
    expect(res.content).toContain("intro.md");
    // Line must remain unambiguously splittable: a quoted basename never
    // leaks into the directory prefix, and the prefix still ends in "/".
    const lines = res.content.split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0].startsWith("docs/ ")).toBe(true);
  });

  test("whitespace-bearing basenames (space, tab, NBSP) all quote to preserve the round-trip", async () => {
    // The renderer must treat every whitespace character as a reason to
    // quote, not just ` ` and `\t` — a tab or NBSP in an unquoted basename
    // would split a single basename into two when the parser reads it back,
    // violating AC5's reconstructed-set invariant. Tab is escaped as the
    // two-character sequence `\t` so the parser reverses it losslessly;
    // NBSP survives literally since it isn't a control character. `_globDeps.scan`
    // is the injection seam: the filesystem would not yield a basename with
    // a literal NBSP on its own, so the test drives the production path with
    // a controlled iterator.
    _globDeps.scan = () =>
      (async function* () {
        yield "src/a b.ts";
        yield "src/c\td.ts";
        yield "src/e\u00A0f.ts";
        yield "src/plain.ts";
      })();
    const res = await globTool.run({ pattern: "**/*.ts" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('"a b.ts"');
    // Tab in the basename escapes to the two-character sequence `\t`.
    expect(res.content).toContain('"c\\td.ts"');
    // NBSP is whitespace but not a control — it passes through literally.
    expect(res.content).toContain('"e\u00A0f.ts"');
    // The plain basename stays unquoted — only whitespace (or `"`) triggers quoting.
    expect(res.content).toContain("plain.ts");
    expect(res.content).not.toContain('"plain.ts"');
  });

  test("embedded quotes and newlines in basenames round-trip losslessly via escaping", async () => {
    // AC5 demands the reconstructed set equals the matched set exactly. A
    // basename with `"` or `\n` would break the format if emitted raw: the
    // inner `"` would terminate the quoted form early, and a literal `\n`
    // would split the line itself when group lines are joined by `\n`. The
    // renderer must escape these so the parser can reverse them. A
    // basename with just a backslash is emitted unquoted — the backslash is
    // not whitespace or a quote character, so it does not need quoting on
    // its own.
    _globDeps.scan = () =>
      (async function* () {
        yield 'src/has"quote.md';
        yield "src/has\nnewline.md";
        yield "src/has\rcarriage.md";
        yield "src/has\\backslash.md";
      })();
    const res = await globTool.run({ pattern: "**/*.md" }, ctx());
    expect(res.isError).toBeFalsy();
    // Quote-bearing and control-whitespace basenames are wrapped in quotes
    // with escapes applied.
    expect(res.content).toContain('"has\\"quote.md"');
    expect(res.content).toContain('"has\\nnewline.md"');
    expect(res.content).toContain('"has\\rcarriage.md"');
    // A pure-backslash basename stays unquoted — the renderer only quotes
    // when whitespace or `"` is present.
    expect(res.content).toContain("has\\backslash.md");
    // Crucially, no literal `\n` may appear in the output — otherwise the
    // line structure breaks. The escape uses the two-character sequence `\n`
    // (backslash + n), not a real newline.
    expect(res.content).not.toContain("\n\n"); // there must still be exactly one separator between the two lines
    // And no literal carriage return either — that would also break grouping.
    expect(res.content).not.toContain("\r");

    // Round-trip: the parser must recover the original basenames, in the
    // ascending code-unit order AC4 requires (`\n` 0x0a < `\r` 0x0d < `"` 0x22
    // < `\` 0x5c).
    const lines = res.content.split("\n");
    expect(lines).toHaveLength(1);
    const { dir, basenames } = parseGroupLine(lines[0]);
    expect(dir).toBe("src/");
    expect(basenames).toEqual(["has\nnewline.md", "has\rcarriage.md", 'has"quote.md', "has\\backslash.md"]);
  });

  test("AC7: a single match uses the same shape as a multi-match result", async () => {
    const res = await globTool.run({ pattern: "src/a.ts" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("src/ a.ts");
  });

  test("AC8: no matches reports the pattern and is not an error", async () => {
    const res = await globTool.run({ pattern: "**/*.py" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('no matches for "**/*.py"');
  });

  test("AC9: a pattern that climbs out yields 'no matches' with no '..' sequence", async () => {
    const res = await globTool.run({ pattern: "../**/*" }, ctx());
    expect(res.content).toBe("no matches");
    expect(res.content).not.toContain("..");
  });

  test("AC10: more than 500 matches yield exactly 500 basenames across group lines", async () => {
    const manyRoot = mkdtempSync(join(tmpdir(), "nax-glob-many-"));
    mkdirSync(join(manyRoot, "dir"), { recursive: true });
    // 600 files; the cap is 500, so 500 basenames must appear in the output.
    for (let i = 0; i < 600; i++) {
      writeFileSync(join(manyRoot, "dir", `f${i}.txt`), "");
    }
    const res = await globTool.run(
      { pattern: "**/*.txt" },
      {
        root: manyRoot,
        resolvedPaths: [],
        maxBytes: 10_000_000,
        maxFileBytes: DEFAULT_TOOL_MAX_FILE_BYTES,
      },
    );
    const lines = res.content.split("\n");
    let total = 0;
    for (const line of lines) {
      const { basenames } = parseGroupLine(line);
      total += basenames.length;
    }
    expect(total).toBe(500);
  });

  test("AC15: non-string pattern is rejected with the exact prior message and isError=true", async () => {
    const res = await globTool.run({ pattern: 42 }, ctx());
    expect(res).toEqual({ content: "pattern must be a string", isError: true });
  });

  test("AC15 (null): null pattern is rejected with the same message", async () => {
    const res = await globTool.run({ pattern: null }, ctx());
    expect(res).toEqual({ content: "pattern must be a string", isError: true });
  });
});

describe("globTool — _globDeps.scan injection", () => {
  test("AC11: a throwing _globDeps.scan surfaces the error as isError with its message", async () => {
    _globDeps.scan = () => {
      throw new Error("scan exploded");
    };
    const res = await globTool.run({ pattern: "src/**/*.ts" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toBe("scan exploded");
  });

  test("AC11 (async): a failure raised while advancing the scan iterator is surfaced, not swallowed", async () => {
    // Bun.Glob reports disk/glob failures while the iterator advances, not at
    // the `scan()` call itself, so the catch has to cover every `next()`. The
    // first case rejects before yielding anything; the second yields a hit and
    // then rejects, and that partial match must not leak out as a listing.
    _globDeps.scan = () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("iterator exploded")) }),
    });
    const first = await globTool.run({ pattern: "src/**/*.ts" }, ctx());
    expect(first.isError).toBe(true);
    expect(first.content).toBe("iterator exploded");

    _globDeps.scan = () =>
      (async function* () {
        yield "src/a.ts";
        throw new Error("iterator exploded mid-listing");
      })();
    const second = await globTool.run({ pattern: "src/**/*.ts" }, ctx());
    expect(second.isError).toBe(true);
    expect(second.content).toBe("iterator exploded mid-listing");
    expect(second.content).not.toContain("a.ts");
  });

  test("AC12: production scan is reached through _globDeps, not an inline Bun.Glob", async () => {
    let calls = 0;
    let received: { pattern: string; cwd: string; absolute: boolean } | undefined;
    _globDeps.scan = (pattern, opts) => {
      calls++;
      received = { pattern, cwd: opts.cwd, absolute: opts.absolute };
      // Yield a single hit so the rendering pipeline still runs end-to-end.
      return (async function* () {
        yield "src/a.ts";
      })();
    };
    const ctxObj = ctx();
    await globTool.run({ pattern: "src/**/*.ts" }, ctxObj);
    expect(calls).toBe(1);
    expect(received?.pattern).toBe("src/**/*.ts");
    expect(received?.cwd).toBe(ctxObj.root);
    expect(received?.absolute).toBe(false);
  });
});

describe("globTool.description", () => {
  test("AC13: advertises the grouped shape with sample 'path/to/ a.ts b.ts'", () => {
    expect(globTool.description).toContain("path/to/ a.ts b.ts");
  });

  test("AC14: advertises existence probing with 'whether a path exists'", () => {
    expect(globTool.description).toContain("whether a path exists");
  });

  test("advertises the decode rule that makes the lossless claim actionable", () => {
    // "Each line is lossless" is only usable if the agent knows how to decode
    // a line back into paths: that a basename is quoted when it contains
    // whitespace or a quote, which escapes stand for literal characters inside
    // a quoted form, and that an unquoted backslash is literal rather than an
    // escape introducer. Without this the rule lives only in a source comment.
    expect(globTool.description).toContain("wrapped in double quotes");
    expect(globTool.description).toContain("\\\\"); // backslash escape
    expect(globTool.description).toContain('\\"'); // quote escape
    expect(globTool.description).toContain("\\n");
    expect(globTool.description).toContain("\\r");
    expect(globTool.description).toContain("\\t");
    expect(globTool.description).toContain("bare backslash is literal");
  });
});
