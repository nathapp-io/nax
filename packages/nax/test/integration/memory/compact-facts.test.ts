/**
 * compact-facts.test.ts — the repository facts a compaction is given.
 *
 * Covers AC-1..AC-9: the commit subjects newest first, the local branch names, the
 * 300-subject cap, a merge commit's subject without the merged side branch's own
 * commits, the feature story counts read from each `prd.json`, the directories a
 * read leaves out, and the empty lists a directory outside git with no feature tree
 * returns.
 *
 * Every case builds a real directory and reads it through the real `git` and
 * `prd.json` readers; nothing here stubs the seams (those cases live in
 * `test/unit/memory/compact-facts.test.ts`), so what is asserted is that the facts
 * match what is actually on disk and in the history.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { featuresDir } from "@/config";
import { readMemoryCompactFacts } from "@/memory";
import { gitWithTimeout } from "@/utils/git";

/** A git identity the fixtures commit under, passed per command so no repo config is written. */
const IDENTITY = ["-c", "user.email=compact-facts@example.invalid", "-c", "user.name=Compact Facts"];

/** Epoch second the seeded history starts at; each chain commit is one second later. */
const CHAIN_EPOCH_SECONDS = 1_700_000_000;

/** A `prd.json` whose stories are the given pass states, in order. */
function prdJson(passes: readonly boolean[]): string {
  return JSON.stringify({
    feature: "fixture",
    userStories: passes.map((passed, index) => ({
      id: `US-${String(index + 1).padStart(3, "0")}`,
      title: `story ${index + 1}`,
      passes: passed,
      status: passed ? "passed" : "pending",
      acceptanceCriteria: ["the fixture holds"],
    })),
  });
}

/** Run one git command in `dir`, throwing when git itself refused. */
async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout, exitCode, stderr } = await gitWithTimeout(args, dir, 30_000);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout;
}

/** An empty repository whose commits carry the fixture identity. */
async function initRepo(dir: string): Promise<void> {
  await git(dir, "init", "-q");
}

/** One empty commit, so a fixture history needs no file writes. */
async function commit(dir: string, subject: string): Promise<void> {
  await git(dir, ...IDENTITY, "commit", "--allow-empty", "-q", "-m", subject);
}

/**
 * Seed `count` commits on `branch` in one `git fast-import` process, oldest first,
 * each subject `commit <n>`.
 *
 * 305 sequential `git commit` spawns cost the suite seconds; fast-import builds the
 * same first-parent chain from a single stream in tens of milliseconds. The chain is
 * linear by construction, so it is also a first-parent chain.
 */
async function seedCommitChain(dir: string, branch: string, count: number): Promise<void> {
  const stream: string[] = ["blob", "mark :1", "data 2", "x", ""];
  for (let n = 1; n <= count; n += 1) {
    const subject = `commit ${n}`;
    stream.push(`commit refs/heads/${branch}`);
    stream.push(`mark :${n + 1}`);
    stream.push(`committer Compact Facts <compact-facts@example.invalid> ${CHAIN_EPOCH_SECONDS + n} +0000`);
    stream.push(`data ${subject.length}`, subject);
    if (n > 1) stream.push(`from :${n}`);
    stream.push("M 100644 :1 f.txt", "");
  }
  // `stdout` is ignored, not piped: nothing reads it, and an undrained pipe blocks the
  // child once it fills, which would hang this test until the suite's per-test timeout
  // reaped it as a dangling process instead of failing with a message. stderr is piped
  // because it is drained concurrently below and is what names a refusal.
  const proc = Bun.spawn(["git", "fast-import", "--quiet"], {
    cwd: dir,
    stdin: Buffer.from(stream.join("\n")),
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`git fast-import failed: ${stderr.trim()}`);
}

/** Write `<root>/.nax/features/<name>/prd.json`; `content` of `null` leaves the file out. */
function writeFeature(root: string, name: string, content: string | null): void {
  const dir = join(featuresDir(root), name);
  mkdirSync(dir, { recursive: true });
  if (content !== null) writeFileSync(join(dir, "prd.json"), content);
}

const tempDirs: string[] = [];

/** A fresh directory this file owns and cleans up. */
function tempDir(): string {
  const dir = makeTempDir("nax-compact-facts-");
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

describe("readMemoryCompactFacts in a repository with two commits", () => {
  let root: string;
  let currentBranch: string;

  beforeEach(async () => {
    root = tempDir();
    await initRepo(root);
    await commit(root, "seed the repository");
    await commit(root, "add the second commit");
    currentBranch = (await git(root, "symbolic-ref", "--short", "HEAD")).trim();
  });

  // AC-1
  test("returns both commit subjects, newest first", async () => {
    const facts = await readMemoryCompactFacts(root);

    expect(facts.commits).toEqual(["add the second commit", "seed the repository"]);
  });

  // AC-2
  test("holds the current branch name", async () => {
    const facts = await readMemoryCompactFacts(root);

    expect(facts.branches).toContain(currentBranch);
  });
});

// AC-3
test("keeps exactly the 300 newest subjects from a 305-commit history", async () => {
  const root = tempDir();
  await initRepo(root);
  const branch = (await git(root, "symbolic-ref", "--short", "HEAD")).trim();
  await seedCommitChain(root, branch, 305);

  const facts = await readMemoryCompactFacts(root);

  expect(facts.commits).toHaveLength(300);
  expect(facts.commits[0]).toBe("commit 305");
  expect(facts.commits.at(-1)).toBe("commit 6");
  expect(facts.commits).not.toContain("commit 5");
});

describe("readMemoryCompactFacts with a merge commit on HEAD", () => {
  let root: string;

  beforeEach(async () => {
    root = tempDir();
    await initRepo(root);
    await commit(root, "base work");
    const base = (await git(root, "symbolic-ref", "--short", "HEAD")).trim();
    await git(root, "checkout", "-q", "-b", "side");
    await commit(root, "side work one");
    await commit(root, "side work two");
    await git(root, "checkout", "-q", base);
    await git(root, ...IDENTITY, "merge", "--no-ff", "-q", "-m", "Merge branch side into the base", "side");
  });

  // AC-4
  test("holds the merge commit's subject", async () => {
    const facts = await readMemoryCompactFacts(root);

    expect(facts.commits).toContain("Merge branch side into the base");
  });

  // AC-5
  test("does not hold the merged side branch's own commit subjects", async () => {
    const facts = await readMemoryCompactFacts(root);

    expect(facts.commits).not.toContain("side work one");
    expect(facts.commits).not.toContain("side work two");
  });
});

describe("readMemoryCompactFacts feature facts", () => {
  // AC-6
  test("counts a feature's passed stories", async () => {
    const root = tempDir();
    writeFeature(root, "a", prdJson([true, false]));

    const facts = await readMemoryCompactFacts(root);

    expect(facts.features).toEqual([{ name: "a", passed: 1, total: 2 }]);
  });

  // AC-7
  test("leaves out a feature directory whose prd.json is missing", async () => {
    const root = tempDir();
    writeFeature(root, "a", prdJson([true, false]));
    writeFeature(root, "b", null);

    const facts = await readMemoryCompactFacts(root);

    expect(facts.features).toEqual([{ name: "a", passed: 1, total: 2 }]);
  });

  // AC-8
  test("leaves out a feature directory whose prd.json is not valid JSON", async () => {
    const root = tempDir();
    writeFeature(root, "a", prdJson([true, false]));
    writeFeature(root, "c", "{ this is not JSON");

    const facts = await readMemoryCompactFacts(root);

    expect(facts.features).toEqual([{ name: "a", passed: 1, total: 2 }]);
  });
});

// AC-9
test("returns empty features, branches and commits outside a git repository with no feature tree", async () => {
  const root = tempDir();

  const facts = await readMemoryCompactFacts(root);

  expect(facts.features).toEqual([]);
  expect(facts.branches).toEqual([]);
  expect(facts.commits).toEqual([]);
});
