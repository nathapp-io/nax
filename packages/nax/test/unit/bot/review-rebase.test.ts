import { describe, expect, mock, test } from "bun:test";
import type { botGit } from "@/bot/git";
import { makePatchEquivalent, patchIdentity } from "@/bot/review-rebase";

/** One `git diff` text, with the two facts a rebase always rewrites. */
function diff(index: string, header: string, added: string): string {
  return [
    "diff --git a/src/a.ts b/src/a.ts",
    `index ${index} 100644`,
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    header,
    added,
  ].join("\n");
}

const ORIGINAL = diff("1111111..2222222", "@@ -1,2 +1,3 @@", "+const added = 1;");

/** One `git diff` text for a binary change: git prints no content, only that the two differ. */
function binaryDiff(index: string): string {
  return [
    "diff --git a/logo.bin b/logo.bin",
    `index ${index} 100644`,
    "Binary files a/logo.bin and b/logo.bin differ",
  ].join("\n");
}

describe("patchIdentity", () => {
  test("AC-9 ignores index lines and the line numbers of hunk headers", () => {
    const rebased = diff("3333333..4444444", "@@ -40,2 +41,3 @@", "+const added = 1;");
    expect(patchIdentity(rebased)).toBe(patchIdentity(ORIGINAL));
    expect(patchIdentity(rebased)).toBeString();
  });

  test("AC-10 differs when the added lines differ", () => {
    const changed = diff("1111111..2222222", "@@ -1,2 +1,3 @@", "+const added = 2;");
    expect(patchIdentity(changed)).not.toBe(patchIdentity(ORIGINAL));
  });

  test("AC-11 returns null for an empty diff", () => {
    expect(patchIdentity("")).toBeNull();
  });

  // B1: the diff spells out no content for a binary change, so two different binaries look identical.
  test("B1 answers null for a binary change instead of a content-free identity", () => {
    expect(patchIdentity(binaryDiff("1111111..2222222"))).toBeNull();
    expect(patchIdentity(binaryDiff("3333333..4444444"))).toBeNull();
  });

  // B2: reducing a header to `@@` dropped the function scope, so the same line in another function
  // compared equal and its review was skipped.
  test("B2 keeps the hunk's function scope, so the same added line elsewhere is a different patch", () => {
    const first = diff("1111111..2222222", "@@ -1,0 +2 @@ function first() {", "+  bypass();");
    const second = diff("1111111..2222222", "@@ -5,0 +6 @@ function second() {", "+  bypass();");
    expect(patchIdentity(first)).toBeString();
    expect(patchIdentity(first)).not.toBe(patchIdentity(second));
  });

  // B2: the counts survive a rebase and say how much the hunk changed, so they stay in the identity.
  test("B2 keeps the hunk's line counts", () => {
    const from = diff("1111111..2222222", "@@ -1,2 +1,3 @@", "+const added = 1;");
    const larger = diff("1111111..2222222", "@@ -1,2 +1,4 @@", "+const added = 1;");
    expect(patchIdentity(from)).not.toBe(patchIdentity(larger));
  });

  // B2: with context lines in the diff, the surrounding code pins where the change sits.
  test("B2 keeps the surrounding context lines", () => {
    const here = ["@@ -1,3 +1,4 @@", " first();", "+added();", " second();", " third();"].join("\n");
    const elsewhere = ["@@ -1,3 +1,4 @@", " moved();", "+added();", " second();", " third();"].join("\n");
    expect(patchIdentity(here)).not.toBe(patchIdentity(elsewhere));
  });
});

const RANGE_A = { base: "a".repeat(40), head: "b".repeat(40) };
const RANGE_B = { base: "c".repeat(40), head: "d".repeat(40) };

/** One insertion, with git's three lines of context on each side and accurate hunk counts. */
const INSERTION = [
  "diff --git a/f.js b/f.js",
  "index 1111111..2222222 100644",
  "--- a/f.js",
  "+++ b/f.js",
  "@@ -3,6 +3,7 @@ function choose(flag) {",
  "     alpha();",
  "     beta();",
  "     gamma();",
  "+    bypass();",
  "     seed();",
  "     stepA();",
  "     stepB();",
].join("\n");

/** The file the hunk's window occurs in once: one branch, so the replaced block fits one place. */
const ONE_BRANCH = [
  "function choose(flag) {",
  "  if (flag) {",
  "    alpha();",
  "    beta();",
  "    gamma();",
  "    seed();",
  "    stepA();",
  "    stepB();",
  "  }",
  "}",
  "",
].join("\n");

/** The same window twice: the second branch repeats the first, so the hunk fits both of them (B2). */
const TWO_BRANCHES = [
  "function choose(flag) {",
  "  if (flag) {",
  "    alpha();",
  "    beta();",
  "    gamma();",
  "    seed();",
  "    stepA();",
  "    stepB();",
  "  } else {",
  "    alpha();",
  "    beta();",
  "    gamma();",
  "    seed();",
  "    stepA();",
  "    stepB();",
  "  }",
  "}",
  "",
].join("\n");

/** A git stand-in that answers `diff` with the patch and `show` with the file the hunk replaced. */
function rebaseRun(shown: {
  readonly stdout: string;
  readonly exitCode: number;
}): ReturnType<typeof mock<typeof botGit>> {
  return mock<typeof botGit>(async (args: string[]) =>
    args[0] === "show" ? { ...shown, stderr: "" } : { stdout: INSERTION, stderr: "", exitCode: 0 },
  );
}

describe("makePatchEquivalent", () => {
  test("B2 treats the patch as equivalent when its window locates the change once", async () => {
    const run = rebaseRun({ stdout: ONE_BRANCH, exitCode: 0 });
    expect(await makePatchEquivalent(run)("dir", RANGE_A, RANGE_B)).toBe(true);
    expect(run.mock.calls.some(([args]) => args[0] === "show")).toBe(true);
  });

  // B2: two ranges whose hunk text matches still describe different changes when that text fits the
  // file more than once — the change may have moved from one copy to the other.
  test("B2 reviews in full when the window fits more than one place in the file", async () => {
    const run = rebaseRun({ stdout: TWO_BRANCHES, exitCode: 0 });
    expect(await makePatchEquivalent(run)("dir", RANGE_A, RANGE_B)).toBe(false);
  });

  // An unreadable blob leaves the location unverified: the full review is the safe answer.
  test("B2 reviews in full when the change's file cannot be read", async () => {
    const run = rebaseRun({ stdout: "", exitCode: 1 });
    expect(await makePatchEquivalent(run)("dir", RANGE_A, RANGE_B)).toBe(false);
  });
});
