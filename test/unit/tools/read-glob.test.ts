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

function ctx(paths: string[], maxBytes = 10_000) {
  return { root, resolvedPaths: paths, maxBytes, maxFileBytes: DEFAULT_TOOL_MAX_FILE_BYTES };
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

  test("truncates beyond maxBytes and says so", async () => {
    const res = await readTool.run({ path: "src/a.ts" }, ctx([join(root, "src", "a.ts")], 5));
    expect(res.content.length).toBeLessThan(60);
    expect(res.content).toContain("truncated");
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

    test("no range supplied is byte-identical to today's whole-prefix read", async () => {
      const withRange = await readTool.run({ path: "many.txt" }, ctx([manyPath]));
      const noInput = await readTool.run({}, ctx([manyPath]));
      expect(withRange.content).toBe(noInput.content);
      expect(withRange.content).toContain("line 1");
      expect(withRange.content).toContain("line 50");
      expect(withRange.content).not.toContain("[lines");
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

    test("truncation at maxBytes still applies to a ranged read", async () => {
      const res = await readTool.run({ path: "many.txt", offset: 1, limit: 50 }, ctx([manyPath], 10));
      expect(res.content).toContain("truncated");
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
});

describe("globTool", () => {
  test("matches files by pattern, relative to the root", async () => {
    const res = await globTool.run({ pattern: "src/**/*.ts" }, ctx([]));
    const lines = res.content.trim().split("\n").sort();
    expect(lines).toEqual(["src/a.ts", "src/deep/b.ts"]);
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
