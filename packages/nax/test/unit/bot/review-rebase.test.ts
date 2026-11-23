import { describe, expect, test } from "bun:test";
import { patchIdentity } from "@/bot/review-rebase";

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
