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
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { DEFAULT_TOOL_MAX_FILE_BYTES, editTool } from "@/tools";
import { replaceUniqueLiteral } from "@/tools/edit-region";

const ORIGINAL = "const a = 1;\nconst b = 2;\n";
const OLD_STRING = "const a = 1;";

let root: string;

beforeEach(() => {
  root = makeTempDir("nax-edit-region-");
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
