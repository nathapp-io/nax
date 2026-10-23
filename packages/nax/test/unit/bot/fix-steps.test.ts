import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixEnv } from "@test/helpers";
import { _fixStepsDeps, checkStep, pushStep } from "@/bot/fix-steps";
import { getLogger, initLogger, resetLogger } from "@/logger";

const original = { ..._fixStepsDeps };
const state = { step: "check" as const, timings: {} };
beforeEach(() => {
  initLogger({ level: "silent" });
  _fixStepsDeps.runGit = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  _fixStepsDeps.readHead = async () => "fixed";
});
afterEach(() => {
  Object.assign(_fixStepsDeps, original);
  resetLogger();
});

describe("checkStep", () => {
  test.each([true, false])("diffs from startHead when present: %s (AC-3/4)", async (local) => {
    const base = makeBotFixEnv();
    const env = { ...base, checkout: { ...base.checkout, ...(local ? { startHead: "L" } : {}) } };
    const changed = mock(async (_worktree: string, from: string) =>
      from === "L" ? [] : [".nax/features/f/decisions.jsonl"],
    );
    _fixStepsDeps.changedPaths = changed;
    const result = await checkStep(env, state);
    expect(result.patch?.outcome).toBe(local ? "no-change" : "protected");
    expect(changed).toHaveBeenCalledWith(env.checkout.worktree, local ? "L" : env.info.headSha);
  });
});

describe("pushStep", () => {
  test.each(["nothing", undefined] as const)("ledger push preserves outcome %s (US-009 AC-1–3)", async (outcome) => {
    const result = await pushStep(makeBotFixEnv(), { ...state, outcome });
    expect(result.patch).toMatchObject({ outcome: outcome ?? "pushed", pushedSha: "fixed" });
    expect(result.exit).toBe("pushed");
  });
  test.each(["other", "feat/x", "detached"])("guards in-place branch %s (AC-12–15)", async (branch) => {
    const base = makeBotFixEnv();
    const env = { ...base, info: { ...base.info, headRef: "feat/x" }, checkout: { ...base.checkout, inPlace: true } };
    const git = mock(async (argv: string[]) => ({
      exitCode: argv[0] === "symbolic-ref" && branch === "detached" ? 1 : 0,
      stdout: argv[0] === "symbolic-ref" ? branch : "",
      stderr: "",
    }));
    _fixStepsDeps.runGit = git;
    const warn = spyOn(getLogger(), "warn");
    try {
      const result = await pushStep(env, state);
      const pushes = git.mock.calls.filter(([argv]) => argv[0] === "push");
      expect(git.mock.calls[0]?.[0]).toEqual(["symbolic-ref", "--short", "HEAD"]);
      if (branch === "feat/x") {
        expect(result.patch?.outcome).toBe("pushed");
        expect(pushes.map(([argv]) => argv)).toEqual([["push", "--no-verify", "origin", "HEAD:refs/heads/feat/x"]]);
      } else {
        expect(result.patch?.outcome).toBe("push-rejected");
        expect(pushes).toEqual([]);
        expect(warn).toHaveBeenCalledWith("bot-fix", "In-place checkout left branch feat/x");
      }
    } finally {
      warn.mockRestore();
    }
  });
});
