import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertNaxError, cleanupTempDir, makeTempDir } from "@test/helpers";
import { buildBranchPackageReadingNote } from "@/prompts";
import { ALWAYS_EXCLUDED } from "@/review";
import {
  changedFilesSince,
  commitLedger,
  listUncommitted,
  readHead,
  writeBranchReviewPackage,
  writeReviewPackage,
} from "@/workflow/git";
import { _workflowDeps } from "@/workflow/step-context";

const dirs: string[] = [];
const origGit = _workflowDeps.git;
afterEach(async () => {
  _workflowDeps.git = origGit;
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

async function repo(): Promise<string> {
  const dir = makeTempDir("wf-git-");
  dirs.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  await Bun.write(join(dir, "a.txt"), "one\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "seed");
  return dir;
}

describe("workflow git helpers", () => {
  test("changedFilesSince lists names from base..HEAD and throws on a git failure", async () => {
    _workflowDeps.git = async () => ({ stdout: "src/a.ts\nsrc/b.ts\n", exitCode: 0 });
    expect(await changedFilesSince("/repo", "abc")).toEqual(["src/a.ts", "src/b.ts"]);
    _workflowDeps.git = async () => ({ stdout: "", stderr: "bad revision", exitCode: 128 });
    await expect(changedFilesSince("/repo", "abc")).rejects.toThrow("bad revision");
  });

  test("package: commit list, stat and a -U10 diff; .nax excluded", async () => {
    const dir = await repo();
    const base = await readHead(dir);
    await Bun.write(join(dir, "a.txt"), "one\ntwo\n");
    await Bun.write(join(dir, ".nax", "x.json"), "{}");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "feat: two");
    const path = join(dir, "out", "package-0.diff");
    await writeReviewPackage(dir, base, path);
    const text = await Bun.file(path).text();
    expect(text).toContain("## Commits");
    expect(text).toContain("feat: two");
    expect(text).toContain("## Stat");
    expect(text).toContain("a.txt");
    expect(text).toContain("+two");
    expect(text).not.toContain(".nax/x.json");
  });

  test("package: a small diff has no omitted-files section", async () => {
    const dir = await repo();
    const base = await readHead(dir);
    await Bun.write(join(dir, "a.txt"), "two\n");
    await git(dir, "commit", "-qam", "feat: two");
    const path = join(dir, "out", "package-0.diff");
    await writeReviewPackage(dir, base, path);
    expect(await Bun.file(path).text()).not.toContain("## Files not shown in the diff");
  });

  test("package: a truncated diff lists every omitted file by its full path (nax#2486)", async () => {
    const dir = await repo();
    const base = await readHead(dir);
    const filler = `${"x".repeat(120)}\n`.repeat(60);
    for (let i = 0; i < 12; i++) await Bun.write(join(dir, `src/a-${String(i).padStart(2, "0")}.ts`), filler);
    const migration = "web/api/prisma/migrations/20261013000000_long_feature_name/migration.sql";
    await Bun.write(join(dir, migration), "CREATE TABLE t (note VARCHAR(191));\n");
    await Bun.write(join(dir, "zz/late.ts"), "export const late = 1;\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "feat: big");
    const path = join(dir, "out", "package-0.diff");
    await writeReviewPackage(dir, base, path);
    const text = await Bun.file(path).text();
    const section = text.slice(text.indexOf("## Files not shown in the diff"));
    expect(text).toContain("## Files not shown in the diff");
    expect(section).toContain(`- ${migration}`);
    expect(section).toContain("- zz/late.ts");
    expect(section).not.toContain("src/a-00.ts");
    expect(section.match(/\(partially shown\)/g)).toHaveLength(1);
  });

  test("package: a shown type change (file to symlink) counts as one file (nax#2486)", async () => {
    const dir = await repo();
    await Bun.write(join(dir, "aa-tc.txt"), "plain\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "seed: tc");
    const base = await readHead(dir);
    await git(dir, "rm", "-q", "aa-tc.txt");
    expect(await Bun.spawn(["ln", "-s", "a.txt", join(dir, "aa-tc.txt")]).exited).toBe(0);
    const filler = `${"x".repeat(120)}\n`.repeat(60);
    for (let i = 0; i < 12; i++) await Bun.write(join(dir, `src/a-${String(i).padStart(2, "0")}.ts`), filler);
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "feat: big");
    const path = join(dir, "out", "package-0.diff");
    await writeReviewPackage(dir, base, path);
    const text = await Bun.file(path).text();
    const section = text.slice(text.indexOf("## Files not shown in the diff"));
    expect(text.match(/^diff --git a\/aa-tc\.txt /gm)).toHaveLength(2);
    const partial = section.match(/^- (.+) \(partially shown\)$/m)?.[1];
    const kept = (text.match(/^diff --git a\/(src\/\S+) /gm) ?? []).length;
    expect(partial).toBe(`src/a-${String(kept - 1).padStart(2, "0")}.ts`);
  });

  test("package: a shown rename is not listed; a non-ASCII omitted path is listed verbatim (nax#2486)", async () => {
    const dir = await repo();
    await Bun.write(join(dir, "aa/old.ts"), "export const kept = 'a stable body long enough to detect a rename';\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "seed: old");
    const base = await readHead(dir);
    await git(dir, "mv", "aa/old.ts", "aa/new.ts");
    const filler = `${"x".repeat(120)}\n`.repeat(60);
    for (let i = 0; i < 12; i++) await Bun.write(join(dir, `src/a-${String(i).padStart(2, "0")}.ts`), filler);
    await Bun.write(join(dir, "zz/café.ts"), "export const late = 1;\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "feat: big");
    const path = join(dir, "out", "package-0.diff");
    await writeReviewPackage(dir, base, path);
    const text = await Bun.file(path).text();
    const section = text.slice(text.indexOf("## Files not shown in the diff"));
    expect(text).toContain("rename to aa/new.ts");
    expect(section).not.toContain("aa/new.ts");
    expect(section).not.toContain("aa/old.ts");
    expect(section).toContain("- zz/café.ts");
  });

  test("package: an unknown from ref throws WORKFLOW_REVIEW_PACKAGE_FAILED and writes nothing", async () => {
    const dir = await repo();
    const path = join(dir, "out", "package-0.diff");
    const err = await writeReviewPackage(dir, "deadbeef", path).then(
      () => undefined,
      (e: unknown) => e,
    );
    assertNaxError(err);
    expect(err.code).toBe("WORKFLOW_REVIEW_PACKAGE_FAILED");
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("listUncommitted names modified and untracked files, not .nax", async () => {
    const dir = await repo();
    await Bun.write(join(dir, "a.txt"), "changed\n");
    await Bun.write(join(dir, "b.txt"), "new\n");
    await Bun.write(join(dir, ".nax", "y.json"), "{}");
    expect((await listUncommitted(dir)).sort((a, b) => a.localeCompare(b))).toEqual(["a.txt", "b.txt"]);
  });
});

/** US-007 (nax#2534): the argv the ledger commit uses. What git then does with `-f` in a
 *  repository whose `.gitignore` hides the ledger is `test/integration/workflow/ledger-ignored.test.ts`. */
describe("commitLedger argv", () => {
  test("AC-1: stages the ledger with `add -f`, so an ignore rule cannot skip it", async () => {
    const dir = makeTempDir("wf-ledger-argv-");
    dirs.push(dir);
    await Bun.write(join(dir, ".nax", "features", "f", "decisions.jsonl"), '{"id":"D-1"}\n');
    const calls: string[][] = [];
    _workflowDeps.git = async (args) => {
      calls.push(args);
      return { stdout: "", exitCode: args[0] === "diff" ? 1 : 0 };
    };

    expect(await commitLedger(dir, "f")).toBe(true);

    expect(calls[0]).toEqual(["add", "-f", "--", ".nax/features/f/decisions.jsonl"]);
  });
});

/** The `## <heading>` block of a written package, up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start === -1) throw new Error(`no ${heading} section in:\n${text}`);
  const rest = text.slice(start + heading.length);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Stub `_workflowDeps.git` for the branch package writer, recording every argv.
 * `nameStatus` is the raw `--name-status -z` stdout; log/stat default to empty.
 */
function stubBranchGit(nameStatus: string, over: { log?: string; stat?: string; exitCode?: number } = {}): string[][] {
  const calls: string[][] = [];
  _workflowDeps.git = async (args) => {
    calls.push(args);
    const exitCode = over.exitCode ?? 0;
    const stderr = exitCode === 0 ? undefined : "bad revision";
    if (args[0] === "log") return { stdout: over.log ?? "", ...(stderr ? { stderr } : {}), exitCode };
    if (args.includes("--name-status")) return { stdout: nameStatus, ...(stderr ? { stderr } : {}), exitCode };
    return { stdout: over.stat ?? "", ...(stderr ? { stderr } : {}), exitCode };
  };
  return calls;
}

function tempPackagePath(): string {
  const dir = makeTempDir("wf-branch-pkg-");
  dirs.push(dir);
  return join(dir, "package-branch.diff");
}

describe("writeBranchReviewPackage", () => {
  test("lists each changed file with its status letter and no diff body (AC-1)", async () => {
    const path = tempPackagePath();
    const calls = stubBranchGit("M\0src/a.ts\0A\0src/b.ts\0");
    const paths = await writeBranchReviewPackage("/repo", "seed0", path);
    const text = await Bun.file(path).text();
    const changed = section(text, "## Changed files (2)");
    expect(changed).toContain("- M src/a.ts");
    expect(changed).toContain("- A src/b.ts");
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(text).not.toContain("## Diff");
    expect(calls.length).toBeGreaterThan(0);
  });

  test("a rename record prints its old and new path (AC-2)", async () => {
    const path = tempPackagePath();
    stubBranchGit("R087\0src/old.ts\0src/new.ts\0");
    await writeBranchReviewPackage("/repo", "seed0", path);
    const text = await Bun.file(path).text();
    expect(section(text, "## Changed files (1)")).toContain("- R src/old.ts -> src/new.ts");
  });

  test("the commit list follows the range heading (AC-3)", async () => {
    const path = tempPackagePath();
    stubBranchGit("", { log: "abc1234 feat: one\ndef5678 feat: two\n" });
    await writeBranchReviewPackage("/repo", "seed0", path);
    const text = await Bun.file(path).text();
    expect(section(text, "## Commits (seed0..HEAD)")).toContain("abc1234 feat: one\ndef5678 feat: two");
  });

  test("never asks git for a unified diff (AC-4)", async () => {
    const path = tempPackagePath();
    const calls = stubBranchGit("M\0src/a.ts\0");
    await writeBranchReviewPackage("/repo", "seed0", path);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.flat().filter((arg) => arg.startsWith("--unified="))).toEqual([]);
  });

  test("every diff call excludes the nax-owned paths (AC-5)", async () => {
    const path = tempPackagePath();
    const calls = stubBranchGit("M\0src/a.ts\0");
    await writeBranchReviewPackage("/repo", "seed0", path);
    const diffCalls = calls.filter((args) => args[0] === "diff");
    expect(diffCalls.length).toBeGreaterThan(0);
    for (const args of diffCalls) {
      for (const excluded of ALWAYS_EXCLUDED) expect(args).toContain(excluded);
    }
  });

  test("a copy record prints its source and destination (AC-6)", async () => {
    const path = tempPackagePath();
    stubBranchGit("C075\0src/base.ts\0src/copy.ts\0M\0src/a.ts\0");
    await writeBranchReviewPackage("/repo", "seed0", path);
    const text = await Bun.file(path).text();
    expect(section(text, "## Changed files (2)")).toContain("- C src/base.ts -> src/copy.ts");
  });

  test("returns the surviving changed paths, a copy as its new path (AC-7)", async () => {
    const path = tempPackagePath();
    stubBranchGit("C075\0src/base.ts\0src/copy.ts\0M\0src/a.ts\0");
    expect(await writeBranchReviewPackage("/repo", "seed0", path)).toEqual(["src/copy.ts", "src/a.ts"]);
  });

  test("drops deletions and returns a rename under its new path (AC-8)", async () => {
    const path = tempPackagePath();
    stubBranchGit("M\0src/a.ts\0D\0src/c.ts\0R100\0src/old.ts\0src/new.ts\0");
    expect(await writeBranchReviewPackage("/repo", "seed0", path)).toEqual(["src/a.ts", "src/new.ts"]);
  });

  test("a failing git call rejects with WORKFLOW_REVIEW_PACKAGE_FAILED (AC-9)", async () => {
    const path = tempPackagePath();
    stubBranchGit("", { exitCode: 128 });
    const err = await writeBranchReviewPackage("/repo", "seed0", path).then(
      () => undefined,
      (e: unknown) => e,
    );
    assertNaxError(err);
    expect(err.code).toBe("WORKFLOW_REVIEW_PACKAGE_FAILED");
  });

  test("carries the shared how-to-read-the-diff note (AC-15)", async () => {
    const path = tempPackagePath();
    stubBranchGit("M\0src/a.ts\0");
    await writeBranchReviewPackage("/repo", "seed0", path);
    const text = await Bun.file(path).text();
    expect(text).toContain(buildBranchPackageReadingNote("seed0..HEAD"));
  });
});
