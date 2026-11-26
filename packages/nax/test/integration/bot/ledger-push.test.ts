import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join, relative } from "node:path";
import { makeBotFixDeps, makeBotFixEnv, makeTestRuntime, withTempDir } from "@test/helpers";
import { ledgerPath } from "@/advisor";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import type { BotFixEnv } from "@/bot/fix-steps";
import { botGit } from "@/bot/git";
import { _ledgerCarryDeps } from "@/bot/ledger-carry";
import { PROJECT_FEATURES_DIR } from "@/config";
import { NaxError } from "@/errors";
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
  test.each(["mode", "index", "install-failure", "cost-stop", "already-committed", "hash-object", "update-ref"])(
    "in-place decision persistence: %s",
    async (scenario) => {
      await withTempDir(async (repo) => {
        const path = ledgerPath(repo, "f");
        const rel = relative(repo, path);
        const before = "old\n";
        const after = "old\nnew\n";
        await Bun.write(path, before);
        await git(repo, ["init", "-b", "fix"]);
        await git(repo, ["config", "user.email", "test@example.com"]);
        await git(repo, ["config", "user.name", "Test"]);
        await git(repo, ["config", "core.filemode", "true"]);
        await git(repo, ["add", "-f", rel]);
        await git(repo, ["commit", "-m", "feature"]);
        const headSha = await git(repo, ["rev-parse", "HEAD"]);
        const base = makeBotFixEnv();
        const env = {
          ...base,
          repoRoot: repo,
          info: { ...base.info, headSha },
          checkout: { ...base.checkout, worktree: repo, inPlace: true, startHead: headSha },
        };
        const runtime = makeTestRuntime({ config: env.config });
        const setup = mock(async () => {
          if (scenario === "mode") await chmod(path, 0o755);
          if (scenario === "index") {
            await Bun.write(path, "setup\n");
            await git(repo, ["add", rel]);
            await Bun.write(path, after);
          }
          if (scenario === "install-failure")
            throw new NaxError("install failed", "PRE_RUN_FAILED", { stage: "install" });
        });
        try {
          const persistenceFailure = scenario === "hash-object" || scenario === "update-ref";
          if (persistenceFailure)
            spyOn(_ledgerCarryDeps, "runGit").mockImplementation(async (args, cwd) =>
              args[0] === scenario ? { exitCode: 1, stdout: "", stderr: "failed" } : botGit(args, cwd),
            );
          Object.assign(_botFixDeps, {
            ...makeBotFixDeps(env, runtime),
            prepareInPlaceCheckout: async () => env.checkout,
            withChainRulings: async (input: BotFixEnv) => {
              await Bun.write(path, after);
              if (scenario === "already-committed") {
                await git(repo, ["commit", "-am", "decision already saved"]);
              }
              return {
                ...input,
                advisorLedger: { feature: "f", before, after },
                cost: { limitUsd: 1, spentUsd: () => 1 },
              };
            },
            runPreRunSteps: setup,
            reportStep: async () => ({ patch: {}, exit: "done" }),
          });
          const result = await runBotFix({ dir: repo, pr: 42, profiles: [], interactive: false, inPlace: true });
          expect(await Bun.file(path).text()).toBe(after);
          if (persistenceFailure) {
            expect(result).toMatchObject({ outcome: "refused", reason: expect.stringContaining("pending") });
            expect(setup).not.toHaveBeenCalled();
            return;
          }
          expect(setup).toHaveBeenCalledTimes(1);
          expect(await git(repo, ["show", `HEAD:${rel}`])).toBe(after.trim());
          expect(await git(repo, ["rev-list", "--count", `${headSha}..HEAD`])).toBe("1");
          if (scenario === "mode" || scenario === "index") {
            expect(result).toMatchObject({
              outcome: "setup-failed",
              setupFailed: "in-place checkout not clean after setup",
            });
          } else {
            expect(result.outcome).toBe(scenario === "install-failure" ? "setup-failed" : "cost-limit");
            expect(await git(repo, ["status", "--porcelain"])).toBe("");
          }
        } finally {
          await runtime.close();
        }
      });
    },
  );

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
