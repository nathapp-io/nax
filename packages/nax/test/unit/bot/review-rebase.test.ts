import { describe, expect, test } from "bun:test";
import { patchIdentity } from "@/bot/review-rebase";

/** One `git diff -U0` text, with the two facts a rebase always rewrites. */
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
});
