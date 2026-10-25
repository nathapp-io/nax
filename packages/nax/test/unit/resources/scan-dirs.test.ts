import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _resourceFsDeps, scanCommandsDir, scanSkillsDir } from "@/resources/scan-dirs";

const origin = { kind: "claude-user" } as const;
const skill = "---\ndescription: d\n---\nBody";
const originalDeps = { ..._resourceFsDeps };
let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => {
  Object.assign(_resourceFsDeps, originalDeps);
  cleanupTempDir(dir);
});

async function writeFiles(paths: string[], text: string): Promise<void> {
  await Promise.all(paths.map((path) => Bun.write(join(dir, path), text)));
}

describe("scanSkillsDir", () => {
  test("AC-9 scans only visible immediate skill directories in name order", async () => {
    await writeFiles(["b/SKILL.md", "a/SKILL.md", ".hidden/SKILL.md", "nested/deep/SKILL.md", "SKILL.md"], skill);
    const result = await scanSkillsDir(dir, origin);
    expect(result.resources.map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(result.diagnostics).toEqual([]);
  });
  test("AC-10 missing directory is empty", async () => {
    expect(await scanSkillsDir(join(dir, "missing"), origin)).toEqual({ resources: [], diagnostics: [] });
  });
  test("AC-11 caps skills at the first 500 sorted names", async () => {
    const names = Array.from({ length: 501 }, (_, i) => `s${String(i).padStart(3, "0")}`);
    await writeFiles(
      names.toReversed().map((name) => `${name}/SKILL.md`),
      skill,
    );
    const result = await scanSkillsDir(dir, origin);
    expect(result.resources.map((entry) => entry.name)).toEqual(names.slice(0, 500));
    expect(result.diagnostics).toEqual([{ severity: "warn", path: dir, origin, message: expect.any(String) }]);
  });
  test("AC-12 a failed read does not prevent later skills from loading", async () => {
    await writeFiles(["a/SKILL.md", "b/SKILL.md", "c/SKILL.md"], skill);
    const failed = join(dir, "b/SKILL.md");
    _resourceFsDeps.readFile = async (path) => {
      if (path === failed) throw new Error("read denied");
      return originalDeps.readFile(path);
    };
    const result = await scanSkillsDir(dir, origin);
    expect(result.resources.map((entry) => entry.name)).toEqual(["a", "c"]);
    expect(result.diagnostics).toEqual([
      { severity: "error", path: failed, origin, message: expect.stringContaining("read denied") },
    ]);
  });
  test("collects parser errors while continuing", async () => {
    await writeFiles(["a/SKILL.md"], "no description");
    await writeFiles(["b/SKILL.md"], skill);
    const result = await scanSkillsDir(dir, origin);
    expect(result.resources.map((entry) => entry.name)).toEqual(["b"]);
    expect(result.diagnostics).toEqual([
      { severity: "error", path: join(dir, "a/SKILL.md"), origin, message: expect.any(String) },
    ]);
  });
});

describe("scanCommandsDir", () => {
  test("AC-13 scans only top-level markdown files", async () => {
    await writeFiles(["x.md", "y.txt", "sub/z.md"], "@file");
    const result = await scanCommandsDir(dir, origin);
    expect(result.resources.map((entry) => entry.name)).toEqual(["x"]);
    expect(result.resources[0]?.template).toBe("@file");
    expect(result.diagnostics).toEqual([]);
  });
  test("AC-14 caps commands at the first 500 sorted names", async () => {
    const names = Array.from({ length: 501 }, (_, i) => `c${String(i).padStart(3, "0")}`);
    await writeFiles(
      names.toReversed().map((name) => `${name}.md`),
      "body",
    );
    const result = await scanCommandsDir(dir, origin);
    expect(result.resources.map((entry) => entry.name)).toEqual(names.slice(0, 500));
    expect(result.diagnostics).toEqual([{ severity: "warn", path: dir, origin, message: expect.any(String) }]);
  });
  test("missing directory is empty", async () => {
    expect(await scanCommandsDir(join(dir, "missing"), origin)).toEqual({ resources: [], diagnostics: [] });
  });
  test("reports listing failures", async () => {
    _resourceFsDeps.listFiles = async () => {
      throw new Error("listing denied");
    };
    expect(await scanCommandsDir(dir, origin)).toEqual({
      resources: [],
      diagnostics: [{ severity: "error", path: dir, origin, message: expect.stringContaining("listing denied") }],
    });
  });
});
