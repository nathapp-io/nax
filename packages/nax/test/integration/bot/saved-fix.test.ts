import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeBotFixDeps, makeBotFixEnv, makeTempDir, makeTestRuntime } from "@test/helpers";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import type { BotFixState } from "@/bot/fix-steps";
import { _savedFixDeps, clearSavedFix, readSavedFix, saveFix } from "@/bot/saved-fix";
import { getLogger } from "@/logger";
import { gitWithTimeout } from "@/utils/git";

const original = { ..._botFixDeps };
const savedOriginal = { ..._savedFixDeps };
const dirs: string[] = [];
const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
afterEach(async () => {
  Object.assign(_botFixDeps, original);
  Object.assign(_savedFixDeps, savedOriginal);
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
  await Promise.all(dirs.splice(0).map(cleanupTempDir));
});
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitWithTimeout(args, cwd);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}
async function fixture() {
  const root = makeTempDir("saved-fix-");
  dirs.push(root);
  await git(root, "init");
  await git(root, "config", "user.name", "Test");
  await git(root, "config", "user.email", "test@example.com");
  await Bun.write(join(root, "a"), "head");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "head");
  const headSha = await git(root, "rev-parse", "HEAD");
  const worktree = join(root, "checkout");
  await git(root, "worktree", "add", "--detach", worktree, headSha);
  await git(worktree, "commit", "--allow-empty", "-m", "fix");
  const fixSha = await git(worktree, "rev-parse", "HEAD");
  await git(worktree, "commit", "--allow-empty", "-m", "repair");
  const latestSha = await git(worktree, "rev-parse", "HEAD");
  const base = makeBotFixEnv([
    { kind: "finding", key: "z", issue: "Z", severity: "minor" },
    { kind: "finding", key: "a", issue: "A", severity: "minor" },
  ]);
  const env = { ...base, repoRoot: root, info: { ...base.info, headSha }, checkout: { ...base.checkout, worktree } };
  const runtime = makeTestRuntime({ config: env.config });
  runtimes.push(runtime);
  const outputDir = join(root, "output");
  Object.defineProperty(runtime, "outputDir", { value: outputDir });
  const location = { repoRoot: root, outputDir, prNumber: 42 };
  const path = join(outputDir, "bot", "pr-42", "saved-fix.json");
  let savedBeforeDispose = false;
  env.checkout.dispose = async () => {
    savedBeforeDispose = await Bun.file(path).exists();
  };
  Object.assign(_botFixDeps, makeBotFixDeps(env, runtime), {
    savedFix: { read: readSavedFix, save: saveFix, clear: clearSavedFix },
    reportStep: async () => ({ patch: {}, exit: "done" }),
  });
  async function run(outcome: BotFixState["outcome"], sha: string = fixSha) {
    _botFixDeps.fixStep = async () => ({ patch: { fixSha: sha }, exit: "ran" });
    _botFixDeps.checkStep = async () => ({ patch: { outcome }, exit: "protected" });
    return runBotFix({ dir: root, pr: 42, profiles: [], interactive: false });
  }
  return { ...location, path, run, headSha, fixSha, latestSha, worktree, savedBeforeDispose: () => savedBeforeDispose };
}

describe("runBotFix saved fix persistence", () => {
  test("AC-1/2/3/4 saves worktree HEAD, original PR head, sorted keys and root ref before disposal", async () => {
    const f = await fixture();
    expect(await f.run("baseline-red")).toMatchObject({ outcome: "baseline-red" });
    expect(await Bun.file(f.path).json()).toMatchObject({
      version: 1,
      sha: f.latestSha,
      headSha: f.headSha,
      agreedKeys: ["a", "z"],
      outcome: "baseline-red",
    });
    expect(await git(f.repoRoot, "rev-parse", "refs/nax-bot/pr-42/fix")).toBe(f.latestSha);
    expect(f.savedBeforeDispose()).toBe(true);
  });
  test("AC-5 prepare-touched-tracked saves the original fixSha", async () => {
    const f = await fixture();
    await f.run("prepare-touched-tracked");
    expect((await Bun.file(f.path).json()).sha).toBe(f.fixSha);
  });
  test("AC-7 failed baseline restore at PR head saves fixSha", async () => {
    const f = await fixture();
    await git(f.worktree, "checkout", "--detach", f.headSha);
    await f.run("gates-failed");
    expect((await Bun.file(f.path).json()).sha).toBe(f.fixSha);
  });
  test.each(["protected", "nothing"] as const)("AC-8/9 %s creates no artifact", async (outcome) => {
    const f = await fixture();
    await f.run(outcome);
    expect(await Bun.file(f.path).exists()).toBe(false);
    expect((await gitWithTimeout(["show-ref", "--verify", "refs/nax-bot/pr-42/fix"], f.repoRoot)).exitCode).not.toBe(0);
  });
  test("AC-10 fixSha equal to PR head creates no artifact", async () => {
    const f = await fixture();
    await f.run("baseline-red", f.headSha);
    expect(await Bun.file(f.path).exists()).toBe(false);
  });
  test("AC-11 unset fixSha creates no artifact", async () => {
    const f = await fixture();
    _botFixDeps.fixStep = async () => ({ patch: {}, exit: "ran" });
    _botFixDeps.checkStep = async () => ({ patch: { outcome: "baseline-red" }, exit: "protected" });
    await runBotFix({ dir: f.repoRoot, pr: 42, profiles: [], interactive: false });
    expect(await Bun.file(f.path).exists()).toBe(false);
  });
  test.each(["ref", "file"] as const)(
    "AC-12/13/16 %s save failure is logged without changing outcome",
    async (operation) => {
      const f = await fixture();
      const warn = spyOn(getLogger(), "warn");
      if (operation === "ref") {
        _savedFixDeps.runGit = async (args, ...rest) =>
          args[0] === "update-ref"
            ? { exitCode: 1, stdout: "", stderr: "ref denied" }
            : savedOriginal.runGit(args, ...rest);
      } else {
        _savedFixDeps.write = async () => {
          throw new Error("disk denied");
        };
      }
      try {
        expect(await f.run("baseline-red")).toMatchObject({ outcome: "baseline-red" });
        expect(
          warn.mock.calls.some((call) =>
            JSON.stringify(call).includes(operation === "ref" ? "ref denied" : "disk denied"),
          ),
        ).toBe(true);
        expect(await Bun.file(f.path).exists()).toBe(false);
      } finally {
        warn.mockRestore();
      }
    },
  );
});

describe("clearSavedFix", () => {
  test("deletes both the saved ref and artifact, idempotently", async () => {
    const f = await fixture();
    await f.run("baseline-red");
    await clearSavedFix(f);
    await clearSavedFix(f);
    expect(await readSavedFix(f.outputDir, 42)).toBeNull();
    expect((await gitWithTimeout(["show-ref", "--verify", "refs/nax-bot/pr-42/fix"], f.repoRoot)).exitCode).not.toBe(0);
  });
});
