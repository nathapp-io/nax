/**
 * Unit tests for autoCommitIfDirty
 *
 * Covers monorepo subdir guard: workdir = git root, workdir = subdir (monorepo), and unrelated dir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTempDir, makeLogger, makeSpawn, makeTempDir, withDepsRestore } from "@test/helpers";
import { _gitDeps, autoCommitIfDirty } from "@/utils/git";
import { gitSpawnEnv } from "@/utils/git-env";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("autoCommitIfDirty", () => {
  const calls: { cmd: string[]; cwd?: string }[] = [];

  withDepsRestore(_gitDeps, ["spawn"]);
  beforeEach(() => {
    calls.length = 0;
  });

  // nax#1808: a dry run reached the completion phase and auto-committed the
  // PRD it had just marked passed, plus any unrelated dirty file, because
  // `git add -A` is unscoped. The refusal lives here rather than at each call
  // site so a future caller cannot silently reintroduce it -- the same
  // reasoning the `blockedWorktrees` guard above is built on.
  test("refuses to commit under a dry run", async () => {
    const gitRoot = "/repo";
    _gitDeps.spawn = makeSpawn(({ cmd, opts }) => {
      calls.push({ cmd, cwd: opts.cwd as string | undefined });
      if (cmd.includes("rev-parse")) return `${gitRoot}\n`;
      if (cmd.includes("status")) return " M src/foo.ts\n";
      if (cmd.includes("--cached")) return { exitCode: 1 }; // staged
      return "";
    }).spawn;

    await autoCommitIfDirty(gitRoot, "run.complete", "run-summary", "US-001", undefined, true);

    expect(calls.some((c) => c.cmd.includes("add"))).toBe(false);
    expect(calls.some((c) => c.cmd.includes("commit"))).toBe(false);
  });

  test("commits when workdir is the git root", async () => {
    const gitRoot = "/repo";
    _gitDeps.spawn = makeSpawn(({ cmd, opts }) => {
      calls.push({ cmd, cwd: opts.cwd as string | undefined });
      if (cmd.includes("rev-parse")) return `${gitRoot}\n`;
      if (cmd.includes("status")) return " M src/foo.ts\n";
      if (cmd.includes("--cached")) return { exitCode: 1 }; // staged
      return "";
    }).spawn;

    await autoCommitIfDirty(gitRoot, "tdd", "implementer", "US-001");

    const addCall = calls.find((c) => c.cmd.includes("add"));
    expect(addCall).toBeDefined();
    expect(calls.some((c) => c.cmd.includes("commit"))).toBe(true);
  });

  test("commits using 'git add -A' from gitRoot even when workdir is a monorepo package subdir", async () => {
    // Regression: previously used 'git add .' from packageDir, which silently
    // skipped files outside packageDir (e.g. monorepo root package.json after
    // 'bun add'), leaving them permanently dirty and causing false-positive
    // escalations in the review dirty-file check.
    const gitRoot = "/repo";
    const workdir = "/repo/apps/cli";
    _gitDeps.spawn = makeSpawn(({ cmd, opts }) => {
      calls.push({ cmd, cwd: opts.cwd as string | undefined });
      if (cmd.includes("rev-parse")) return `${gitRoot}\n`;
      if (cmd.includes("status")) return " M src/config.ts\n";
      if (cmd.includes("--cached")) return { exitCode: 1 }; // staged
      return "";
    }).spawn;

    await autoCommitIfDirty(workdir, "tdd", "implementer", "US-004");

    const addCall = calls.find((c) => c.cmd.includes("add"));
    expect(addCall?.cmd).toEqual(["git", "add", "-A", "--", ":/"]);
    expect(addCall?.cwd).toBe(gitRoot);
    expect(calls.some((c) => c.cmd.includes("commit"))).toBe(true);
  });

  test("uses 'git add -A' from gitRoot when workdir is the repo root", async () => {
    const gitRoot = "/repo";
    _gitDeps.spawn = makeSpawn(({ cmd, opts }) => {
      calls.push({ cmd, cwd: opts.cwd as string | undefined });
      if (cmd.includes("rev-parse")) return `${gitRoot}\n`;
      if (cmd.includes("status")) return " M src/index.ts\n";
      if (cmd.includes("--cached")) return { exitCode: 1 }; // staged
      return "";
    }).spawn;

    await autoCommitIfDirty(gitRoot, "tdd", "test-writer", "US-001");

    const addCall = calls.find((c) => c.cmd.includes("add"));
    expect(addCall?.cmd).toEqual(["git", "add", "-A", "--", ":/"]);
    expect(addCall?.cwd).toBe(gitRoot);
  });

  test("skips commit when workdir is unrelated to git root", async () => {
    const gitRoot = "/other-repo";
    const workdir = "/my-project";
    _gitDeps.spawn = makeSpawn(({ cmd, opts }) => {
      calls.push({ cmd, cwd: opts.cwd as string | undefined });
      if (cmd.includes("rev-parse")) return `${gitRoot}\n`;
      return "";
    }).spawn;

    await autoCommitIfDirty(workdir, "tdd", "implementer", "US-001");

    expect(calls.some((c) => c.cmd.includes("commit"))).toBe(false);
  });

  test("skips commit when working tree is clean", async () => {
    const gitRoot = "/repo";
    _gitDeps.spawn = makeSpawn(({ cmd, opts }) => {
      calls.push({ cmd, cwd: opts.cwd as string | undefined });
      if (cmd.includes("rev-parse")) return `${gitRoot}\n`;
      if (cmd.includes("status")) return ""; // clean
      return "";
    }).spawn;

    await autoCommitIfDirty(gitRoot, "tdd", "implementer", "US-001");

    expect(calls.some((c) => c.cmd.includes("commit"))).toBe(false);
  });

  // Issue 5 (#369): warn→debug when auto-committing after agent session
  test("logs at debug level (not warn) when auto-committing dirty files", async () => {
    const gitRoot = "/repo";
    _gitDeps.spawn = makeSpawn(({ cmd, opts }) => {
      calls.push({ cmd, cwd: opts.cwd as string | undefined });
      if (cmd.includes("rev-parse")) return `${gitRoot}\n`;
      if (cmd.includes("status")) return " M src/foo.ts\n";
      if (cmd.includes("--cached")) return { exitCode: 1 }; // staged
      return "";
    }).spawn;

    const logger = makeLogger();
    const origGetSafeLogger = _gitDeps.getSafeLogger;
    _gitDeps.getSafeLogger = () => logger;

    try {
      await autoCommitIfDirty(gitRoot, "tdd", "implementer", "US-001");
      expect(logger.calls.some((c) => c.level === "warn")).toBe(false);
      expect(logger.calls.some((c) => c.level === "debug")).toBe(true);
    } finally {
      _gitDeps.getSafeLogger = origGetSafeLogger;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Real git — never-committed .nax/ paths (#2303)
// ─────────────────────────────────────────────────────────────────────────────
//
// A path that was staged and then deleted from the worktree (`AD`) is not in
// HEAD. The auto-commit used to `git checkout` it back as "agent-deleted nax
// state", and `git add -A` then staged the resurrected file. The suites above
// stub spawn, so none of them can see the resulting tree; this one runs git and
// asserts on the tree.

const decoder = new TextDecoder();
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function git(dir: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: dir, env: gitSpawnEnv() });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${proc.exitCode}: ${decoder.decode(proc.stderr)}`);
  }
  return decoder.decode(proc.stdout);
}

function write(dir: string, rel: string, content: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

/** A repo with one committed file (`.nax/committed.json`) and an identity. */
function makeRepo(): string {
  const dir = makeTempDir("nax-autocommit-ad-");
  dirs.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "nax-test@example.com"]);
  git(dir, ["config", "user.name", "nax test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  write(dir, "README.md", "# fixture\n");
  write(dir, ".nax/committed.json", "{}\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

/** Stage `rel`, then delete it from disk: porcelain shows `AD`. */
function stageThenDelete(dir: string, rel: string): void {
  write(dir, rel, "{}\n");
  git(dir, ["add", "--", rel]);
  rmSync(join(dir, rel));
}

describe("autoCommitIfDirty — never-committed .nax/ paths (real git)", () => {
  test("does not resurrect an AD path, and the commit carries only the real change", async () => {
    const repo = makeRepo();
    const scratch = "test/tmp-fixture/case/.nax/config.json";
    stageThenDelete(repo, scratch);
    write(repo, "src/a.ts", "export const a = 1;\n");
    expect(git(repo, ["status", "--porcelain"])).toContain(`AD ${scratch}`);

    await autoCommitIfDirty(repo, "execution", "implementer", "US-001");

    expect(existsSync(join(repo, scratch))).toBe(false);
    expect(git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n")).toContain("src/a.ts");
    expect(git(repo, ["ls-tree", "-r", "--name-only", "HEAD"])).not.toContain(scratch);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
  });

  test("still restores a genuine deletion of a committed .nax/ file", async () => {
    // The guard must not swallow the case the restore exists for.
    const repo = makeRepo();
    rmSync(join(repo, ".nax/committed.json"));
    write(repo, "src/a.ts", "export const a = 1;\n");

    await autoCommitIfDirty(repo, "execution", "implementer", "US-001");

    expect(existsSync(join(repo, ".nax/committed.json"))).toBe(true);
    expect(git(repo, ["ls-tree", "-r", "--name-only", "HEAD"])).toContain(".nax/committed.json");
    expect(git(repo, ["status", "--porcelain"])).toBe("");
  });

  test("restores the committed deletion and skips the AD path when both are present", async () => {
    const repo = makeRepo();
    const scratch = ".nax/features/x/prd.json";
    rmSync(join(repo, ".nax/committed.json"));
    stageThenDelete(repo, scratch);
    write(repo, "src/a.ts", "export const a = 1;\n");

    await autoCommitIfDirty(repo, "execution", "implementer", "US-001");

    expect(existsSync(join(repo, ".nax/committed.json"))).toBe(true);
    expect(existsSync(join(repo, scratch))).toBe(false);
    expect(git(repo, ["ls-tree", "-r", "--name-only", "HEAD"])).not.toContain(scratch);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
  });
});
