import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { makeBotFixDeps, makeBotFixEnv, makeTestRuntime, withTempDir } from "@test/helpers";
import { ledgerPath } from "@/advisor";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import { botGit } from "@/bot/git";
import { PROJECT_FEATURES_DIR } from "@/config";
import { NAX_WORKFLOW_PR_MARKER } from "@/forge";

const original = { ..._botFixDeps };
afterEach(() => {
  mock.restore();
  Object.assign(_botFixDeps, original);
});
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await botGit(args, cwd);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

describe("runBotFix ledger carry seam", () => {
  test("AC-18 real worktree pushes main's ledger without moving main or starting re-review", async () => {
    await withTempDir(async (root) => {
      const repo = join(root, "main");
      const origin = join(root, "origin.git");
      const worktree = join(root, "pr");
      await Bun.write(join(repo, "README.md"), "fixture");
      await git(repo, ["init", "-b", "main"]);
      await git(repo, ["config", "user.email", "test@example.com"]);
      await git(repo, ["config", "user.name", "Test"]);
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "base"]);
      await git(repo, ["init", "--bare", origin]);
      await git(repo, ["remote", "add", "origin", origin]);
      await git(repo, ["checkout", "-b", "feat/x"]);
      await Bun.write(join(repo, PROJECT_FEATURES_DIR, "f", "prd.json"), "{}");
      await Bun.write(ledgerPath(repo, "f"), "old\n");
      await git(repo, ["add", "-f", "."]);
      await git(repo, ["commit", "-m", "feature"]);
      const headSha = await git(repo, ["rev-parse", "HEAD"]);
      await git(repo, ["push", "origin", "feat/x"]);
      await git(repo, ["worktree", "add", "--detach", worktree, headSha]);
      const mainText = "old\nnew\n";
      await Bun.write(ledgerPath(repo, "f"), mainText);
      await git(repo, ["add", "-f", "."]);
      await git(repo, ["commit", "-m", "local ledger"]);
      const mainHead = await git(repo, ["rev-parse", "HEAD"]);
      const base = makeBotFixEnv();
      const env = {
        ...base,
        repoRoot: repo,
        info: { ...base.info, headRef: "feat/x", headSha, body: NAX_WORKFLOW_PR_MARKER },
        checkout: { ...base.checkout, worktree, changedFiles: [`${PROJECT_FEATURES_DIR}/f/prd.json`] },
      };
      const runtime = makeTestRuntime({ config: env.config });
      try {
        Object.assign(_botFixDeps, {
          ...makeBotFixDeps(env, runtime),
          ledgerStep: original.ledgerStep,
          recordPrRulings: async () => ({ recorded: [], settled: [], open: [], asked: 0, failed: 0 }),
          readyStep: async (_env: typeof env, state: Parameters<typeof original.readyStep>[1]) => {
            expect(state.pushedSha).toBeTruthy();
            return { patch: {}, exit: "report" };
          },
          reportStep: async () => ({ patch: {}, exit: "done" }),
        });
        const push = spyOn(_botFixDeps, "pushStep");
        const result = await runBotFix({ dir: repo, pr: 42, profiles: [], interactive: false });
        expect(push).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ outcome: "nothing", ledgerCarried: true });
        const remoteHead = await git(repo, ["--git-dir", origin, "rev-parse", "refs/heads/feat/x"]);
        expect(remoteHead).not.toBe(headSha);
        expect(result).toMatchObject({ pushedSha: remoteHead });
        const remoteText = await botGit(
          ["--git-dir", origin, "show", `feat/x:${PROJECT_FEATURES_DIR}/f/decisions.jsonl`],
          repo,
        );
        expect(remoteText.exitCode).toBe(0);
        expect(remoteText.stdout).toBe(mainText);
        expect(await git(repo, ["rev-parse", "HEAD"])).toBe(mainHead);
        expect(await git(repo, ["branch", "--show-current"])).toBe("feat/x");
        expect(await git(repo, ["status", "--porcelain"])).toBe("");
      } finally {
        await runtime.close();
      }
    });
  });
});
