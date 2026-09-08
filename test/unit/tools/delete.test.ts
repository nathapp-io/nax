import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TOOL_MAX_FILE_BYTES, deleteTool } from "@/tools";
import { gitWithTimeout } from "@/utils/git";

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nax-delete-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "tracked.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "also-tracked.ts"), "export const b = 2;\n");
  await gitWithTimeout(["init", "-q", "."], root, 30_000);
  await gitWithTimeout(["config", "user.email", "t@example.com"], root, 30_000);
  await gitWithTimeout(["config", "user.name", "t"], root, 30_000);
  await gitWithTimeout(["add", "-A"], root, 30_000);
  await gitWithTimeout(["commit", "-q", "-m", "init"], root, 30_000);
});

function ctx(paths: string[]) {
  return { root, resolvedPaths: paths, maxBytes: 10_000, maxFileBytes: DEFAULT_TOOL_MAX_FILE_BYTES };
}

describe("deleteTool", () => {
  test("deletes a tracked file and names the staging step", async () => {
    const target = join(root, "src", "tracked.ts");
    const res = await deleteTool.run({ path: "src/tracked.ts" }, ctx([target]));
    expect(res.isError).toBeFalsy();
    expect(existsSync(target)).toBe(false);
    expect(res.content).toContain("GitCommit");
  });

  test("refuses an untracked file and names the tracked-only rule", async () => {
    writeFileSync(join(root, "src", "scratch.ts"), "x\n");
    const target = join(root, "src", "scratch.ts");
    const res = await deleteTool.run({ path: "src/scratch.ts" }, ctx([target]));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("not tracked by git");
    expect(res.content).toContain("tracked files only");
    expect(existsSync(target)).toBe(true);
  });

  test("refuses a directory", async () => {
    const target = join(root, "src");
    const res = await deleteTool.run({ path: "src" }, ctx([target]));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("directory");
    expect(existsSync(target)).toBe(true);
  });

  test("refuses a missing path rather than reporting success", async () => {
    const res = await deleteTool.run({ path: "src/nope.ts" }, ctx([join(root, "src", "nope.ts")]));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("does not exist");
  });

  test("refuses a file under .git, which is what makes tracked-only a boundary", async () => {
    const target = join(root, ".git", "index");
    const res = await deleteTool.run({ path: ".git/index" }, ctx([target]));
    expect(res.isError).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  test("errors when no path was resolved", async () => {
    const res = await deleteTool.run({ path: "src/tracked.ts" }, ctx([]));
    expect(res.isError).toBe(true);
  });

  test("declares its path field so the policy can gate it", () => {
    expect(deleteTool.scope.pathFields).toEqual(["path"]);
  });
});
