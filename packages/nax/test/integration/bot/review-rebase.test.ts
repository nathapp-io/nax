import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { botGit } from "@/bot/git";
import { makePatchEquivalent } from "@/bot/review-rebase";

let repo: string;

async function git(argv: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...argv], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${argv.join(" ")}: ${err}`);
  return out.trim();
}

async function write(name: string, content: string): Promise<void> {
  await Bun.write(join(repo, name), content);
}

async function commit(message: string): Promise<string> {
  await git(["add", "."]);
  await git(["commit", "-m", message]);
  return git(["rev-parse", "HEAD"]);
}

/** `a.txt` touched by the topic commit, `b.txt` by the later base commit a rebase lands on. */
const BASE_FILE = "line1\nline2\nline3\n";
const TOPIC_FILE = "line1\nline2\nline3\ntopic\n";
const LATER_FILE = "line1\nline2\nline3\nother change\n";

let base: string;
let reviewedHead: string;
let laterBase: string;
let rebased: string;
let edited: string;

beforeEach(async () => {
  repo = makeTempDir("bot-review-rebase-");
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await write("a.txt", BASE_FILE);
  await write("b.txt", "b\n");
  base = await commit("base");

  await git(["checkout", "-b", "topic"]);
  await write("a.txt", TOPIC_FILE);
  reviewedHead = await commit("topic");

  await git(["checkout", "main"]);
  await write("b.txt", "b\nlater base\n");
  laterBase = await commit("later base");

  // The same patch, replayed onto the later base: a rebase of the reviewed commit.
  await git(["checkout", "-b", "rebased", laterBase]);
  await git(["cherry-pick", reviewedHead]);
  rebased = await git(["rev-parse", "HEAD"]);

  // The same commit replayed with one changed line: a rebase that also edited the patch.
  await git(["checkout", "-b", "edited", laterBase]);
  await write("a.txt", LATER_FILE);
  edited = await commit("edited topic");
});

describe("makePatchEquivalent", () => {
  afterEach(() => {
    cleanupTempDir(repo);
  });

  test("AC-12 treats a commit and its rebase onto a later base as the same patch", async () => {
    const equivalent = makePatchEquivalent(botGit);
    expect(await equivalent(repo, { base, head: reviewedHead }, { base: laterBase, head: rebased })).toBe(true);
  });

  test("AC-13 reports a rebased patch that differs by one line as a different patch", async () => {
    const equivalent = makePatchEquivalent(botGit);
    expect(await equivalent(repo, { base, head: reviewedHead }, { base: laterBase, head: edited })).toBe(false);
  });

  test("AC-14 answers false, without rejecting, when a range names a commit the repository does not have", async () => {
    const equivalent = makePatchEquivalent(botGit);
    const missing = "0".repeat(40);
    expect(await equivalent(repo, { base: missing, head: reviewedHead }, { base: laterBase, head: rebased })).toBe(
      false,
    );
  });
});
