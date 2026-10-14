/**
 * US-003 AC-1…AC-4: the advisor-ledger-only commit against a **real** temporary repository.
 * The behaviour under test is git's — what ends up in the commit and what does not — so a
 * fake `_workflowDeps.git` would only assert our own argv back at us.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { commitLedger } from "@/workflow/git";

const LEDGER = ".nax/features/f/decisions.jsonl";
const MESSAGE = "chore(f): advisor decisions";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err}`);
  return out.trim();
}

/** One line appended the way the ledger appends it (never a rewrite). */
async function appendLine(dir: string, id: string): Promise<void> {
  const path = join(dir, LEDGER);
  const text = await Bun.file(path).text();
  await Bun.write(path, `${text}${JSON.stringify({ id, action: { type: "approve" } })}\n`);
}

/** HEAD already carries the ledger (and `a.txt`), so the next ledger edit is a real change. */
async function repo(opts: { ledger?: boolean } = {}): Promise<string> {
  const dir = makeTempDir("wf-ledger-");
  dirs.push(dir);
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  await Bun.write(join(dir, "a.txt"), "one\n");
  if (opts.ledger !== false) await Bun.write(join(dir, LEDGER), '{"id":"D-1","action":{"type":"approve"}}\n');
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "seed");
  return dir;
}

const commitCount = async (dir: string): Promise<number> => Number(await git(dir, "rev-list", "--count", "HEAD"));
const headPaths = (dir: string): Promise<string> => git(dir, "show", "--name-only", "--format=", "HEAD");

describe("commitLedger (US-003)", () => {
  test("AC-1: an edited ledger becomes one commit touching only the ledger", async () => {
    const dir = await repo();
    const before = await commitCount(dir);
    await appendLine(dir, "D-2");
    expect(await commitLedger(dir, "f")).toBe(true);
    expect(await commitCount(dir)).toBe(before + 1);
    expect(await git(dir, "log", "-1", "--format=%s")).toBe(MESSAGE);
    expect(await headPaths(dir)).toBe(LEDGER);
  });

  test("AC-2: an unrelated modified tracked file stays modified and uncommitted", async () => {
    const dir = await repo();
    await Bun.write(join(dir, "a.txt"), "one\ntwo\n");
    await appendLine(dir, "D-2");
    expect(await commitLedger(dir, "f")).toBe(true);
    expect(await headPaths(dir)).toBe(LEDGER);
    expect(await git(dir, "status", "--porcelain", "--", "a.txt")).toBe("M a.txt");
  });

  // The pathspec commit (not a plain `git commit`) is what keeps this out; a regression to the latter
  // would sweep the staged edit into the ledger commit.
  test("AC-2 follow-up: an unrelated staged edit is not swept into the commit either", async () => {
    const dir = await repo();
    await Bun.write(join(dir, "a.txt"), "one\ntwo\n");
    await git(dir, "add", "--", "a.txt");
    await appendLine(dir, "D-2");
    expect(await commitLedger(dir, "f")).toBe(true);
    expect(await headPaths(dir)).toBe(LEDGER);
    expect(await git(dir, "status", "--porcelain", "--", "a.txt")).toBe("M  a.txt");
  });

  test("AC-3: an unchanged ledger makes no commit", async () => {
    const dir = await repo();
    const before = await commitCount(dir);
    expect(await commitLedger(dir, "f")).toBe(false);
    expect(await commitCount(dir)).toBe(before);
  });

  test("AC-4: a missing ledger returns false and does not throw", async () => {
    const dir = await repo({ ledger: false });
    const before = await commitCount(dir);
    expect(await commitLedger(dir, "f")).toBe(false);
    expect(await commitCount(dir)).toBe(before);
  });
});
