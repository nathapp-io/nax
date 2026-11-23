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

/** A binary file: the leading NUL byte is what makes git print `Binary files ... differ`. */
async function writeBytes(name: string, content: Uint8Array): Promise<void> {
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

/** Two functions, so the same added line can be moved from one scope into the other (B2). */
const FUNCTIONS = "function first() {\n  return 1;\n}\n\nfunction second() {\n  return 2;\n}\n";
const BYPASS_IN_FIRST = FUNCTIONS.replace("  return 1;", "  bypass();\n  return 1;");
const BYPASS_IN_SECOND = FUNCTIONS.replace("  return 2;", "  bypass();\n  return 2;");

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

  // B1: the default diff spells out no content for a binary change, so both ranges' diffs read
  // `Binary files ... differ` and dropping the `index ` line left nothing to tell them apart.
  test("B1 answers false for two different binary contents at the rebased head", async () => {
    await git(["checkout", "-b", "bin-topic", base]);
    await writeBytes("logo.bin", new Uint8Array([0, 3, 4]));
    const binaryHead = await commit("binary topic");
    await git(["checkout", "-b", "bin-rebased", laterBase]);
    await writeBytes("logo.bin", new Uint8Array([0, 9, 9]));
    const binaryRebased = await commit("binary rebased");
    const equivalent = makePatchEquivalent(botGit);
    expect(await equivalent(repo, { base, head: binaryHead }, { base: laterBase, head: binaryRebased })).toBe(false);
  });

  // B2: reducing each hunk header to `@@` erased the function scope, so the same added line moved from
  // `first()` to `second()` compared equal and the review was skipped.
  test("B2 answers false when the same added line sits in another function at the rebased head", async () => {
    await git(["checkout", "-b", "fn-base", base]);
    await write("f.js", FUNCTIONS);
    const fnBase = await commit("functions");
    await git(["checkout", "-b", "fn-first", fnBase]);
    await write("f.js", BYPASS_IN_FIRST);
    const inFirst = await commit("bypass in first");
    // The later base changed another file; the same insertion now sits in second().
    await git(["checkout", "-b", "fn-later", fnBase]);
    await write("b.txt", "b\nlater functions base\n");
    const fnLaterBase = await commit("later functions base");
    await write("f.js", BYPASS_IN_SECOND);
    const inSecond = await commit("bypass in second");
    const equivalent = makePatchEquivalent(botGit);
    expect(await equivalent(repo, { base: fnBase, head: inFirst }, { base: fnLaterBase, head: inSecond })).toBe(false);
  });
});
