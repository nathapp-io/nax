import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeBotFixEnv, makeLogger, withTempDir } from "@test/helpers";
import { ledgerPath } from "@/advisor";
import { botGit } from "@/bot/git";
import { _ledgerCarryDeps, ledgerStep } from "@/bot/ledger-carry";
import { PROJECT_FEATURES_DIR } from "@/config";

const original = { ..._ledgerCarryDeps };
afterEach(() => Object.assign(_ledgerCarryDeps, original));

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await botGit(args, cwd);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

describe("ledgerStep", () => {
  test.each([false, true])("AC-15: failed real commit leaves clean worktree (ledger absent=%s)", async (absent) => {
    await withTempDir(async (root) => {
      const repo = join(root, "main");
      const worktree = join(root, "pr");
      await Bun.write(join(repo, "README.md"), "fixture");
      await git(repo, ["init", "-b", "main"]);
      await git(repo, ["config", "user.email", "test@example.com"]);
      await git(repo, ["config", "user.name", "Test"]);
      if (!absent) await Bun.write(ledgerPath(repo, "f"), "old\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "PR head"]);
      const headSha = await git(repo, ["rev-parse", "HEAD"]);
      await git(repo, ["worktree", "add", "--detach", worktree, headSha]);
      await Bun.write(ledgerPath(repo, "f"), "old\nnew\n");
      await git(repo, ["add", "-f", "."]);
      await git(repo, ["commit", "-m", "main ledger"]);
      const mainHead = await git(repo, ["rev-parse", "HEAD"]);
      const logger = makeLogger();
      let commits = 0;
      _ledgerCarryDeps.getLogger = () => logger;
      _ledgerCarryDeps.runGit = async (args, cwd) => {
        if (args[0] === "commit") {
          commits++;
          return { exitCode: 1, stdout: "", stderr: "commit wrapper exits 1" };
        }
        return botGit(args, cwd);
      };
      const base = makeBotFixEnv();
      const result = await ledgerStep(
        {
          ...base,
          repoRoot: repo,
          info: { ...base.info, headSha },
          checkout: { ...base.checkout, worktree, changedFiles: [`${PROJECT_FEATURES_DIR}/f/prd.json`] },
        },
        { step: "push", timings: {} },
      );
      expect(commits).toBe(1);
      expect(result).toEqual({ patch: {}, exit: "skip" });
      expect(await git(worktree, ["status", "--porcelain"])).toBe("");
      expect(await git(worktree, ["rev-parse", "HEAD"])).toBe(headSha);
      expect(await git(repo, ["rev-parse", "HEAD"])).toBe(mainHead);
      expect(logger.calls).toContainEqual(expect.objectContaining({ message: "Advisor ledger not carried" }));
    });
  });
});
