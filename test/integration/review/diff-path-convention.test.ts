/**
 * The review diff collectors' path convention, against a real git repository.
 *
 * `test/unit/review/diff-utils.test.ts` asserts that `--relative` appears in
 * the argv. That cannot catch the bug this exists for, and it cannot catch the
 * risk the fix introduced: `--relative` both re-spells paths AND restricts them
 * to the cwd, so an argv-shape assertion would stay green if the flag silently
 * dropped changed files out of the reviewer's view.
 *
 * The bug: git reports paths relative to the repository top-level regardless of
 * cwd. A monorepo story's reviewer has its file tools contained at the package
 * dir, so a repo-rooted "packages/lib/src/util.ts" in the prompt resolves to
 * <pkg>/packages/lib/src/util.ts and ENOENTs — one wasted round trip per file.
 *
 * So these tests run the real collectors over a real two-package repo and pin
 * git's behaviour: the spelling changes, the file SET does not, and the repo
 * root is unaffected.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { collectDiff, collectDiffStat, computeTestInventory } from "@/review";

let testDir: string;
let repo: string;
let baseSha: string;

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  return (await new Response(proc.stdout).text()).trim();
}

function write(relPath: string, contents: string): void {
  const abs = join(repo, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, contents);
}

const libDir = (): string => join(repo, "packages/lib");

beforeEach(async () => {
  testDir = makeTempDir("review-diff-paths-");
  repo = join(testDir, "repo");
  mkdirSync(repo, { recursive: true });

  await git(["init"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test User"]);

  write("packages/lib/src/util.ts", "export const trim = (s: string) => s.trim();\n");
  write("packages/app/src/index.ts", "export const cleanup = (s: string) => s;\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
  // The base is the SHA, not a branch name: `git init` picks master or main
  // depending on the host's git config, and these tests care about neither.
  baseSha = await git(["rev-parse", "HEAD"]);

  // One commit touching BOTH packages, so a cwd-scoped collector has something
  // it must exclude and a root-scoped one has something it must keep.
  write(
    "packages/lib/src/util.ts",
    "export const trim = (s: string) => s.trim();\nexport const isBlank = (s: string) => s.trim() === '';\n",
  );
  write("packages/lib/src/util.test.ts", "import { isBlank } from './util';\n");
  write(
    "packages/app/src/index.ts",
    "export const cleanup = (s: string) => s;\nexport const shout = (s: string) => s.toUpperCase();\n",
  );
  await git(["add", "."]);
  await git(["commit", "-m", "feat: work in both packages"]);
});

afterEach(() => {
  cleanupTempDir(testDir);
});

describe("review diff path convention (real git)", () => {
  test("collectDiffStat spells paths relative to a package workdir", async () => {
    const stat = await collectDiffStat(libDir(), baseSha);

    expect(stat).toContain("src/util.ts");
    expect(stat).not.toContain("packages/lib/src/util.ts");
  });

  test("collectDiffStat keeps repo-rooted spelling when the workdir IS the repo root", async () => {
    const stat = await collectDiffStat(repo, baseSha);

    expect(stat).toContain("packages/lib/src/util.ts");
    expect(stat).toContain("packages/app/src/index.ts");
  });

  test("collectDiffStat scopes to the package without dropping that package's files", async () => {
    const stat = await collectDiffStat(libDir(), baseSha);

    // Both of the package's changed files survive the re-spelling...
    expect(stat).toContain("src/util.ts");
    expect(stat).toContain("src/util.test.ts");
    // ...and the sibling package, which the contained agent could not read
    // anyway, is not offered to it.
    expect(stat).not.toContain("index.ts");
  });

  test("collectDiff emits package-relative diff headers", async () => {
    const diff = await collectDiff(libDir(), baseSha, []);

    expect(diff).not.toBeNull();
    expect(diff).toContain("a/src/util.ts");
    expect(diff).not.toContain("a/packages/lib/src/util.ts");
  });

  test("computeTestInventory reports package-relative paths and ignores sibling packages", async () => {
    const inventory = await computeTestInventory(libDir(), baseSha);

    expect(inventory.addedTestFiles).toContain("src/util.test.ts");
    for (const f of [...inventory.addedTestFiles, ...inventory.newSourceFilesWithoutTests]) {
      expect(f.startsWith("packages/")).toBe(false);
    }
  });
});
