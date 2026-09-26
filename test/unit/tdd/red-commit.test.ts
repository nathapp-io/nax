/**
 * commitRedState — the TDD RED commit (spec 2026-09-26-tdd-red-commit-design.md, US-001 ACs 1-11).
 * Real temp git repos; the failing pre-commit hook proves `--no-verify`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { FIELD_DESCRIPTIONS } from "@/cli/config-descriptions";
import { TddConfigSchema } from "@/config/schemas-execution";
import { _redCommitDeps, commitRedState, type RedCommitOptions } from "@/tdd/red-commit";
import { _gitDeps } from "@/utils/git";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

async function git(repo: string, args: string[]): Promise<string> {
  const proc = _gitDeps.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

/** A repo with one commit (README.md, packages/app/index.ts, .gitignore ignoring `ignored/`). */
async function makeRepo(): Promise<{ repo: string; beforeRef: string }> {
  const repo = makeTempDir("nax-red-commit-");
  dirs.push(repo);
  await git(repo, ["init", "-q"]);
  await git(repo, ["config", "user.email", "test@nax.local"]);
  await git(repo, ["config", "user.name", "Nax Test"]);
  writeFileSync(join(repo, "README.md"), "# r\n");
  writeFileSync(join(repo, ".gitignore"), "ignored/\n");
  mkdirSync(join(repo, "packages", "app"), { recursive: true });
  writeFileSync(join(repo, "packages", "app", "index.ts"), "export const a = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "init"]);
  return { repo, beforeRef: await git(repo, ["rev-parse", "HEAD"]) };
}

function failingHook(repo: string): void {
  const hook = join(repo, ".git", "hooks", "pre-commit");
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  writeFileSync(hook, "#!/bin/sh\necho 'hook rejected: typecheck failed' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
}

function writeTest(repo: string, rel = "test/a.test.ts"): void {
  mkdirSync(join(repo, rel, ".."), { recursive: true });
  writeFileSync(join(repo, rel), "test('x', () => {});\n");
}

const opts = (workdir: string, beforeRef: string, over: Partial<RedCommitOptions> = {}): RedCommitOptions => ({
  workdir,
  beforeRef,
  storyId: "US-001",
  hooks: "skip",
  dryRun: false,
  ...over,
});

describe("commitRedState", () => {
  test("AC1: commits the changed test file past a failing pre-commit hook", async () => {
    const { repo, beforeRef } = await makeRepo();
    failingHook(repo);
    writeTest(repo);
    expect(await commitRedState(opts(repo, beforeRef))).toEqual({
      status: "committed",
      files: ["test/a.test.ts"],
      hooksSkipped: true,
    });
  });

  test("AC2: the commit carries the RED message and leaves the tree clean", async () => {
    const { repo, beforeRef } = await makeRepo();
    failingHook(repo);
    writeTest(repo);
    await commitRedState(opts(repo, beforeRef));
    expect(await git(repo, ["log", "-1", "--format=%s"])).toBe(
      "chore(US-001): auto-commit after test-writer session (RED)",
    );
    expect(await git(repo, ["status", "--porcelain"])).toBe("");
  });

  test("AC3: hooks 'run' lets the hook reject the commit, softly", async () => {
    const { repo, beforeRef } = await makeRepo();
    failingHook(repo);
    writeTest(repo);
    const result = await commitRedState(opts(repo, beforeRef, { hooks: "run" }));
    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? result.reason : "").toContain("hook rejected: typecheck failed");
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(beforeRef);
  });

  test("AC4: stages only the changed paths, never an add -A of the tree", async () => {
    const { repo, beforeRef } = await makeRepo();
    writeTest(repo);
    mkdirSync(join(repo, "ignored"), { recursive: true });
    writeFileSync(join(repo, "ignored", "scratch.txt"), "x\n");
    await commitRedState(opts(repo, beforeRef));
    expect(await git(repo, ["show", "--name-only", "--format=", "HEAD"])).toBe("test/a.test.ts");
  });

  test("AC5: a changed .nax/scratchpad path is not committed beside the test file", async () => {
    const { repo, beforeRef } = await makeRepo();
    writeTest(repo);
    mkdirSync(join(repo, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(join(repo, ".nax", "scratchpad", "notes.md"), "n\n");
    const result = await commitRedState(opts(repo, beforeRef));
    expect(result.status === "committed" ? result.files : []).toEqual(["test/a.test.ts"]);
    expect(await git(repo, ["show", "--name-only", "--format=", "HEAD"])).toBe("test/a.test.ts");
  });

  test("AC6: only nax-owned changes means nothing to commit", async () => {
    const { repo, beforeRef } = await makeRepo();
    mkdirSync(join(repo, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(join(repo, ".nax", "scratchpad", "notes.md"), "n\n");
    expect(await commitRedState(opts(repo, beforeRef))).toEqual({ status: "skipped", reason: "nothing-to-commit" });
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(beforeRef);
  });

  test("AC7: files the test-writer already committed produce no second commit", async () => {
    const { repo, beforeRef } = await makeRepo();
    writeTest(repo);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "test: own commit"]);
    const head = await git(repo, ["rev-parse", "HEAD"]);
    expect(await commitRedState(opts(repo, beforeRef))).toEqual({ status: "skipped", reason: "nothing-to-commit" });
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(head);
  });

  test("AC8: dry run makes no git call at all", async () => {
    const calls: string[][] = [];
    const deps = {
      ..._redCommitDeps,
      git: async (args: string[], cwd: string, timeoutMs?: number) => {
        calls.push(args);
        return _redCommitDeps.git(args, cwd, timeoutMs);
      },
    };
    expect(await commitRedState(opts("/nonexistent", "HEAD", { dryRun: true }), deps)).toEqual({
      status: "skipped",
      reason: "dry-run",
    });
    expect(calls).toEqual([]);
  });

  test("AC9: a blocked worktree, named through a symlink, is not committed", async () => {
    const { repo, beforeRef } = await makeRepo();
    writeTest(repo);
    const linkDir = makeTempDir("nax-red-commit-link-");
    dirs.push(linkDir);
    const link = join(linkDir, "repo");
    symlinkSync(repo, link);
    expect(await commitRedState(opts(repo, beforeRef, { blockedWorktrees: new Set([link]) }))).toEqual({
      status: "skipped",
      reason: "blocked-worktree",
    });
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(beforeRef);
  });

  test("AC10: a package-subdirectory workdir stages root-relative paths", async () => {
    const { repo, beforeRef } = await makeRepo();
    writeTest(repo, "packages/app/test/b.test.ts");
    const result = await commitRedState(opts(join(repo, "packages", "app"), beforeRef));
    expect(result.status === "committed" ? result.files : []).toEqual(["packages/app/test/b.test.ts"]);
    expect(await git(repo, ["show", "--name-only", "--format=", "HEAD"])).toBe("packages/app/test/b.test.ts");
  });

  test("AC11: a throwing getChangedFiles resolves to failed, never rejects", async () => {
    const { repo, beforeRef } = await makeRepo();
    const deps = {
      ..._redCommitDeps,
      getChangedFiles: async (): Promise<string[]> => {
        throw new Error("git diff exploded");
      },
    };
    expect(await commitRedState(opts(repo, beforeRef), deps)).toEqual({
      status: "failed",
      reason: "git diff exploded",
    });
  });
});

describe("tdd.testWriterCommitHooks", () => {
  test("AC12: optional, keeps 'run', rejects other values", () => {
    expect(TddConfigSchema.parse({ maxRetries: 2 }).testWriterCommitHooks).toBeUndefined();
    expect(TddConfigSchema.parse({ maxRetries: 2, testWriterCommitHooks: "run" }).testWriterCommitHooks).toBe("run");
    expect(TddConfigSchema.safeParse({ maxRetries: 2, testWriterCommitHooks: "never" }).success).toBe(false);
  });

  test("AC17: the knob has a config description", () => {
    expect(FIELD_DESCRIPTIONS["tdd.testWriterCommitHooks"]).toBeString();
  });
});
