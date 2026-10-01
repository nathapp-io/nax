/**
 * autoCommitIfDirty — blocked-worktree guard.
 *
 * The mutation spot-check is advisory and never fails a story, but when it
 * cannot confirm a revert the working tree holds a line it did not author.
 * Committing then captures the injected defect (and, under autoPR, pushes it),
 * so `autoCommitIfDirty` must refuse rather than sweep it in with `git add -A`.
 *
 * Also covers captureDiffSummary (MED-04); both suites share the same
 * `_gitDeps.spawn` save/restore hook, so they live under one file.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeSpawn, makeTempDir } from "@test/helpers";
import { _gitDeps, autoCommitIfDirty, captureDiffSummary } from "@/utils/git";

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

function mockSpawnOutput(output: string, exitCode = 0): typeof Bun.spawn {
  return makeSpawn(() => ({ stdout: output, exitCode })).spawn;
}

describe("captureDiffSummary", () => {
  test("returns empty string when baseRef is undefined", async () => {
    const result = await captureDiffSummary("/tmp/repo", undefined);
    expect(result).toEqual("");
  });

  test("returns the diff --stat output when baseRef is set", async () => {
    _gitDeps.spawn = mockSpawnOutput("src/index.ts | 3 +-\n1 file changed, 2 insertions(+), 1 deletion(-)\n");
    const result = await captureDiffSummary("/tmp/repo", "abc123");
    expect(result).toContain("src/index.ts");
  });

  test("scopes to scopePrefix when provided", async () => {
    let capturedArgs: string[] = [];
    _gitDeps.spawn = makeSpawn((call) => {
      capturedArgs = call.cmd;
      return "apps/api/src/index.ts | 1 +\n";
    }).spawn;
    await captureDiffSummary("/tmp/repo", "abc123", "apps/api");
    expect(capturedArgs).toContain("--");
    expect(capturedArgs).toContain("apps/api/");
  });

  test("returns empty string on git spawn failure (non-fatal)", async () => {
    _gitDeps.spawn = mock(() => {
      throw new Error("git not found");
    });
    const result = await captureDiffSummary("/tmp/repo", "abc123");
    expect(result).toEqual("");
  });

  // MED-04: captureDiffSummary previously spawned raw git with no deadline —
  // now routes through gitWithTimeout (same _gitDeps.spawn injection point).
  // A non-zero exit now correctly discards stray stdout instead of
  // returning it as a summary.
  test("MED-04: discards stdout when git diff --stat exits non-zero", async () => {
    _gitDeps.spawn = mockSpawnOutput("src/stale.ts | 1 +\n", 128);
    const result = await captureDiffSummary("/tmp/repo", "abc123");
    expect(result).toEqual("");
  });

  test("caps output at 30 lines", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `file${i}.ts | 1 +`);
    _gitDeps.spawn = mockSpawnOutput(`${lines.join("\n")}\n`);
    const result = await captureDiffSummary("/tmp/repo", "abc123");
    expect(result.split("\n").length).toBeLessThanOrEqual(30);
    expect(result).toContain("more files");
  });
});
