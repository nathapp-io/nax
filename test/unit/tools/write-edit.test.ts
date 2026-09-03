import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool, writeTool } from "@/tools";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nax-write-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "const a = 1;\nconst b = 2;\n");
});

function ctx(paths: string[]) {
  return { root, resolvedPaths: paths, maxBytes: 10_000 };
}

describe("writeTool", () => {
  test("writes file contents", async () => {
    const target = join(root, "src", "new.ts");
    const res = await writeTool.run({ path: "src/new.ts", content: "x\n" }, ctx([target]));
    expect(res.isError).toBeFalsy();
    expect(readFileSync(target, "utf8")).toBe("x\n");
  });

  test("creates missing parent directories", async () => {
    const target = join(root, "src", "deep", "nested", "n.ts");
    await writeTool.run({ path: "src/deep/nested/n.ts", content: "y\n" }, ctx([target]));
    expect(existsSync(target)).toBe(true);
  });

  test("overwrites an existing file", async () => {
    const target = join(root, "src", "a.ts");
    await writeTool.run({ path: "src/a.ts", content: "replaced\n" }, ctx([target]));
    expect(readFileSync(target, "utf8")).toBe("replaced\n");
  });

  test("declares its path field so the policy can gate it", () => {
    expect(writeTool.scope.pathFields).toEqual(["path"]);
  });
});

describe("editTool", () => {
  test("replaces an exact match", async () => {
    const target = join(root, "src", "a.ts");
    const res = await editTool.run(
      { path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 99;" },
      ctx([target]),
    );
    expect(res.isError).toBeFalsy();
    expect(readFileSync(target, "utf8")).toContain("const a = 99;");
  });

  // A stale match is an ERROR, not a denial: the policy said yes, the file
  // simply is not what the model believed.
  test("a match that is not present is an error", async () => {
    const target = join(root, "src", "a.ts");
    const res = await editTool.run({ path: "src/a.ts", old_string: "const zzz = 0;", new_string: "x" }, ctx([target]));
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/not found/i);
  });

  test("an ambiguous match is an error rather than a guess", async () => {
    const target = join(root, "src", "dup.ts");
    writeFileSync(target, "same\nsame\n");
    const res = await editTool.run({ path: "src/dup.ts", old_string: "same", new_string: "other" }, ctx([target]));
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/2 times|ambiguous/i);
  });

  test("leaves the file untouched when the edit fails", async () => {
    const target = join(root, "src", "a.ts");
    const before = readFileSync(target, "utf8");
    await editTool.run({ path: "src/a.ts", old_string: "nope", new_string: "x" }, ctx([target]));
    expect(readFileSync(target, "utf8")).toBe(before);
  });
});
