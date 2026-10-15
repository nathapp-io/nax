import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitWithTimeout } from "#src/internal/git-exec";
import { _naxStateGuardDeps } from "#src/tools/nax-stash-restore";
import { naxStateRefusalInText } from "#src/tools/nax-state-guard";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

let root: string;
const git = async (...args: string[]) => {
  const result = await gitWithTimeout(args, root);
  expect(result.exitCode).toBe(0);
  return result.stdout;
};
const checkCommand = (command: string) => naxStateRefusalInText(command, { root, frames: [root] });
const check = () => checkCommand("git stash pop");

beforeEach(async () => {
  root = makeTempDir("stash-real-git-");
  mkdirSync(join(root, ".nax/features/f"), { recursive: true });
  writeFileSync(join(root, ".nax/features/f/prd.json"), "{}\n");
  writeFileSync(join(root, ".nax/features/f/é.json"), "{}\n");
  writeFileSync(join(root, "a.ts"), "original\n");
  await git("init");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  await git("add", ".");
  await git("commit", "-m", "fixture", "--no-verify");
});
afterEach(() => cleanupTempDir(root));

test("AC-20: default git dep allows a source-only stash", async () => {
  writeFileSync(join(root, "a.ts"), "changed\n");
  await git("stash", "push", "--", "a.ts");
  expect(check()).toBeUndefined();
});

test("AC-21: NUL listing catches a non-ASCII .nax path", async () => {
  writeFileSync(join(root, ".nax/features/f/é.json"), "changed\n");
  await git("stash", "push");
  expect(check()).toBeDefined();
  expect(check()).toContain("`pop` or `apply` of a stash that holds no `.nax` path");
  expect(
    _naxStateGuardDeps.git(root, [
      "stash",
      "show",
      "-z",
      "--name-only",
      "--no-renames",
      "--include-untracked",
      "stash@{0}",
    ]),
  ).toContain(".nax/features/f/é.json\0");
});

test("AC-22: no-renames exposes the deleted .nax source", async () => {
  await git("mv", ".nax/features/f/prd.json", "moved.json");
  await git("stash", "push");
  expect(check()).toBeDefined();
  expect(check()).toContain("`pop` or `apply` of a stash that holds no `.nax` path");
  expect(
    _naxStateGuardDeps.git(root, [
      "stash",
      "show",
      "-z",
      "--name-only",
      "--no-renames",
      "--include-untracked",
      "stash@{0}",
    ]),
  ).toContain(".nax/features/f/prd.json\0");
});

test("default git dep fails closed on invalid refs and cwd", () => {
  expect(_naxStateGuardDeps.git(root, ["stash", "show", "stash@{999}"])).toBeUndefined();
  expect(_naxStateGuardDeps.git(join(root, "absent"), ["status"])).toBeUndefined();
});

test("directory listing includes ignored, deeply nested .nax files", async () => {
  mkdirSync(join(root, "src/deep/a/b/c/.nax"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "src/\n");
  writeFileSync(join(root, "src/deep/a/b/c/.nax/prd.json"), "state");
  expect(naxStateRefusalInText("git stash push -- src", { root, frames: [root] })).toBeDefined();
  expect(_naxStateGuardDeps.git(root, ["ls-files", "-z", "--cached", "--others", "--", "src"])).toContain(
    "src/deep/a/b/c/.nax/prd.json\0",
  );
});

test("untracked .nax stash content is inspected", async () => {
  writeFileSync(join(root, ".nax/untracked.json"), "state");
  await git("stash", "push", "--include-untracked");
  expect(check()).toBeDefined();
  expect(check()).toContain("`pop` or `apply` of a stash that holds no `.nax` path");
  expect(
    _naxStateGuardDeps.git(root, [
      "stash",
      "show",
      "-z",
      "--name-only",
      "--no-renames",
      "--include-untracked",
      "stash@{0}",
    ]),
  ).toContain(".nax/untracked.json\0");
});

/**
 * B1: a `.nax` change that is staged and then reverted in the WORKING TREE only.
 * `git stash show` lists the stash's working-tree snapshot, which matches HEAD for
 * that path, so the old guard saw a clean listing and allowed `pop --index` — and
 * git then wrote the stale `.nax` content back into the index. Without `--index`
 * the index snapshot is never replayed, so that restore stays allowed.
 */
test("B1: a staged .nax change reversed in the working tree refuses an --index restore", async () => {
  const prd = join(root, ".nax/features/f/prd.json");
  writeFileSync(prd, '{ "staged": true }\n');
  await git("add", ".nax/features/f/prd.json");
  writeFileSync(prd, "{}\n");
  writeFileSync(join(root, "a.ts"), "changed\n");
  await git("stash", "push");

  const listing = _naxStateGuardDeps.git(root, [
    "stash",
    "show",
    "-z",
    "--name-only",
    "--no-renames",
    "--include-untracked",
    "stash@{0}",
  ]);
  expect(listing).toContain("a.ts\0");
  expect(listing).not.toContain(".nax");

  // Plain pop drops the staged snapshot instead of replaying it; --index replays it.
  expect(checkCommand("git stash pop")).toBeUndefined();
  expect(checkCommand("git stash pop --index")).toBeDefined();
  expect(checkCommand("git stash pop --index")).toContain("`pop` or `apply` of a stash that holds no `.nax` path");
});
