import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeBotFixDeps,
  makeBotFixEnv,
  makeNaxConfig,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import { prepareInPlaceCheckout } from "@/bot/checkout-in-place";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import { _fixStepsDeps } from "@/bot/fix-steps";
import { botGit } from "@/bot/git";
import { featureDir } from "@/config";
import { initLogger, resetLogger } from "@/logger";

const original = { ..._botFixDeps };
const steps = { ..._fixStepsDeps };
let repo: string;
let remote: string;
let env: ReturnType<typeof makeBotFixEnv>;
let runtime: ReturnType<typeof makeTestRuntime>;
const input = { dir: "/repo", pr: 42, profiles: [], interactive: false, inPlace: true };
const savedRead = mock<typeof _botFixDeps.savedFix.read>(async () => ({
  version: 1,
  sha: "a".repeat(40),
  headSha: env.info.headSha,
  agreedKeys: ["f1"],
  outcome: "gates-failed",
  savedAt: "2026-01-01T00:00:00.000Z",
}));
const savedClear = mock(async () => {});
const savedSave = mock(async () => {});
const session = mock<typeof _fixStepsDeps.runBranchFix>(async () => ({ autoCommitted: true, dirty: false }));
const baseline = mock<typeof _fixStepsDeps.failingOnHead>(async () => ["test"]);
const inPlace = mock(async () => env.checkout);
const isolated = mock(async () => env.checkout);

async function git(argv: string[], cwd = repo): Promise<string> {
  const result = await botGit(argv, cwd);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

beforeEach(async () => {
  initLogger({ level: "silent" });
  repo = makeTempDir("in-place-fix-");
  remote = makeTempDir("in-place-origin-");
  await git(["init", "--bare"], remote);
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.com"]);
  await Bun.write(join(repo, "src/a.ts"), "base");
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  await git(["remote", "add", "origin", remote]);
  await git(["push", "origin", "main"]);
  await git(["checkout", "-b", "feat/x"]);
  await Bun.write(join(repo, "src/a.ts"), "PR");
  await git(["commit", "-am", "PR"]);
  const headSha = await git(["rev-parse", "HEAD"]);
  await git(["push", "origin", "feat/x", "HEAD:refs/pull/42/head"]);
  const base = makeBotFixEnv();
  env = {
    ...base,
    repoRoot: repo,
    config: makeNaxConfig({ bot: { gateRepairRounds: 0 } }),
    info: { ...base.info, headRef: "feat/x", headSha },
    checks: { source: "config", gates: [{ name: "test", command: "test-command" }], preRun: [] },
    review: {
      ...base.review,
      headSha,
      agreed: [{ kind: "finding", key: "f1", issue: "fix source", severity: "minor" }],
    },
    checkout: { ...base.checkout, worktree: repo, inPlace: true, startHead: headSha },
  };
  runtime = makeTestRuntime({ config: env.config });
  for (const fn of [savedRead, savedClear, savedSave, session, baseline, inPlace, isolated]) fn.mockClear();
  session.mockImplementation(async () => ({ autoCommitted: true, dirty: false }));
  Object.assign(_botFixDeps, makeBotFixDeps(env, runtime), {
    prepareInPlaceCheckout: inPlace,
    preparePrCheckout: isolated,
    savedFix: { read: savedRead, clear: savedClear, save: savedSave },
    readyStep: async () => ({ patch: {}, exit: "report" }),
    replyStep: async () => ({ patch: {}, exit: "ready" }),
    reportStep: async () => ({ patch: {}, exit: "done" }),
  });
  Object.assign(_fixStepsDeps, {
    runGit: botGit,
    runBranchFix: session,
    failingOnHead: baseline,
    readHeadCi: async () => ({ outcome: "green" }),
    runQualityGates: async () => ({ passed: false, failing: ["test"], ran: ["test"], output: "red" }),
    changedPaths: async () => ["src/a.ts"],
  });
});
afterEach(async () => {
  Object.assign(_botFixDeps, original);
  Object.assign(_fixStepsDeps, steps);
  await runtime?.close();
  cleanupTempDir(repo);
  cleanupTempDir(remote);
  resetLogger();
});

describe("runBotFix in-place", () => {
  test("selects in-place, bypasses saved fixes and attributes red gates to fix (AC-1/2/5–8)", async () => {
    let readsBeforeSession = -1;
    let clearsBeforeSession = -1;
    session.mockImplementation(async () => {
      readsBeforeSession = savedRead.mock.calls.length;
      clearsBeforeSession = savedClear.mock.calls.length;
      return { autoCommitted: true, dirty: false };
    });
    const result = await runBotFix(input);
    expect(inPlace).toHaveBeenCalledTimes(1);
    expect(isolated).not.toHaveBeenCalled();
    expect(session).toHaveBeenCalledTimes(1);
    expect(readsBeforeSession).toBe(0);
    expect(clearsBeforeSession).toBe(0);
    expect(baseline).not.toHaveBeenCalled();
    expect(result.outcome).toBe("gates-failed");
    expect(savedRead).not.toHaveBeenCalled();
    expect(savedClear).not.toHaveBeenCalled();
    expect(savedSave).not.toHaveBeenCalled();
    expect(await git(["symbolic-ref", "--short", "HEAD"])).toBe("feat/x");
  });

  test("refuses untracked setup output before starting session (AC-9–11)", async () => {
    _botFixDeps.runPreRunSteps = async ({ workdir }) => {
      await Bun.write(join(workdir, "generated.txt"), "untracked");
    };
    const result = await runBotFix(input);
    expect(result.outcome).toBe("setup-failed");
    expect(result).toMatchObject({ setupFailed: "in-place checkout not clean after setup" });
    expect(session).not.toHaveBeenCalled();
    expect(await git(["status", "--porcelain"])).toContain("?? generated.txt");
  });

  test("pushes ledger and fix commits without detaching the real branch (AC-16/17)", async () => {
    await Bun.write(join(featureDir(repo, "f"), "decisions.jsonl"), "{}\n");
    await git(["add", "."]);
    await git(["commit", "-m", "local ledger"]);
    const ledgerSha = await git(["rev-parse", "HEAD"]);
    Object.assign(_botFixDeps, { prepareInPlaceCheckout });
    _fixStepsDeps.changedPaths = steps.changedPaths;
    _fixStepsDeps.runQualityGates = async () => ({ passed: true, failing: [], ran: ["test"], output: "green" });
    session.mockImplementation(async () => {
      await Bun.write(join(repo, "src/a.ts"), "fixed");
      await git(["commit", "-am", "fix source"]);
      return { autoCommitted: true, dirty: false };
    });
    const result = await runBotFix(input);
    expect(result.outcome).toBe("pushed");
    const pushed = await git(["rev-parse", "refs/heads/feat/x"], remote);
    expect(pushed).toBe(await git(["rev-parse", "HEAD"]));
    expect(await git(["rev-parse", `${pushed}^`], remote)).toBe(ledgerSha);
    expect(await git(["show", `${pushed}:src/a.ts`], remote)).toBe("fixed");
    expect(await git(["show", `${pushed}:.nax/features/f/decisions.jsonl`], remote)).toBe("{}");
    expect(await git(["symbolic-ref", "--short", "HEAD"])).toBe("feat/x");
    expect(savedClear).not.toHaveBeenCalled();
  });
});
