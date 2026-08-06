/**
 * autoCommitIfDirty — blocked-worktree guard.
 *
 * The mutation spot-check is advisory and never fails a story, but when it
 * cannot confirm a revert the working tree holds a line it did not author.
 * Committing then captures the injected defect (and, under autoPR, pushes it),
 * so `autoCommitIfDirty` must refuse rather than sweep it in with `git add -A`.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _gitDeps, autoCommitIfDirty } from "@/utils/git";

/**
 * Spawn stub that answers each git invocation by subcommand, so the guard under
 * test sees a repo that IS dirty — the only state in which a commit would run.
 */
function makeSpawn(gitRoot: string, calls: string[][]) {
  return mock((args: string[], _opts: unknown) => {
    calls.push(args);
    const sub = args[1];
    const out = sub === "rev-parse" ? `${gitRoot}\n` : sub === "status" ? " M src/a.ts\n" : "";
    const bytes = new TextEncoder().encode(out);
    return {
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      exited: Promise.resolve(0),
      kill: mock(() => {}),
    };
  });
}

let origSpawn: typeof _gitDeps.spawn;
const dirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "nax-autocommit-test-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  return dir;
}

beforeEach(() => {
  origSpawn = _gitDeps.spawn;
});

afterEach(() => {
  _gitDeps.spawn = origSpawn;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  mock.restore();
});

describe("autoCommitIfDirty — blocked worktrees", () => {
  test("commits normally when no worktree is blocked", async () => {
    const repo = makeRepo();
    const calls: string[][] = [];
    _gitDeps.spawn = makeSpawn(repo, calls);

    await autoCommitIfDirty(repo, "execution", "implementer", "US-001");

    expect(calls.some(([, sub]) => sub === "add")).toBe(true);
  });

  test("refuses to commit when the target tree is blocked", async () => {
    const repo = makeRepo();
    const calls: string[][] = [];
    _gitDeps.spawn = makeSpawn(repo, calls);

    await autoCommitIfDirty(repo, "execution", "implementer", "US-001", new Set([repo]));

    expect(calls.some(([, sub]) => sub === "add")).toBe(false);
    expect(calls.some(([, sub]) => sub === "commit")).toBe(false);
  });

  test("refuses when the blocked tree is a package inside the git root", async () => {
    // Staging is `git add -A` from the git ROOT, so a blocked package deeper in
    // the repo would still be swept into the commit.
    const repo = makeRepo();
    const pkg = join(repo, "src");
    const calls: string[][] = [];
    _gitDeps.spawn = makeSpawn(repo, calls);

    await autoCommitIfDirty(repo, "execution", "implementer", "US-001", new Set([pkg]));

    expect(calls.some(([, sub]) => sub === "add")).toBe(false);
  });

  test("refuses when the caller's workdir is a package under a blocked root", async () => {
    const repo = makeRepo();
    const pkg = join(repo, "src");
    const calls: string[][] = [];
    _gitDeps.spawn = makeSpawn(repo, calls);

    await autoCommitIfDirty(pkg, "execution", "implementer", "US-001", new Set([repo]));

    expect(calls.some(([, sub]) => sub === "add")).toBe(false);
  });

  test("does not block on an unrelated worktree", async () => {
    const repo = makeRepo();
    const other = makeRepo();
    const calls: string[][] = [];
    _gitDeps.spawn = makeSpawn(repo, calls);

    await autoCommitIfDirty(repo, "execution", "implementer", "US-001", new Set([other]));

    expect(calls.some(([, sub]) => sub === "add")).toBe(true);
  });

  test("an empty blocked set is treated as no block", async () => {
    const repo = makeRepo();
    const calls: string[][] = [];
    _gitDeps.spawn = makeSpawn(repo, calls);

    await autoCommitIfDirty(repo, "execution", "implementer", "US-001", new Set());

    expect(calls.some(([, sub]) => sub === "add")).toBe(true);
  });
});
