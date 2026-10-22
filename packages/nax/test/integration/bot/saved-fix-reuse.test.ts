import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeBotFixDeps, makeBotFixEnv, makeTempDir, makeTestRuntime } from "@test/helpers";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import { _fixStepsDeps } from "@/bot/fix-steps";
import { _savedFixDeps, clearSavedFix, readSavedFix, saveFix } from "@/bot/saved-fix";
import { getLogger } from "@/logger";
import { gitWithTimeout } from "@/utils/git";

const original = { ..._botFixDeps };
const savedOriginal = { ..._savedFixDeps };
const stepsOriginal = { ..._fixStepsDeps };
const dirs: string[] = [];
const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
afterEach(async () => {
  Object.assign(_botFixDeps, original);
  Object.assign(_savedFixDeps, savedOriginal);
  Object.assign(_fixStepsDeps, stepsOriginal);
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(dirs.splice(0).map(cleanupTempDir));
});
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitWithTimeout(args, cwd);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}
async function fixture() {
  const root = makeTempDir("saved-reuse-");
  dirs.push(root);
  await git(root, "init");
  await git(root, "config", "user.name", "Test");
  await git(root, "config", "user.email", "test@example.com");
  await Bun.write(join(root, "a"), "head");
  await git(root, "add", "a");
  await git(root, "commit", "-m", "head");
  const headSha = await git(root, "rev-parse", "HEAD");
  await Bun.write(join(root, "a"), "fix");
  await git(root, "commit", "-am", "fix");
  const sha = await git(root, "rev-parse", "HEAD");
  const worktree = join(root, "checkout");
  await git(root, "worktree", "add", "--detach", worktree, headSha);
  const base = makeBotFixEnv([
    { kind: "finding", key: "z", issue: "fix", severity: "minor" },
    { kind: "finding", key: "a", issue: "fix", severity: "minor" },
  ]);
  const env = { ...base, repoRoot: root, info: { ...base.info, headSha }, checkout: { ...base.checkout, worktree } };
  const runtime = makeTestRuntime({ config: env.config });
  runtimes.push(runtime);
  const outputDir = join(root, "output");
  Object.defineProperty(runtime, "outputDir", { value: outputDir });
  const location = { repoRoot: root, outputDir, prNumber: 42 };
  const entry = {
    version: 1 as const,
    sha,
    headSha,
    agreedKeys: ["z", "a"],
    outcome: "baseline-red" as const,
    savedAt: "2026-10-22T03:00:00.000Z",
  };
  await saveFix(location, entry);
  const path = join(outputDir, "bot", "pr-42", "saved-fix.json");
  const runBranchFix = mock(async () => ({ autoCommitted: false, dirty: false }));
  _fixStepsDeps.runBranchFix = runBranchFix;
  _fixStepsDeps.readHead = async () => sha;
  const check = mock(async () => ({ patch: { outcome: "protected" as const }, exit: "protected" }));
  Object.assign(_botFixDeps, makeBotFixDeps(env, runtime), {
    savedFix: { read: readSavedFix, save: saveFix, clear: clearSavedFix },
    checkStep: check,
    reportStep: async () => ({ patch: {}, exit: "done" }),
  });
  const run = (fresh = false) => runBotFix({ dir: root, pr: 42, profiles: [], interactive: false, fresh });
  const refExists = async () =>
    (await gitWithTimeout(["show-ref", "--verify", "refs/nax-bot/pr-42/fix"], root)).exitCode === 0;
  return { root, worktree, path, entry, sha, headSha, run, runBranchFix, check, refExists };
}

describe("runBotFix saved fix reuse", () => {
  test("AC-1/2/3 checks out saved commit, starts at check with reuse state, and skips initial session with green gates", async () => {
    const f = await fixture();
    _botFixDeps.checkStep = async (_env, state) => {
      expect(state).toMatchObject({ step: "check", reusedFix: f.sha, fixSha: f.sha, agreedCount: 2 });
      expect(await git(f.worktree, "rev-parse", "HEAD")).toBe(f.sha);
      expect((await gitWithTimeout(["symbolic-ref", "-q", "HEAD"], f.worktree)).exitCode).not.toBe(0);
      return { patch: { changed: ["a"] }, exit: "changed" };
    };
    const gates = mock(async () => ({ patch: {}, exit: "passed" }));
    _botFixDeps.gatesStep = gates;
    _botFixDeps.pushStep = async () => ({ patch: { outcome: "push-rejected" }, exit: "rejected" });
    expect(await f.run()).toMatchObject({ outcome: "push-rejected", reusedFix: f.sha });
    expect(gates).toHaveBeenCalledTimes(1);
    expect(f.runBranchFix).not.toHaveBeenCalled();
  });
  test("AC-4 different agreed keys run the fix session without clearing", async () => {
    const f = await fixture();
    await Bun.write(f.path, JSON.stringify({ ...f.entry, agreedKeys: ["different"] }));
    expect(await f.run()).toMatchObject({ outcome: "protected" });
    expect(f.runBranchFix).toHaveBeenCalledTimes(1);
    expect(await Bun.file(f.path).exists()).toBe(true);
    expect(await f.refExists()).toBe(true);
  });
  test.each(["stale", "fresh", "missing-ref", "wrong-ref", "schema", "json"] as const)(
    "AC-5/6/7/8/12 clears %s before running a new session",
    async (condition) => {
      const f = await fixture();
      if (condition === "stale") await Bun.write(f.path, JSON.stringify({ ...f.entry, headSha: "b".repeat(40) }));
      if (condition === "schema") await Bun.write(f.path, JSON.stringify({ ...f.entry, version: 2 }));
      if (condition === "json") await Bun.write(f.path, "{");
      if (condition === "missing-ref") await git(f.root, "update-ref", "-d", "refs/nax-bot/pr-42/fix");
      if (condition === "wrong-ref") await git(f.root, "update-ref", "refs/nax-bot/pr-42/fix", f.headSha);
      const warn = spyOn(getLogger(), "warn");
      _fixStepsDeps.runBranchFix = mock(async () => {
        expect(await Bun.file(f.path).exists()).toBe(false);
        expect(await f.refExists()).toBe(false);
        return { autoCommitted: false, dirty: false };
      });
      try {
        expect(await f.run(condition === "fresh")).toMatchObject({ outcome: "protected" });
        expect(_fixStepsDeps.runBranchFix).toHaveBeenCalledTimes(1);
        if (["missing-ref", "wrong-ref", "schema", "json"].includes(condition))
          expect(
            warn.mock.calls.some((call) =>
              String(call[1]).includes(
                condition === "schema" || condition === "json" ? "Could not read saved fix" : "reuse invalid saved fix",
              ),
            ),
          ).toBe(true);
      } finally {
        warn.mockRestore();
      }
    },
  );
  test.each(["none", "ref", "file"] as const)(
    "AC-9/10/13/14 pushed clears state; %s failure preserves outcome and logs",
    async (failure) => {
      const f = await fixture();
      _botFixDeps.checkStep = async () => ({ patch: { changed: ["a"] }, exit: "changed" });
      _botFixDeps.gatesStep = async () => ({ patch: {}, exit: "passed" });
      _botFixDeps.pushStep = async () => ({ patch: { outcome: "pushed", pushedSha: f.sha }, exit: "pushed" });
      _botFixDeps.replyStep = async () => ({ patch: {}, exit: "ready" });
      _botFixDeps.readyStep = async () => ({ patch: {}, exit: "report" });
      if (failure === "ref")
        _savedFixDeps.runGit = async (args, ...rest) =>
          args[0] === "update-ref"
            ? { exitCode: 1, stdout: "", stderr: "ref denied" }
            : savedOriginal.runGit(args, ...rest);
      if (failure === "file")
        _savedFixDeps.remove = async () => {
          throw new Error("file denied");
        };
      const warn = spyOn(getLogger(), "warn");
      try {
        expect(await f.run()).toMatchObject({ outcome: "pushed" });
        if (failure !== "file") expect(await Bun.file(f.path).exists()).toBe(false);
        if (failure !== "ref") expect(await f.refExists()).toBe(false);
        if (failure !== "none")
          expect(warn.mock.calls.some((call) => JSON.stringify(call).includes(`${failure} denied`))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    },
  );
});
