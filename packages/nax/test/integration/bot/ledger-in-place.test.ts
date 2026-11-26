import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { relative } from "node:path";
import {
  makeAdviceDecision,
  makeAdviceQuestion,
  makeBotFixDeps,
  makeBotFixEnv,
  makeLogger,
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
import { _ledgerCarryDeps, commitInPlaceAppend, readLedgerText } from "@/bot/ledger-carry";
import { PROJECT_FEATURES_DIR } from "@/config";
import { withNaxBotMarker } from "@/forge";

const originalFix = { ..._botFixDeps };
const originalChain = { ..._chainAdviseDeps };
const originalSteps = { ..._fixStepsDeps };
const originalCarry = { ..._ledgerCarryDeps };
afterEach(() => {
  mock.restore();
  Object.assign(_botFixDeps, originalFix);
  Object.assign(_chainAdviseDeps, originalChain);
  Object.assign(_fixStepsDeps, originalSteps);
  Object.assign(_ledgerCarryDeps, originalCarry);
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

const AFTER = `${BEFORE}new\n`;
const STAGED_DURING_RUN = "staged during the run\n";
const INDEX_LEFT_AS_IS = "Advisor ledger committed; the staged ledger differs and was left as is";

/** The appended text committed in place, over the feature the fixture already wrote. */
function append(env: BotFixEnv): Promise<boolean> {
  return commitInPlaceAppend(env, { feature: FEATURE, before: BEFORE, after: AFTER });
}

/** `git ls-files -s` for the ledger — the index entry the ACs read. */
function indexEntry(repo: string, rel: string): Promise<string> {
  return git(repo, ["ls-files", "-s", "--", `:(literal)${rel}`]);
}

/** The blob `git ls-files -s` reports for the ledger's index entry. */
function indexBlob(entry: string): string | undefined {
  return entry.split(" ")[1];
}

/** A real-index read that always fails, recording every reset the append issues. */
function breakIndexRead(): string[][] {
  const resets: string[][] = [];
  const inner = _ledgerCarryDeps.runGit;
  _ledgerCarryDeps.runGit = async (args, cwd) => {
    if (args[0] === "reset") resets.push(args);
    if (args[0] === "ls-files") return { exitCode: 1, stdout: "", stderr: "index unreadable" };
    return inner(args, cwd);
  };
  return resets;
}

describe("in-place ledger index refresh (#3057)", () => {
  test("AC-1–3: a ledger version staged just before update-ref survives as the index entry", async () => {
    await withTempDir(async (repo) => {
      const { env, rel } = await inPlaceRepo(repo);
      const path = ledgerPath(repo, FEATURE);
      await Bun.write(path, AFTER);
      const inner = _ledgerCarryDeps.runGit;
      let stagedBlob = "";
      // Deterministic race: the user's `git add` lands between the commit object and the ref move.
      _ledgerCarryDeps.runGit = async (args, cwd) => {
        if (args[0] === "update-ref") {
          await Bun.write(path, STAGED_DURING_RUN);
          await git(repo, ["add", "-f", "--", rel]);
          stagedBlob = await git(repo, ["rev-parse", `:${rel}`]);
        }
        return inner(args, cwd);
      };
      const committed = await append(env);
      const [entry, head] = await Promise.all([indexEntry(repo, rel), git(repo, ["rev-parse", `HEAD:${rel}`])]);
      expect(committed).toBe(true);
      // The staged blob is still the entry, and it is not the appended text the commit holds.
      expect(indexBlob(entry)).toBe(stagedBlob);
      expect(indexBlob(entry)).not.toBe(head);
      expect((await botGit(["show", `HEAD:${rel}`], repo)).stdout).toBe(AFTER);
    });
  });

  test("AC-4: with no concurrent staging the index entry follows HEAD", async () => {
    await withTempDir(async (repo) => {
      const { env, rel } = await inPlaceRepo(repo);
      await Bun.write(ledgerPath(repo, FEATURE), AFTER);
      expect(await append(env)).toBe(true);
      const [entry, head] = await Promise.all([indexEntry(repo, rel), git(repo, ["rev-parse", `HEAD:${rel}`])]);
      expect(indexBlob(entry)).toBe(head);
      expect(await git(repo, ["status", "--porcelain"])).toBe("");
    });
  });

  test("AC-14–15: an unreadable index still commits and warns the staged ledger was left as is", async () => {
    await withTempDir(async (repo) => {
      const { env, rel } = await inPlaceRepo(repo);
      await Bun.write(ledgerPath(repo, FEATURE), AFTER);
      const logger = makeLogger();
      _ledgerCarryDeps.getLogger = () => logger;
      breakIndexRead();
      expect(await append(env)).toBe(true);
      expect((await botGit(["show", `HEAD:${rel}`], repo)).stdout).toBe(AFTER);
      expect(logger.calls).toContainEqual(expect.objectContaining({ level: "warn", message: INDEX_LEFT_AS_IS }));
    });
  });

  test("AC-18: an unreadable index issues no reset of the real ledger entry", async () => {
    await withTempDir(async (repo) => {
      const { env, rel } = await inPlaceRepo(repo);
      await Bun.write(ledgerPath(repo, FEATURE), AFTER);
      const resets = breakIndexRead();
      expect(await append(env)).toBe(true);
      expect(resets).toEqual([]);
      // The entry still holds the parent commit's blob: nothing refreshed it to the new HEAD.
      const [entry, parent] = await Promise.all([indexEntry(repo, rel), git(repo, ["rev-parse", `HEAD~1:${rel}`])]);
      expect(indexBlob(entry)).toBe(parent);
    });
  });
});
