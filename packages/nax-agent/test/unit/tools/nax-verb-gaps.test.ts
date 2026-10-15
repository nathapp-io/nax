import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type NaxGuardContext, naxStateRefusalInText } from "#src/tools/nax-state-guard";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

let root: string;
let ctx: NaxGuardContext;
beforeEach(() => {
  root = makeTempDir("verb-gaps-");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "a");
  ctx = { root, frames: [root] };
});
afterEach(() => cleanupTempDir(root));

const cases: readonly [number, string, boolean][] = [
  [1, "git checkout HEAD -- '*.json'", true],
  [3, "git restore --source HEAD -- '.na?'", true],
  [4, "git rebase --autostash main", true],
  [5, "git pull --autostash", true],
  [6, "git merge --autostash feat", true],
  [7, "git rebase main", false],
  [8, "git rm --cached .nax/features/f/prd.json", true],
  [9, "git rm -rf .nax", true],
  [10, "git rm -r .", true],
  [12, "git rm src/a.ts", false],
  [13, "git reset -- .nax", true],
  [14, "git reset HEAD .nax/features/f/prd.json", true],
  [15, "git reset -- src/a.ts", false],
  [16, "git sparse-checkout set src", true],
  [17, "git sparse-checkout list", false],
  [18, "git stash push src/a.ts", false],
  [19, "git stash push -m wip src/a.ts", false],
  [20, "git stash push .nax/features/f/prd.json", true],
  [21, "git stash push --pathspec-from-file=list.txt", true],
  [22, "git checkout -- . ':(top,exclude,glob)**/.nax/**'", false],
];

describe("run-state verb gaps", () => {
  for (const command of [
    "git rm -- '*.json'",
    "git reset HEAD -- '[a-z].json'",
    "git restore -- 'src/*'",
    "git sparse-checkout disable",
    "git sparse-checkout reapply",
    "git reset -- packages",
    "git stash push --message wip .nax/features/f/prd.json",
    "git stash push --pathspec-from-file=list.txt -- src/a.ts",
    "git stash push --pathspec-from-file list.txt -- . ':(top,exclude,glob)**/.nax/**'",
  ]) {
    test(`additional refusal: ${command}`, () => {
      mkdirSync(join(root, "packages/a/.nax"), { recursive: true });
      expect(naxStateRefusalInText(command, ctx)).toBeDefined();
    });
  }
  for (const command of [
    "git rebase --autostash main",
    "git pull --autostash",
    "git merge --autostash feat",
    "git rm -rf .nax",
    "git reset -- .nax",
    "git sparse-checkout set src",
    "git restore -- '*.json'",
    "git rm -- '[a-z]'",
    "git reset -- '*.json'",
  ]) {
    test(`no nearby state allows: ${command}`, () => {
      expect(naxStateRefusalInText(command, ctx)).toBeUndefined();
    });
  }
  test("git -C uses effective frames to resolve rm ancestor", () => {
    mkdirSync(join(root, "packages/a/.nax"), { recursive: true });
    expect(naxStateRefusalInText("git -C packages rm -r a", ctx)).toBeDefined();
  });
  test("stash message values are not paths, and a message alone cannot exempt", () => {
    mkdirSync(join(root, ".nax"));
    expect(naxStateRefusalInText("git stash push --message .nax src/a.ts", ctx)).toBeUndefined();
    expect(naxStateRefusalInText("git stash push -m src/a.ts", ctx)).toBeDefined();
  });
  for (const [ac, command, refused] of cases) {
    test(`AC-${ac}: ${command}`, () => {
      mkdirSync(join(root, ".nax"));
      const reason = naxStateRefusalInText(command, ctx);
      if (refused) expect(reason).toBeDefined();
      else expect(reason).toBeUndefined();
    });
  }
  test("AC-2: glob without nearby .nax is allowed", () => {
    expect(naxStateRefusalInText("git checkout HEAD -- '*.json'", ctx)).toBeUndefined();
  });
  test("AC-11: rm ancestor of nested .nax refuses", () => {
    mkdirSync(join(root, "packages/a/.nax"), { recursive: true });
    expect(naxStateRefusalInText("git rm -r packages", ctx)).toBeDefined();
  });
});
