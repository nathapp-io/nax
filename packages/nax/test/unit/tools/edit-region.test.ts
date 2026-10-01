/**
 * Edit writes `new_string` literally (US-001).
 *
 * `String.prototype.replace` treats a string replacement as a template and
 * expands `$$`, `$&`, `` $` `` and `$'` inside it, so an `Edit` whose
 * `new_string` contained one of those patterns wrote something other than the
 * text the model supplied. These tests pin the literal contract at both seams:
 * the `replaceUniqueLiteral` helper and `editTool.run` writing the file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  _editDeps,
  type CodingToolOutcome,
  compileToolPolicy,
  createCodingToolRuntime,
  DEFAULT_TOOL_MAX_FILE_BYTES,
  editTool,
  MODEL_MAX_BYTES,
  readTool,
} from "@/tools";
import { composeEditRegion, replaceUniqueLiteral } from "@/tools/edit-region";

const ORIGINAL = "const a = 1;\nconst b = 2;\n";
const OLD_STRING = "const a = 1;";

let root: string;
/** Symlink-resolved root: the tool policy returns resolved paths, so the runtime's `edited <target>` names this spelling. */
let realRoot: string;

beforeEach(() => {
  root = makeTempDir("nax-edit-region-");
  realRoot = realpathSync(root);
});

afterEach(() => {
  cleanupTempDir(root);
});

/** Write the shared fixture into a fresh file and return its absolute path. */
function fixturePath(): string {
  const path = join(root, "a.ts");
  writeFileSync(path, ORIGINAL);
  return path;
}

function ctx(path: string) {
  return { root, resolvedPaths: [path], maxBytes: 10_000, maxFileBytes: DEFAULT_TOOL_MAX_FILE_BYTES };
}

/** Run the fixture edit and return the file's contents afterwards. */
async function editAndRead(newString: string): Promise<string> {
  const path = fixturePath();
  const res = await editTool.run({ path: "a.ts", old_string: OLD_STRING, new_string: newString }, ctx(path));
  expect(res.isError).toBeFalsy();
  return readFileSync(path, "utf8");
}

describe("replaceUniqueLiteral", () => {
  test("US-001: returns the source with new_string inserted literally, expanding $&", () => {
    expect(replaceUniqueLiteral("abcdef", "cd", "X$&Y", 2)).toBe("abX$&Yef");
  });

  test("US-001: replaces a match at index 0 and keeps the trailing text", () => {
    expect(replaceUniqueLiteral("const a = 1;", "const a = 1;", "const a = 2;", 0)).toBe("const a = 2;");
  });
});

describe("editTool literal new_string", () => {
  test('US-001: writes "x$$y" verbatim rather than collapsing $$ to $', async () => {
    expect(await editAndRead('const a = "x$$y";')).toBe('const a = "x$$y";\nconst b = 2;\n');
  });

  test("US-001: keeps the regex-escape characters \\$& unchanged", async () => {
    const newString = String.raw`s.replace(re, "\\$&");`;
    const updated = await editAndRead(newString);
    expect(updated).toBe(`${newString}\nconst b = 2;\n`);
    expect(updated).toContain(String.raw`\$&`);
  });

  test("US-001: a new_string ending in `$` and a backtick does not insert the file prefix", async () => {
    const newString = "const hexRe = `^[0-9a-f]{8}$`;";
    expect(await editAndRead(newString)).toBe(`${newString}\nconst b = 2;\n`);
  });

  test("US-001: the updated length is original - old + new for a `$`-backtick suffix", async () => {
    const newString = "const hexRe = `^[0-9a-f]{8}$`;";
    const updated = await editAndRead(newString);
    expect(updated.length).toBe(ORIGINAL.length - OLD_STRING.length + newString.length);
  });

  test("US-001: a new_string containing $' does not insert the text after the match", async () => {
    const newString = "const a = `x$'y`;";
    expect(await editAndRead(newString)).toBe(`${newString}\nconst b = 2;\n`);
  });

  test("US-001: a new_string without $ matches plain String.replace", async () => {
    const newString = "const a = 42;";
    expect(await editAndRead(newString)).toBe(ORIGINAL.replace(OLD_STRING, newString));
  });
});

// -----------------------------------------------------------------------------
// US-002 — Edit returns the changed region.
//
// The fixture the ACs pin is a 20-line file whose kth line is `line k`, joined
// without a trailing newline so the file is exactly 20 lines.
// -----------------------------------------------------------------------------

const FILE_20 = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

/** A new_string of `count` labelled lines: "n1\nn2\n...\nnN". */
function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `n${i + 1}`).join("\n");
}

/** Write `content` into a fresh file under root and run Edit on it. */
async function runEdit(
  content: string,
  oldString: string,
  newString: string,
): Promise<{ content: string; path: string }> {
  const path = join(root, "region.ts");
  writeFileSync(path, content);
  const res = await editTool.run({ path: "region.ts", old_string: oldString, new_string: newString }, ctx(path));
  expect(res.isError).toBeFalsy();
  return { content: res.content, path };
}

/** The result's lines: [edited <target>, header, ...body]. */
function resultLines(content: string): string[] {
  return content.split("\n");
}

/** The edited file's lines `from`..`to` (1-based, inclusive). */
function fileLines(path: string, from: number, to: number): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .slice(from - 1, to);
}

function readCtx(path: string) {
  return { root, resolvedPaths: [path], maxBytes: 10_000, maxFileBytes: DEFAULT_TOOL_MAX_FILE_BYTES };
}

function okContent(outcome: CodingToolOutcome): string {
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
  return outcome.content;
}

describe("composeEditRegion", () => {
  test("US-002: an empty updated file yields the empty-file line", () => {
    expect(composeEditRegion({ updated: "", matchIndex: 0, newStringLength: 0 })).toBe("[file is now empty]");
  });

  test("US-002: an exactly eight-line replacement is shown in full", () => {
    const updated = numberedLines(8);
    const view = composeEditRegion({ updated, matchIndex: 0, newStringLength: updated.length });
    expect(view).toBe(`[lines 1-8 of 8]\n${updated}`);
    expect(view).not.toContain("[... lines");
  });

  test("US-002: a nine-line replacement elides its middle", () => {
    const updated = numberedLines(9);
    const view = composeEditRegion({ updated, matchIndex: 0, newStringLength: updated.length });
    expect(view).toBe("[lines 1-9 of 9]\nn1\nn2\nn3\n[... lines 4-6 not shown ...]\nn7\nn8\nn9");
  });

  test("US-002: a lone-newline file yields a header with no trailing newline", () => {
    const view = composeEditRegion({ updated: "\n", matchIndex: 0, newStringLength: 1 });
    expect(view).toBe("[lines 1-1 of 1]");
    expect(view.endsWith("\n")).toBe(false);
  });
});

describe("US-002: editTool description", () => {
  test("US-002 AC1: the description opens with the Edit contract sentence", () => {
    expect(
      editTool.description.startsWith(
        "Replace one exact occurrence of old_string with new_string in a repository file.",
      ),
    ).toBe(true);
  });

  test("US-002 AC2: the description closes with the changed-region notice", () => {
    expect(
      editTool.description.endsWith(
        "On success the result shows the edited lines with up to 3 lines of context and their line range, so you do not need to Read the file again to check the edit.",
      ),
    ).toBe(true);
  });
});

describe("US-002: Edit returns the changed region", () => {
  test("US-002 AC3: the first result line reports the edit", async () => {
    const { content, path } = await runEdit(FILE_20, "line 10", "line TEN");
    expect(resultLines(content)[0]).toBe(`edited ${path}`);
  });

  test("US-002 AC4: the header names the context window and the total", async () => {
    const { content } = await runEdit(FILE_20, "line 10", "line TEN");
    expect(resultLines(content)[1]).toBe("[lines 7-13 of 20]");
  });

  test("US-002 AC5: the body is the edited file's lines 7 to 13", async () => {
    const { content, path } = await runEdit(FILE_20, "line 10", "line TEN");
    expect(resultLines(content).slice(2)).toEqual(fileLines(path, 7, 13));
    expect(fileLines(path, 10, 10)).toEqual(["line TEN"]);
  });

  test("US-002 AC6: a match on line 2 gives the header for lines 1-5", async () => {
    const { content } = await runEdit(FILE_20, "line 2\n", "line TWO\n");
    expect(resultLines(content)[1]).toBe("[lines 1-5 of 20]");
  });

  test("US-002 AC7: replacing the last two lines renumbers the total to 19", async () => {
    const { content } = await runEdit(FILE_20, "line 19\nline 20", "line END");
    expect(resultLines(content)[1]).toBe("[lines 16-19 of 19]");
  });

  test("US-002 AC8: the body is the edited file's lines 16 to 19", async () => {
    const { content, path } = await runEdit(FILE_20, "line 19\nline 20", "line END");
    expect(resultLines(content).slice(2)).toEqual(fileLines(path, 16, 19));
  });

  test("US-002 AC9: a three-line replacement widens the window and the total", async () => {
    const { content } = await runEdit(FILE_20, "line 10", "A\nB\nC");
    expect(resultLines(content)[1]).toBe("[lines 7-15 of 22]");
  });

  test("US-002 AC10: the body shows the three inserted lines in full", async () => {
    const { content } = await runEdit(FILE_20, "line 10", "A\nB\nC");
    expect(resultLines(content).slice(2)).toEqual([
      "line 7",
      "line 8",
      "line 9",
      "A",
      "B",
      "C",
      "line 11",
      "line 12",
      "line 13",
    ]);
  });

  test("US-002 AC11: deleting a whole line renumbers the header to 19 lines", async () => {
    const { content } = await runEdit(FILE_20, "line 10\n", "");
    expect(resultLines(content)[1]).toBe("[lines 7-13 of 19]");
  });

  test("US-002 AC12: the body after a deletion is the edited file's lines 7 to 13", async () => {
    const { content, path } = await runEdit(FILE_20, "line 10\n", "");
    expect(resultLines(content).slice(2)).toEqual(fileLines(path, 7, 13));
  });

  test("US-002 AC13: a 20-line replacement spans 39 lines in the header", async () => {
    const { content } = await runEdit(FILE_20, "line 10", numberedLines(20));
    expect(resultLines(content)[1]).toBe("[lines 7-32 of 39]");
  });

  test("US-002 AC14: the elided body shows head, marker, and tail", async () => {
    const { content } = await runEdit(FILE_20, "line 10", numberedLines(20));
    expect(resultLines(content).slice(2)).toEqual([
      "line 7",
      "line 8",
      "line 9",
      "n1",
      "n2",
      "n3",
      "[... lines 13-26 not shown ...]",
      "n18",
      "n19",
      "n20",
      "line 11",
      "line 12",
      "line 13",
    ]);
  });

  test("US-002 AC15: an eight-line replacement is shown in full without an elision marker", async () => {
    const { content } = await runEdit(FILE_20, "line 10", numberedLines(8));
    expect(content).not.toContain("[... lines");
    expect(resultLines(content).slice(2)).toEqual([
      "line 7",
      "line 8",
      "line 9",
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
      "n6",
      "n7",
      "n8",
      "line 11",
      "line 12",
      "line 13",
    ]);
  });

  test("US-002 AC16: emptying a one-line file reports the empty file", async () => {
    const { content, path } = await runEdit("solo line", "solo line", "");
    expect(content).toBe(`edited ${path}\n[file is now empty]`);
  });

  test("US-002 AC17: a successful result does not end with a newline", async () => {
    const { content } = await runEdit(FILE_20, "line 10", "line TEN");
    expect(content.endsWith("\n")).toBe(false);
  });

  test("US-002 AC17: a window whose last line is blank does not end with a newline", async () => {
    const { content } = await runEdit("a\nb\n\n", "b", "B");
    expect(content.endsWith("\n")).toBe(false);
    expect(content).toBe(`edited ${join(root, "region.ts")}\n[lines 1-3 of 3]\na\nB`);
  });

  test("US-002 AC18: an absent old_string returns the exact not-found message", async () => {
    const path = join(root, "region.ts");
    writeFileSync(path, FILE_20);
    const res = await editTool.run({ path: "region.ts", old_string: "line 99", new_string: "x" }, ctx(path));
    expect(res).toEqual({ content: `old_string not found in ${path}; the file may have changed`, isError: true });
  });

  test("US-002 AC19: an ambiguous old_string returns the exact ambiguity message", async () => {
    const path = join(root, "dup.ts");
    writeFileSync(path, "same\nsame\n");
    const res = await editTool.run({ path: "dup.ts", old_string: "same", new_string: "other" }, ctx(path));
    expect(res).toEqual({
      content: "old_string is ambiguous: found 2 times. Include more surrounding context.",
      isError: true,
    });
  });

  test("US-002 AC20: an over-ceiling file returns the exact refusal", async () => {
    const path = join(root, "big.ts");
    writeFileSync(path, "x".repeat(50));
    const res = await editTool.run(
      { path: "big.ts", old_string: "x", new_string: "y" },
      { root, resolvedPaths: [path], maxBytes: 10_000, maxFileBytes: 10 },
    );
    expect(res).toEqual({
      content: `the file is 50 bytes, which exceeds the 10-byte file ceiling -- refusing to edit ${path}`,
      isError: true,
    });
  });

  test("US-002 AC21: a read failure after stat returns the error message and no view", async () => {
    const path = join(root, "region.ts");
    writeFileSync(path, FILE_20);
    const original = _editDeps.readFile;
    _editDeps.readFile = async () => {
      throw new Error("EACCES: permission denied, open 'region.ts'");
    };
    try {
      const res = await editTool.run({ path: "region.ts", old_string: "line 10", new_string: "line TEN" }, ctx(path));
      expect(res).toEqual({ content: "EACCES: permission denied, open 'region.ts'", isError: true });
      expect(res.content).not.toContain("[lines");
    } finally {
      _editDeps.readFile = original;
    }
  });

  test("US-002 AC22: a write failure returns the error message and no view", async () => {
    const path = join(root, "region.ts");
    writeFileSync(path, FILE_20);
    const original = _editDeps.writeFile;
    _editDeps.writeFile = async () => {
      throw new Error("ENOSPC: no space left on device, write");
    };
    try {
      const res = await editTool.run({ path: "region.ts", old_string: "line 10", new_string: "line TEN" }, ctx(path));
      expect(res).toEqual({ content: "ENOSPC: no space left on device, write", isError: true });
      expect(res.content).not.toContain("[lines");
      // The edit never landed, and no view was composed for a failed write.
      expect(readFileSync(path, "utf8")).toBe(FILE_20);
    } finally {
      _editDeps.writeFile = original;
    }
  });
});

describe("US-002: an authorized runtime Edit returns the full view", () => {
  async function authorizedEdit(): Promise<{ outcome: CodingToolOutcome; path: string }> {
    const path = join(root, "region.ts");
    writeFileSync(path, FILE_20);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Edit", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
    });
    rt.advertised(["Edit"]);
    const outcome = await rt.callTool("Edit", { path: "region.ts", old_string: "line 10", new_string: "line TEN" });
    return { outcome, path };
  }

  test("US-002 AC23: the authorized call succeeds", async () => {
    const { outcome } = await authorizedEdit();
    expect(outcome.kind).toBe("ok");
  });

  test("US-002 AC24: the outcome carries the full edited-region view", async () => {
    const { outcome, path } = await authorizedEdit();
    const target = join(realRoot, "region.ts");
    expect(okContent(outcome)).toBe([`edited ${target}`, "[lines 7-13 of 20]", ...fileLines(path, 7, 13)].join("\n"));
  });

  test("US-002 AC25: the view is not truncated by the after_tool policy", async () => {
    const { outcome } = await authorizedEdit();
    expect(okContent(outcome)).not.toContain("[truncated:");
  });

  test("US-002 AC26: the edit reached the file on disk", async () => {
    const { path } = await authorizedEdit();
    expect(fileLines(path, 10, 10)).toEqual(["line TEN"]);
  });

  test("US-002 AC27: a ranged Read of the edited file returns the same body lines", async () => {
    const { outcome, path } = await authorizedEdit();
    const readRes = await readTool.run({ path: "region.ts", offset: 7, limit: 7 }, readCtx(path));
    expect(readRes.isError).toBeFalsy();
    const readBody = readRes.content.split("\n").slice(1, 8);
    expect(readBody).toEqual(fileLines(path, 7, 13));
    expect(readBody).toEqual(okContent(outcome).split("\n").slice(2));
  });
});
