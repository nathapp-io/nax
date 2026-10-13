import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitWithTimeout } from "@/utils/git";
import { clearNaxIndexFlags } from "@/utils/nax-index-flags";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await gitWithTimeout(args, cwd);
  return stdout;
}

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "nax-idx-"));
  dirs.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, ".nax/features/f"), { recursive: true });
  mkdirSync(join(dir, "pkg/.nax/features/g"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const p of [".nax/features/f/prd.json", "pkg/.nax/features/g/prd.json", "src/x.ts"]) {
    writeFileSync(join(dir, p), "{}\n");
  }
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "seed");
  return dir;
}

describe("clearNaxIndexFlags (#2490)", () => {
  test("clears skip-worktree on a root .nax path and warns", async () => {
    const dir = await makeRepo();
    await git(dir, "update-index", "--skip-worktree", ".nax/features/f/prd.json");
    const warnings: string[] = [];
    const cleared = await clearNaxIndexFlags(dir, { warn: (_s: string, m: string) => warnings.push(m) });
    expect(cleared).toEqual([".nax/features/f/prd.json"]);
    expect(warnings).toHaveLength(1);
    expect(await git(dir, "ls-files", "-v", "--", ".nax")).toMatch(/^H /);
  });

  test("clears assume-unchanged on a nested .nax path", async () => {
    const dir = await makeRepo();
    await git(dir, "update-index", "--assume-unchanged", "pkg/.nax/features/g/prd.json");
    const cleared = await clearNaxIndexFlags(dir, { warn: () => {} });
    expect(cleared).toEqual(["pkg/.nax/features/g/prd.json"]);
    expect(await git(dir, "ls-files", "-v", "--", "pkg/.nax")).toMatch(/^H /);
  });

  test("leaves flags on paths outside .nax alone and returns nothing", async () => {
    const dir = await makeRepo();
    await git(dir, "update-index", "--skip-worktree", "src/x.ts");
    const warnings: string[] = [];
    const cleared = await clearNaxIndexFlags(dir, { warn: (_s: string, m: string) => warnings.push(m) });
    expect(cleared).toEqual([]);
    expect(warnings).toEqual([]);
    expect(await git(dir, "ls-files", "-v", "--", "src/x.ts")).toMatch(/^S /);
  });

  test("clears an entry with both bits set (lowercase h tag)", async () => {
    const dir = await makeRepo();
    await git(dir, "update-index", "--skip-worktree", "--assume-unchanged", ".nax/features/f/prd.json");
    expect(await git(dir, "ls-files", "-v", "--", ".nax")).toMatch(/^h /);
    const cleared = await clearNaxIndexFlags(dir, { warn: () => {} });
    expect(cleared).toEqual([".nax/features/f/prd.json"]);
    expect(await git(dir, "ls-files", "-v", "--", ".nax")).toMatch(/^H /);
  });

  test("warns when git cannot list the entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nax-idx-nogit-"));
    dirs.push(dir);
    const warnings: string[] = [];
    await clearNaxIndexFlags(dir, { warn: (_s: string, m: string) => warnings.push(m) });
    expect(warnings.some((m) => m.includes("could not list"))).toBe(true);
  });

  test("returns nothing outside a git repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nax-idx-nogit-"));
    dirs.push(dir);
    expect(await clearNaxIndexFlags(dir, { warn: () => {} })).toEqual([]);
  });
});
