/**
 * autoCommitIfDirty — blocked-worktree guard.
 *
 * The mutation spot-check is advisory and never fails a story, but when it
 * cannot confirm a revert the working tree holds a line it did not author.
 * Committing then captures the injected defect (and, under autoPR, pushes it),
 * so `autoCommitIfDirty` must refuse rather than sweep it in with `git add -A`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { _gitDeps, autoCommitIfDirty } from "@/utils/git";
import { cleanupTempDir, makeSpawn, makeTempDir } from "@test/helpers";

/**
 * Spawn stub that answers each git invocation by subcommand, so the guard under
 * test sees a repo that IS dirty — the only state in which a commit would run.
 */
function makeGitSpawn(gitRoot: string, calls: string[][]) {
  return makeSpawn(({ cmd }) => {
    calls.push(cmd);
    const sub = cmd[1];
    return sub === "rev-parse" ? `${gitRoot}\n` : sub === "status" ? " M src/a.ts\n" : "";
  }).spawn;
}

let origSpawn: typeof _gitDeps.spawn;
const dirs: string[] = [];

function makeRepo(): string {
  const dir = makeTempDir("nax-autocommit-test-");
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  return dir;
}

beforeEach(() => {
  origSpawn = _gitDeps.spawn;
});

afterEach(() => {
  _gitDeps.spawn = origSpawn;
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  mock.restore();
});

describe("autoCommitIfDirty — blocked worktrees", () => {
  test("commits normally when no worktree is blocked", async () => {
    const repo = makeRepo();
    const calls: string[][] = [];
    _gitDeps.spawn = makeGitSpawn(repo, calls);

    await autoCommitIfDirty(repo, "execution", "implementer", "US-001");

    expect(calls.some(([, sub]) => sub === "add")).toBe(true);
  });

  test("refuses to commit when the target tree is blocked", async () => {
    const repo = makeRepo();
    const calls: string[][] = [];
    _gitDeps.spawn = makeGitSpawn(repo, calls);

    await autoCommitIfDirty(repo, "execution", "implementer", "US-001", new Set([repo]));

    expect(calls.some(([, sub]) => sub === "add")).toBe(false);
    expect(calls.some(([, sub]) => sub === "commit")).toBe(false);
  });

  test("does not block on a linked worktree nested inside the repo path", async () => {
    // Parallel mode puts each story's worktree at `<repo>/.nax-wt/<storyId>`.
    // It sits inside the main repo BY PATH but is a separate checkout that
    // `git add -A` from the main root never stages, so a containment test here
    // would block the run-summary commit whenever any story's tree was dirty.
    const repo = makeRepo();
    const linked = join(repo, ".nax-wt", "US-002");
    mkdirSync(linked, { recursive: true });
    const calls: string[][] = [];
    _gitDeps.spawn = makeGitSpawn(repo, calls);

    await autoCommitIfDirty(repo, "execution", "implementer", "US-001", new Set([linked]));

    expect(calls.some(([, sub]) => sub === "add")).toBe(true);
  });

  test("blocks a commit made from inside the blocked worktree itself", async () => {
    const repo = makeRepo();
    const linked = join(repo, ".nax-wt", "US-002");
    mkdirSync(linked, { recursive: true });
    const calls: string[][] = [];
    // `git rev-parse --show-toplevel` inside a linked worktree answers with
    // that worktree, so this is the root the commit would stage from.
    _gitDeps.spawn = makeGitSpawn(linked, calls);

    await autoCommitIfDirty(linked, "execution", "implementer", "US-002", new Set([linked]));

    expect(calls.some(([, sub]) => sub === "add")).toBe(false);
  });

  test("refuses when the caller's workdir is a package under a blocked root", async () => {
    // The monorepo case: `git rev-parse --show-toplevel` from the package still
    // answers with the repo root, which is what the blocked set names.
    const repo = makeRepo();
    const pkg = join(repo, "src");
    const calls: string[][] = [];
    _gitDeps.spawn = makeGitSpawn(repo, calls);

    await autoCommitIfDirty(pkg, "execution", "implementer", "US-001", new Set([repo]));

    expect(calls.some(([, sub]) => sub === "add")).toBe(false);
  });

  test("does not block on an unrelated worktree", async () => {
    const repo = makeRepo();
    const other = makeRepo();
    const calls: string[][] = [];
    _gitDeps.spawn = makeGitSpawn(repo, calls);

    await autoCommitIfDirty(repo, "execution", "implementer", "US-001", new Set([other]));

    expect(calls.some(([, sub]) => sub === "add")).toBe(true);
  });

  test("an empty blocked set is treated as no block", async () => {
    const repo = makeRepo();
    const calls: string[][] = [];
    _gitDeps.spawn = makeGitSpawn(repo, calls);

    await autoCommitIfDirty(repo, "execution", "implementer", "US-001", new Set());

    expect(calls.some(([, sub]) => sub === "add")).toBe(true);
  });
});
