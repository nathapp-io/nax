/**
 * The review diff collectors' path convention, against a real git repository.
 *
 * Single-frame redesign: the agent's file tools are repo-rooted, so the three
 * collectors (`collectDiff`, `collectDiffStat`, `computeTestInventory`) omit
 * `--relative` and emit repo-rooted paths like `packages/lib/src/util.ts`.
 * `test/unit/review/diff-utils.test.ts` pins the argv shape; this suite pins
 * git's actual behaviour over a real two-package repo.
 *
 * `workdir` is still the package dir (the collector's cwd), so the bare `-- .`
 * pathspec keeps output scoped to that package's subtree: the spelling is
 * repo-rooted, but the file SET stays package-scoped. These tests assert both —
 * the spelling is repo-rooted, and the sibling package is still excluded.
 *
 * (`scoped-lint.ts` is the ruled exception: it retains `--relative` because its
 * live consumer joins paths onto `workdir`; see src/review/scoped-lint.ts.)
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
  test("collectDiffStat spells repo-rooted paths even from a package workdir", async () => {
    const stat = await collectDiffStat(libDir(), baseSha);

    expect(stat).toContain("packages/lib/src/util.ts");
    expect(stat).not.toContain("packages/app/src/index.ts");
  });

  test("collectDiffStat keeps repo-rooted spelling when the workdir IS the repo root", async () => {
    const stat = await collectDiffStat(repo, baseSha);

    expect(stat).toContain("packages/lib/src/util.ts");
    expect(stat).toContain("packages/app/src/index.ts");
  });

  test("collectDiffStat scopes to the package without dropping that package's files", async () => {
    const stat = await collectDiffStat(libDir(), baseSha);

    // Both of the package's changed files survive the repo-rooted re-spelling...
    expect(stat).toContain("packages/lib/src/util.ts");
    expect(stat).toContain("packages/lib/src/util.test.ts");
    // ...and the sibling package, which the package-scoped bare `-- .` pathspec
    // excludes, is not offered to it.
    expect(stat).not.toContain("index.ts");
  });

  test("collectDiff emits repo-rooted diff headers", async () => {
    const diff = await collectDiff(libDir(), baseSha, []);

    expect(diff).not.toBeNull();
    expect(diff).toContain("a/packages/lib/src/util.ts");
    expect(diff).toContain("b/packages/lib/src/util.ts");
    // The package-scoped bare `-- .` pathspec still excludes the sibling package.
    expect(diff).not.toContain("packages/app/src/index.ts");
  });

  test("computeTestInventory reports repo-rooted paths and ignores sibling packages", async () => {
    const inventory = await computeTestInventory(libDir(), baseSha);

    expect(inventory.addedTestFiles).toContain("packages/lib/src/util.test.ts");
    for (const f of [...inventory.addedTestFiles, ...inventory.newSourceFilesWithoutTests]) {
      expect(f.startsWith("packages/lib/")).toBe(true);
      expect(f).not.toContain("packages/app/");
    }
  });
});
