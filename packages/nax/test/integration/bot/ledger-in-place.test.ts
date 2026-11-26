import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { relative } from "node:path";
import {
  makeAdviceDecision,
  makeAdviceQuestion,
  makeBotFixDeps,
  makeBotFixEnv,
  makeNaxConfig,
  makeTestRuntime,
  withTempDir,
  writeTrustedDecision,
} from "@test/helpers";
import { ledgerPath } from "@/advisor";
import type { AgreedItem } from "@/bot";
import { _chainAdviseDeps } from "@/bot/chain-advise";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import type { BotFixEnv } from "@/bot/fix-steps";
import { _fixStepsDeps } from "@/bot/fix-steps";
import { botGit } from "@/bot/git";
import { _ledgerCarryDeps, readLedgerText } from "@/bot/ledger-carry";
import { PROJECT_FEATURES_DIR } from "@/config";
import { withNaxBotMarker } from "@/forge";

const originalFix = { ..._botFixDeps };
const originalChain = { ..._chainAdviseDeps };
const originalSteps = { ..._fixStepsDeps };
afterEach(() => {
  mock.restore();
  Object.assign(_botFixDeps, originalFix);
  Object.assign(_chainAdviseDeps, originalChain);
  Object.assign(_fixStepsDeps, originalSteps);
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await botGit(args, cwd);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

const FEATURE = "f";
const PRD = `${PROJECT_FEATURES_DIR}/${FEATURE}/prd.json`;
const SPEC = `${PROJECT_FEATURES_DIR}/${FEATURE}/spec.md`;
const BEFORE = "old\n";

/** A same-repository PR branch checked out in place, its ledger and feature files committed. */
async function inPlaceRepo(repo: string): Promise<{ env: BotFixEnv; headSha: string; rel: string }> {
  const rel = relative(repo, ledgerPath(repo, FEATURE));
  await Bun.write(ledgerPath(repo, FEATURE), BEFORE);
  await Bun.write(`${repo}/${PRD}`, "{}");
  await Bun.write(`${repo}/${SPEC}`, "# spec\n");
  await Bun.write(`${repo}/src/app.ts`, "export const a = 1;\n");
  await git(repo, ["init", "-b", "fix"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["add", "-f", "."]);
  await git(repo, ["commit", "-m", "feature"]);
  const headSha = await git(repo, ["rev-parse", "HEAD"]);
  const base = makeBotFixEnv();
  const env = {
    ...base,
    repoRoot: repo,
    info: { ...base.info, headSha },
    checkout: { ...base.checkout, worktree: repo, inPlace: true, startHead: headSha, changedFiles: [PRD, SPEC] },
  };
  return { env, headSha, rel };
}

/** One in-place run whose chain advice appended `after`; the run stops at the cost limit after setup. */
async function persistRun(env: BotFixEnv, runtime: ReturnType<typeof makeTestRuntime>, after: string) {
  Object.assign(_botFixDeps, {
    ...makeBotFixDeps(env, runtime),
    prepareInPlaceCheckout: async () => env.checkout,
    withChainRulings: async (input: BotFixEnv) => {
      await Bun.write(ledgerPath(env.repoRoot, FEATURE), after);
      return {
        ...input,
        advisorLedger: { feature: FEATURE, before: BEFORE, after },
        cost: { limitUsd: 1, spentUsd: () => 1 },
      };
    },
    reportStep: async () => ({ patch: {}, exit: "done" }),
  });
  return runBotFix({ dir: env.repoRoot, pr: 42, profiles: [], interactive: false, inPlace: true });
}

describe("in-place advisor ledger persistence", () => {
  test("#3047 commits the verified bytes when the live ledger is replaced after verification", async () => {
    await withTempDir(async (repo) => {
      const { env, headSha, rel } = await inPlaceRepo(repo);
      const path = ledgerPath(repo, FEATURE);
      const after = `${BEFORE}new\n`;
      const replaced = "replaced by the user\n";
      const runtime = makeTestRuntime({ config: env.config });
      try {
        // Deterministic race: the edit lands right after the verification read returns.
        spyOn(_ledgerCarryDeps, "readText").mockImplementationOnce(async (p: string) => {
          const text = await readLedgerText(p);
          await Bun.write(p, replaced);
          return text;
        });
        const result = await persistRun(env, runtime, after);
        expect(await botGit(["show", `HEAD:${rel}`], repo)).toMatchObject({ exitCode: 0, stdout: after });
        expect(await git(repo, ["rev-list", "--count", `${headSha}..HEAD`])).toBe("1");
        // The concurrent edit is preserved, never overwritten; the dirty tree stops the run.
        expect(await Bun.file(path).text()).toBe(replaced);
        expect(result).toMatchObject({ outcome: "setup-failed" });
      } finally {
        await runtime.close();
      }
    });
  });

  test("#3047 leaves an unrelated staged file staged and out of the ledger commit", async () => {
    await withTempDir(async (repo) => {
      const { env, rel } = await inPlaceRepo(repo);
      const after = `${BEFORE}new\n`;
      await Bun.write(`${repo}/src/app.ts`, "export const a = 3;\n");
      await git(repo, ["add", "src/app.ts"]);
      const runtime = makeTestRuntime({ config: env.config });
      try {
        await persistRun(env, runtime, after);
        expect(await git(repo, ["show", "--name-only", "--format=", "HEAD"])).toBe(rel);
        expect(await git(repo, ["diff", "--cached", "--name-only"])).toBe("src/app.ts");
      } finally {
        await runtime.close();
      }
    });
  });

  test("#3047 signs the ledger commit when commit.gpgSign is set, refusing when signing fails", async () => {
    await withTempDir(async (repo) => {
      const { env, headSha } = await inPlaceRepo(repo);
      await git(repo, ["config", "commit.gpgSign", "true"]);
      await git(repo, ["config", "gpg.program", "false"]);
      const runtime = makeTestRuntime({ config: env.config });
      try {
        const result = await persistRun(env, runtime, `${BEFORE}new\n`);
        // An unsigned commit would have landed; the failing signer proves -S reached git.
        expect(result).toMatchObject({ outcome: "refused", reason: expect.stringContaining("pending") });
        expect(await git(repo, ["rev-parse", "HEAD"])).toBe(headSha);
      } finally {
        await runtime.close();
      }
    });
  });

  test("#3048 advice persists before setup and the fixer's source change is checked against the ledger commit", async () => {
    await withTempDir(async (repo) => {
      const { env: base, headSha, rel } = await inPlaceRepo(repo);
      const key = "f-1";
      const finding: AgreedItem = {
        kind: "finding",
        key,
        issue: "issue f-1",
        severity: "important",
        trigger: "normal",
        lineage: { generation: 2, parents: ["p-1"], pushSha: "abcdef1" },
      };
      const config = makeNaxConfig({
        advisor: { enabled: true, callers: { botFixChain: true } },
        bot: { chainNoticeGeneration: 2 },
      });
      const thread = {
        id: "t1",
        replyTo: "1",
        resolved: false,
        outdated: false,
        comments: [
          {
            id: "c1",
            kind: "thread" as const,
            author: base.user.login,
            body: withNaxBotMarker("body", key),
            createdAt: "",
          },
        ],
      };
      const env: BotFixEnv = {
        ...base,
        config,
        threads: [thread],
        review: { ...base.review, headSha, agreed: [finding] },
      };
      const runtime = makeTestRuntime({ config });
      const decision = makeAdviceDecision({ action: { type: "fix", instruction: "guard the edge" } });
      const ledgerAtSetup: string[] = [];
      try {
        Object.assign(_chainAdviseDeps, {
          readFindingDispositions: async () => ({ confirmed: new Set<string>(), writerSettled: new Set<string>() }),
          buildChainQuestion: async () => makeAdviceQuestion(),
          replyToThread: async () => {},
          createAdvisor: () => ({
            advise: async () => {
              await writeTrustedDecision(repo, FEATURE, runtime.outputDir, decision);
              return { decision };
            },
            recordReuse: async () => null,
            adviseBatch: async () => ({ results: [] }),
          }),
        });
        const branchFix = mock(async () => {
          await Bun.write(`${repo}/src/app.ts`, "export const a = 2;\n");
          await git(repo, ["commit", "-am", "fix: guard the edge"]);
          return { autoCommitted: true, dirty: false };
        });
        Object.assign(_fixStepsDeps, { runBranchFix: branchFix });
        Object.assign(_botFixDeps, {
          ...makeBotFixDeps({ ...env, checkout: { ...env.checkout } }, runtime),
          loadBotConfig: async () => config,
          readPrInfo: async () => env.info,
          loadLatestReview: async () => env.review,
          listReviewThreads: async () => [thread],
          prepareInPlaceCheckout: async () => env.checkout,
          withChainRulings: originalFix.withChainRulings,
          runPreRunSteps: async () => {
            ledgerAtSetup.push(await git(repo, ["show", `HEAD:${rel}`]));
          },
          reportStep: async () => ({ patch: {}, exit: "done" }),
        });
        const result = await runBotFix({ dir: repo, pr: 42, profiles: [], interactive: false, inPlace: true });
        expect(ledgerAtSetup).toEqual([`${BEFORE}${JSON.stringify(decision)}`]);
        expect(branchFix).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ changed: ["src/app.ts"] });
        expect(result.outcome).not.toBe("protected");
      } finally {
        await runtime.close();
      }
    });
  });
});
