/**
 * US-007 (nax#2534): a broad `.gitignore` rule hiding nax-tracked files, against
 * **real** repositories. The behaviour under test is git's — which paths
 * `check-ignore` reports and what `git add -f` stages — so a stubbed `git` would
 * only assert our own argv back at us.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { NAX_GITIGNORE_ENTRIES } from "@/utils/gitignore";
import { findIgnoredNaxTrackedPaths } from "@/utils/ignored-nax-paths";
import { commitLedger } from "@/workflow/git";

const LEDGER = ".nax/features/f/decisions.jsonl";

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

/** A committed repository (`a.txt`) whose `.gitignore` is exactly `lines`. */
async function repo(lines: readonly string[]): Promise<string> {
  const dir = makeTempDir("wf-ledger-ignored-");
  dirs.push(dir);
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  await Bun.write(join(dir, ".gitignore"), `${lines.join("\n")}\n`);
  await Bun.write(join(dir, "a.txt"), "one\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "seed");
  return dir;
}

/** The ledger an advisor appends to: created but not committed, because a rule hides it. */
async function writeLedger(dir: string): Promise<void> {
  await Bun.write(join(dir, LEDGER), '{"id":"D-1","action":{"type":"approve"}}\n');
}

const headPaths = (dir: string): Promise<string> => git(dir, "show", "--name-only", "--format=", "HEAD");

describe("commitLedger with a broad .gitignore rule (US-007)", () => {
  test("AC-2: an ignored ledger is committed anyway, and the call returns true", async () => {
    const dir = await repo([".nax/**/*.jsonl"]);
    await writeLedger(dir);
    // The premise: the rule really hides the ledger, so a plain `git add` would skip it.
    expect(await git(dir, "check-ignore", "-v", "--no-index", "--", LEDGER)).toContain(".nax/**/*.jsonl");
    const before = Number(await git(dir, "rev-list", "--count", "HEAD"));

    expect(await commitLedger(dir, "f")).toBe(true);

    expect(await git(dir, "rev-list", "--count", "HEAD")).toBe(String(before + 1));
    expect(await headPaths(dir)).toBe(LEDGER);
  });

  test("AC-3: an unrelated staged file stays staged and out of the ledger commit", async () => {
    const dir = await repo([".nax/**/*.jsonl"]);
    await writeLedger(dir);
    await Bun.write(join(dir, "a.txt"), "one\ntwo\n");
    await git(dir, "add", "--", "a.txt");

    expect(await commitLedger(dir, "f")).toBe(true);

    expect(await headPaths(dir)).toBe(LEDGER);
    expect(await git(dir, "status", "--porcelain", "--", "a.txt")).toBe("M  a.txt");
  });
});

describe("findIgnoredNaxTrackedPaths against a real repository (US-007)", () => {
  test("AC-5/AC-6: a wholesale feature-directory rule reports the ledger, spec.md and prd.json, with their rule", async () => {
    const dir = await repo(["**/.nax/features/*/"]);

    const found = await findIgnoredNaxTrackedPaths(dir);

    expect(found.map((entry) => entry.path.split("/").at(-1))).toEqual(["decisions.jsonl", "spec.md", "prd.json"]);
    // One feature's three paths, so the entries describe one project-level answer.
    expect(new Set(found.map((entry) => entry.path.split("/").slice(0, -1).join("/"))).size).toBe(1);
    for (const entry of found) {
      expect(entry.rule).toContain(".gitignore:1:**/.nax/features/*/");
    }
  });

  test("AC-7: nax's own .gitignore entries hide none of them", async () => {
    const dir = await repo(NAX_GITIGNORE_ENTRIES);

    expect(await findIgnoredNaxTrackedPaths(dir)).toEqual([]);
  });

  test("AC-8: a negation re-including the ledger leaves nothing ignored", async () => {
    const dir = await repo([".nax/**/*.jsonl", "!.nax/features/*/decisions.jsonl"]);

    expect(await findIgnoredNaxTrackedPaths(dir)).toEqual([]);
  });
});
