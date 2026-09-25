import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TOOL_MAX_FILE_BYTES, globTool, readTool } from "@/tools";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nax-fs-"));
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "deep", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(root, "notes.md"), "hello\n");
});

function ctx(paths: string[], maxBytes = 10_000, readCeiling?: number) {
  return {
    root,
    resolvedPaths: paths,
    maxBytes,
    maxFileBytes: DEFAULT_TOOL_MAX_FILE_BYTES,
    ...(readCeiling === undefined ? {} : { readCeiling }),
  };
}

describe("readTool", () => {
  test("returns file contents", async () => {
    const res = await readTool.run({ path: "src/a.ts" }, ctx([join(root, "src", "a.ts")]));
    expect(res.content).toContain("export const a = 1;");
    expect(res.isError).toBeFalsy();
  });

  test("a missing file is an error, not a denial", async () => {
    const res = await readTool.run({ path: "src/nope.ts" }, ctx([join(root, "src", "nope.ts")]));
    expect(res.isError).toBe(true);
  });

  test("does not append a per-tool 'truncated' marker (the after_tool policy owns the marker)", async () => {
    // US-005: the model-facing cap and the marker that names the spill path
    // live at the after_tool policy (applyModelTruncationPolicy), NOT inside
    // the tool itself. The unranged readTool branch still reads at
    // ctx.readCeiling, while ctx.maxBytes remains model-facing. The OLD marker
    // — `[truncated at N bytes]` — is gone. The runtime's marker (naming the
    // spill path and both byte counts) takes its place when the body reaches
    // the message array.
    const longPath = join(root, "long.ts");
    writeFileSync(longPath, "x".repeat(200));
    const res = await readTool.run({ path: "long.ts" }, ctx([longPath], 30, 30));
    // The tool's old [truncated at N bytes] marker is gone.
    expect(res.content).not.toContain("truncated at");
    // The floor header is still emitted when the prefix hits the cap.
    expect(res.content).toMatch(/^\[\d+\+ lines\]/);
  });

  test("declares its path field so the policy can gate it", () => {
    expect(readTool.scope.pathFields).toEqual(["path"]);
  });

  describe("offset/limit ranges (#1923)", () => {
    let manyPath: string;

    beforeAll(() => {
      manyPath = join(root, "many.txt");
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
      writeFileSync(manyPath, `${lines.join("\n")}\n`);
    });

    test("no range supplied carries a [N lines] header, and an empty input equals an explicit path input", async () => {
      const withRange = await readTool.run({ path: "many.txt" }, ctx([manyPath]));
      const noInput = await readTool.run({}, ctx([manyPath]));
      expect(withRange.content).toBe(noInput.content);
      expect(withRange.content).toContain("line 1");
      expect(withRange.content).toContain("line 50");
      expect(withRange.content.startsWith("[50 lines]\n")).toBe(true);
    });

    test("offset alone returns from that 1-based line to the end", async () => {
      const res = await readTool.run({ path: "many.txt", offset: 48 }, ctx([manyPath]));
      expect(res.isError).toBeFalsy();
      expect(res.content).not.toContain("line 47");
      expect(res.content).toContain("line 48");
      expect(res.content).toContain("line 50");
      expect(res.content).toContain("[lines 48-50 of 50]");
    });

    test("offset and limit together return exactly that slice", async () => {
      const res = await readTool.run({ path: "many.txt", offset: 10, limit: 5 }, ctx([manyPath]));
      expect(res.isError).toBeFalsy();
      expect(res.content).not.toContain("line 9\n");
      expect(res.content).toContain("line 10");
      expect(res.content).toContain("line 14");
      expect(res.content).not.toContain("line 15");
      expect(res.content).toContain("[lines 10-14 of 50]");
    });

    test("limit alone starts from line 1", async () => {
      const res = await readTool.run({ path: "many.txt", limit: 3 }, ctx([manyPath]));
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("line 1");
      expect(res.content).toContain("line 3");
      expect(res.content).not.toContain("line 4");
      expect(res.content).toContain("[lines 1-3 of 50]");
    });

    test("offset past EOF returns a clear non-error message naming the line count", async () => {
      const res = await readTool.run({ path: "many.txt", offset: 999 }, ctx([manyPath]));
      expect(res.isError).toBeFalsy();
      expect(res.content).not.toBe("");
      expect(res.content).toContain("50");
      expect(res.content).toMatch(/lines/);
    });

    test.each([
      ["offset: 0", { offset: 0 }],
      ["offset: -1", { offset: -1 }],
      ["offset: 1.5", { offset: 1.5 }],
      ["offset: 'abc'", { offset: "abc" }],
      ["limit: 0", { limit: 0 }],
      ["limit: -3", { limit: -3 }],
      ["limit: 2.2", { limit: 2.2 }],
    ])("invalid %s is an isError naming the constraint", async (_label, extra) => {
      const res = await readTool.run({ path: "many.txt", ...extra }, ctx([manyPath]));
      expect(res.isError).toBe(true);
      expect(res.content.length).toBeGreaterThan(0);
    });

    test.each(["start_line", "end_line", "start", "end", "line", "lineEnd", "size"])(
      "rejects the unrecognised alias '%s', naming offset/limit",
      async (alias) => {
        const res = await readTool.run({ path: "many.txt", [alias]: 5 }, ctx([manyPath]));
        expect(res.isError).toBe(true);
        expect(res.content).toContain("offset");
        expect(res.content).toContain("limit");
        expect(res.content).toContain(alias);
      },
    );

    test("a ranged read cuts at whole-line model caps with the cap footer (after_tool is the backstop)", async () => {
      // US-002: a result over the model caps is now cut by `Read` at a
      // whole-line boundary with the cap footer. The old `[truncated at N
      // bytes]` marker is gone; the cap footer names the delivered range
      // and the offset to continue from. The after_tool policy
      // (`applyModelTruncationPolicy`) remains the unconditional backstop:
      // a within-cap Read result passes through it untouched (its within-cap
      // contract), so no spill file is written for it. The assertion below
      // pins that the old marker text is still absent.
      const res = await readTool.run({ path: "many.txt", offset: 1, limit: 50 }, ctx([manyPath], 30));
      // The tool's old `[truncated at N bytes]` marker is gone.
      expect(res.content).not.toContain("truncated at");
    });
  });

  test("a file larger than maxFileBytes reports its line count as a floor, never a false total", async () => {
    // readPrefix stops at the ceiling, so the lines it saw are all we know about.
    // Reporting them as "of N" would state a total the tool never established.
    // Its own root: the shared fixture root is asserted file-by-file by globTool.
    const bigRoot = mkdtempSync(join(tmpdir(), "nax-fs-big-"));
    const bigPath = join(bigRoot, "big.ts");
    const line = `${"x".repeat(99)}\n`;
    writeFileSync(bigPath, line.repeat(400));
    const small = { root: bigRoot, resolvedPaths: [bigPath], maxBytes: 10_000, maxFileBytes: 1_000 };

    const res = await readTool.run({ path: "big.ts", offset: 2, limit: 3 }, small);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("[lines 2-4 of ");
    expect(res.content).toContain("+]");

    const past = await readTool.run({ path: "big.ts", offset: 5_000 }, small);
    expect(past.isError).toBeFalsy();
    expect(past.content).toContain("ceiling");
    expect(past.content).not.toContain("past the end of the file");
  });

  describe("US-001 — description and limit-stop footer", () => {
    let manyPath: string;

    beforeAll(() => {
      manyPath = join(root, "many.txt");
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
      writeFileSync(manyPath, `${lines.join("\n")}\n`);
    });

    // AC1-AC4: readTool.description includes three new sentences and still
    // begins with the existing baseline sentence. Description text is part
    // of the runtime model prompt, so a regression here would let the old
    // baseline description leak back to the agent.
    test("AC1 — description tells the model to use Read instead of cat/sed/head/tail/awk", () => {
      expect(readTool.description).toContain(
        "Use Read to examine files instead of cat, sed, head, tail or awk in Bash.",
      );
    });

    test("AC2 — description tells the model that a partial read ends with an offset-to-continue line", () => {
      expect(readTool.description).toContain(
        "A read that stops before the end of the file ends with a line naming the offset to continue from.",
      );
    });

    test("AC3 — description tells the model how to read large files via offset/limit", () => {
      expect(readTool.description).toContain(
        "For a large file, read the part you need with offset/limit; when you need the whole file, continue with offset until complete.",
      );
    });

    test("AC4 — description still begins with the existing baseline sentence", () => {
      expect(readTool.description.startsWith("Read a UTF-8 text file from the repository.")).toBe(true);
    });

    // AC5-AC14: the ranged path adds a single trailer line when `limit` was
    // supplied and the slice ends before the file's known line count. The
    // trailer names the offset to continue from and the count of lines the
    // caller has not yet seen. The composition is entirely deterministic —
    // no LLM, no config knob, no tool argument.
    test("AC5 — offset=10, limit=5 on a 50-line file ends with the limit-stop footer", async () => {
      const res = await readTool.run({ path: "many.txt", offset: 10, limit: 5 }, ctx([manyPath]));
      expect(res.isError).toBeFalsy();
      const lines = res.content.split("\n");
      expect(lines.at(-1)).toBe("[36 more lines in file. Use offset=15 to continue.]");
    });

    test("AC6 — limit=3 with no offset on a 50-line file ends with the limit-stop footer", async () => {
      const res = await readTool.run({ path: "many.txt", limit: 3 }, ctx([manyPath]));
      expect(res.isError).toBeFalsy();
      const lines = res.content.split("\n");
      expect(lines.at(-1)).toBe("[47 more lines in file. Use offset=4 to continue.]");
    });

    test("AC7 — header, body lines and footer are in the expected order for a limited range", async () => {
      const res = await readTool.run({ path: "many.txt", offset: 10, limit: 5 }, ctx([manyPath]));
      expect(res.isError).toBeFalsy();
      const lines = res.content.split("\n");
      // header
      expect(lines[0]).toBe("[lines 10-14 of 50]");
      // body lines are exactly file lines 10..14
      expect(lines.slice(1, lines.length - 1)).toEqual(["line 10", "line 11", "line 12", "line 13", "line 14"]);
      // footer is the last line and is the limit-stop trailer
      expect(lines.at(-1)).toBe("[36 more lines in file. Use offset=15 to continue.]");
    });

    test("AC8 — limit reaching the last line produces no footer (endLine == totalLines)", async () => {
      // offset=48, limit=3 on a 50-line file reads lines 48..50 — exactly the
      // tail of the file, so `endLine == totalLines` and the footer rule
      // (limit was given AND endLine < totalLines) is false.
      const res = await readTool.run({ path: "many.txt", offset: 48, limit: 3 }, ctx([manyPath]));
      expect(res.isError).toBeFalsy();
      const bracketLines = res.content.split("\n").filter((l) => l.startsWith("["));
      expect(bracketLines).toEqual(["[lines 48-50 of 50]"]);
    });

    test("AC9 — offset alone (no limit) reaching the last line produces no footer", async () => {
      // No `limit` was supplied, so the footer rule is false regardless of
      // endLine. The header is the only `[`-prefixed line.
      const res = await readTool.run({ path: "many.txt", offset: 48 }, ctx([manyPath]));
      expect(res.isError).toBeFalsy();
      const bracketLines = res.content.split("\n").filter((l) => l.startsWith("["));
      expect(bracketLines).toEqual(["[lines 48-50 of 50]"]);
    });

    test("AC10 — limit-stop footer on a bounded read carries `+` (floor) and is the file's last line", async () => {
      // 400 lines of 100 bytes each = 40_000 bytes total. ctx.maxFileBytes = 1000
      // means readPrefix returns at most 1001 bytes (the +1 byte that signals
      // "more was available"). Each line is `${"x".repeat(99)}\n` = 100 bytes,
      // so 1000 bytes holds exactly 10 lines and 1 byte of the 11th line.
      // After splitting, totalLines = 11, bounded = true → header label is
      // `11+`. offset=2 limit=3 selects file lines 2..4 (endLine=4). R =
      // header's floor total minus b = 11 - 4 = 7. Footer is the limit-stop
      // trailer with the floor marker.
      const bigRoot = mkdtempSync(join(tmpdir(), "nax-us001-"));
      const bigPath = join(bigRoot, "big.ts");
      const line = `${"x".repeat(99)}\n`;
      writeFileSync(bigPath, line.repeat(400));
      const small = { root: bigRoot, resolvedPaths: [bigPath], maxBytes: 10_000, maxFileBytes: 1_000 };

      const res = await readTool.run({ path: "big.ts", offset: 2, limit: 3 }, small);
      expect(res.isError).toBeFalsy();
      const lines = res.content.split("\n");
      expect(lines[0]).toBe("[lines 2-4 of 11+]");
      expect(lines.at(-1)).toBe("[7+ more lines in file. Use offset=5 to continue.]");
    });

    test("AC11 — unranged read of a 50-line file returns the [N lines] header, every file line, and no footer", async () => {
      const res = await readTool.run({ path: "many.txt" }, ctx([manyPath]));
      expect(res.isError).toBeFalsy();
      const lines = res.content.split("\n");
      // header
      expect(lines[0]).toBe("[50 lines]");
      // body is the 50 file lines. The prefix the tool reads ends with `\n`,
      // so the split yields a trailing empty string after "line 50"; drop it
      // to recover the file lines the model actually sees.
      const body = lines.slice(1, -1);
      expect(body).toEqual(Array.from({ length: 50 }, (_, i) => `line ${i + 1}`));
      // no footer: no trailing line beginning with `[`
      expect(lines.filter((l) => l.startsWith("["))).toEqual(["[50 lines]"]);
    });

    test("AC12 — offset past the end returns today's non-error past-the-end message with no footer", async () => {
      // Past-the-end takes the early-return branch, which never composes the
      // header + body + footer triplet. The footer must NOT be appended.
      const res = await readTool.run({ path: "many.txt", offset: 999 }, ctx([manyPath]));
      expect(res.isError).toBeFalsy();
      expect(res.content).not.toContain("[999 more lines in file");
      expect(res.content).not.toContain("Use offset=");
      expect(res.content).toContain("50");
      expect(res.content).toMatch(/lines/);
    });

    test("AC13 — limit that would read past the I/O ceiling produces no footer (offset past the last read line cannot be reached)", async () => {
      // Same fixture setup used for AC10. offset=2, limit=20 selects file
      // lines 2..11 (endLine clamped to 11 because totalLines = 11).
      // endLine == totalLines so the footer rule is false; the floor header
      // is the only `[` line.
      const bigRoot = mkdtempSync(join(tmpdir(), "nax-us001-"));
      const bigPath = join(bigRoot, "big.ts");
      const line = `${"x".repeat(99)}\n`;
      writeFileSync(bigPath, line.repeat(400));
      const small = { root: bigRoot, resolvedPaths: [bigPath], maxBytes: 10_000, maxFileBytes: 1_000 };

      const res = await readTool.run({ path: "big.ts", offset: 2, limit: 20 }, small);
      expect(res.isError).toBeFalsy();
      const bracketLines = res.content.split("\n").filter((l) => l.startsWith("["));
      expect(bracketLines).toEqual(["[lines 2-11 of 11+]"]);
      expect(res.content).not.toContain("more lines in file");
      expect(res.content).not.toContain("Use offset=");
    });

    test("AC14 — an unreadable file returns isError, names the cause, and adds no footer", async () => {
      const missing = join(root, "no-such-file.txt");
      const res = await readTool.run({ path: "no-such-file.txt" }, ctx([missing]));
      expect(res.isError).toBe(true);
      expect(res.content.length).toBeGreaterThan(0);
      expect(res.content).not.toContain("[");
      expect(res.content).not.toContain("more lines in file");
    });
  });
});

describe("globTool", () => {
  test("matches files by pattern, relative to the root — one group line per parent directory", async () => {
    // The grouped format renders one line per parent directory:
    // `<dir>/ <b1> <b2> ...`. Two parent directories under src/ yield exactly
    // two lines, with the basenames appearing on the line whose directory
    // prefix is their parent.
    const res = await globTool.run({ pattern: "src/**/*.ts" }, ctx([]));
    const lines = res.content.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.sort()).toEqual(["src/ a.ts", "src/deep/ b.ts"]);
  });

  test("reports no matches without erroring", async () => {
    const res = await globTool.run({ pattern: "**/*.py" }, ctx([]));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("no matches");
  });

  test("never returns a path outside the root", async () => {
    const res = await globTool.run({ pattern: "../**/*" }, ctx([]));
    expect(res.content).not.toContain("..");
  });
});
