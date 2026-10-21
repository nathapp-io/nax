import { afterEach, describe, expect, mock, test } from "bun:test";
import { _botReviewDeps } from "@/bot/review-run";

const original = { ..._botReviewDeps };
afterEach(() => Object.assign(_botReviewDeps, original));

describe("_botReviewDeps.isAncestor", () => {
  test.each([0, 1, 2, 128])("AC-8 maps git exit %s to ancestry or an error", async (exitCode) => {
    const runGit = mock(async () => ({ exitCode, stdout: "", stderr: "git detail" }));
    Object.assign(_botReviewDeps, { runGit });
    if (exitCode < 2) expect(await _botReviewDeps.isAncestor("/checkout", "ancestor", "head")).toBe(exitCode === 0);
    else await expect(_botReviewDeps.isAncestor("/checkout", "ancestor", "head")).rejects.toThrow("[bot]");
    expect(runGit).toHaveBeenCalledWith(["merge-base", "--is-ancestor", "ancestor", "head"], "/checkout");
  });
});
