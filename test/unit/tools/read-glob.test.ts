import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globTool, readTool } from "@/tools";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nax-fs-"));
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "deep", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(root, "notes.md"), "hello\n");
});

function ctx(paths: string[], maxBytes = 10_000) {
  return { root, resolvedPaths: paths, maxBytes };
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
