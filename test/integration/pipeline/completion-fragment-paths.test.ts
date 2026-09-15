/**
 * `getDiffFilePaths` — the story fragment's "Files touched" list, against a
 * real git repository.
 *
 * nax writes run state to a repo-root `.nax/` AND to a per-package
 * `<pkg>/.nax/` during a run, and both are git-tracked while the run is in
 * flight. The fragment collector applied no exclusions at all, so a generated
 * cache file landed in a completed story's "Files touched" and was then
 * offered to a dependent story as something worth reading (#2072).
 *
 * An argv-shape assertion cannot pin this. The excludes that look obviously
 * correct do not work: `:!.nax/` and even the nested `:(glob,exclude)` form are
 * interpreted relative to the *cwd*, so run from `packages/lib` they hide that
 * package's `.nax/` and leave the repo-root one visible. Only the `top`-magic
 * forms are anchored at the repository root and behave identically from either
 * cwd — which is the property the fragment needs, since `workdir` is the repo
 * root for a single-package repo and a package dir for a monorepo story.
 *
 * So this runs the real collector over a real repo carrying `.nax/` at both
 * depths, from both cwds, and pins git's matching semantics.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _completionDeps } from "@/pipeline/stages/completion";

const ROOT_ARTIFACT = ".nax/cache/root-state.json";
const PACKAGE_ARTIFACT = "packages/lib/.nax/cache/test-patterns.json";
const LIB_CODE = "packages/lib/src/util.ts";
const APP_CODE = "packages/app/src/index.ts";

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

beforeEach(async () => {
  testDir = makeTempDir("completion-fragment-paths-");
  repo = join(testDir, "repo");
  mkdirSync(repo, { recursive: true });

  await git(["init"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test User"]);

  write("README.md", "# fixture\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
  // The base is the SHA, not a branch name: `git init` picks master or main
  // depending on the host's git config, and this test cares about neither.
  baseSha = await git(["rev-parse", "HEAD"]);

  // One commit carrying nax artifacts at BOTH depths plus genuine source in
  // two packages.
  write(ROOT_ARTIFACT, '{"run":1}\n');
  write(PACKAGE_ARTIFACT, '{"patterns":[]}\n');
  write(LIB_CODE, "export const isBlank = (s: string) => s.trim() === '';\n");
  write(APP_CODE, "export const shout = (s: string) => s.toUpperCase();\n");
  await git(["add", "."]);
  await git(["commit", "-m", "feat: work plus nax artifacts"]);
});

afterEach(() => {
  cleanupTempDir(testDir);
});

describe("getDiffFilePaths — nax artifact exclusion (real git)", () => {
  test("excludes .nax at BOTH depths when run from the repo root", async () => {
    const files = await _completionDeps.getDiffFilePaths(repo, baseSha);

    expect(files.has(ROOT_ARTIFACT)).toBe(false);
    expect(files.has(PACKAGE_ARTIFACT)).toBe(false);
  });

  test("excludes .nax at BOTH depths when run from a package workdir", async () => {
    const files = await _completionDeps.getDiffFilePaths(join(repo, "packages/lib"), baseSha);

    // The per-package artifact is the one observed leaking into a real run's
    // fragment; the repo-root one is the half a cwd-relative pathspec misses.
    expect(files.has(PACKAGE_ARTIFACT)).toBe(false);
    expect(files.has(ROOT_ARTIFACT)).toBe(false);
  });

  test("keeps every genuine source file, including other packages", async () => {
    const fromRoot = await _completionDeps.getDiffFilePaths(repo, baseSha);
    const fromPackage = await _completionDeps.getDiffFilePaths(join(repo, "packages/lib"), baseSha);

    for (const files of [fromRoot, fromPackage]) {
      expect(files.has(LIB_CODE)).toBe(true);
      // A fragment names where a dependency landed, so a sibling package's
      // file must survive — the exclusion must not double as a cwd scope.
      expect(files.has(APP_CODE)).toBe(true);
    }
  });

  test("paths stay repo-rooted from either cwd, so the fragment is cwd-independent", async () => {
    const fromRoot = await _completionDeps.getDiffFilePaths(repo, baseSha);
    const fromPackage = await _completionDeps.getDiffFilePaths(join(repo, "packages/lib"), baseSha);

    expect([...fromPackage].sort()).toEqual([...fromRoot].sort());
  });
});
