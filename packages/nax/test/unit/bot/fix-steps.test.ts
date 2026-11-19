import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixEnv } from "@test/helpers";
import type { AgreedItem, BotFixEnv } from "@/bot";
import { toFixFindings } from "@/bot/fix-input";
import { _fixStepsDeps, checkStep, fixStep, pushStep } from "@/bot/fix-steps";
import { getLogger, initLogger, resetLogger } from "@/logger";
import type { FindingTrigger } from "@/workflow/blocking-findings";

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
  test.each([0, 1])("US-008 AC-13/15: leased temporary push exits %s", async (exitCode) => {
    const base = makeBotFixEnv();
    const env = { ...base, info: { ...base.info, headRef: "feat/x" } };
    const git = mock(async (argv: string[]) => ({
      exitCode: argv[0] === "push" ? exitCode : 0,
      stdout: "",
      stderr: "stale info",
    }));
    _fixStepsDeps.runGit = git;
    expect(await pushStep(env, state)).toEqual(
      exitCode === 0
        ? { patch: { outcome: "pushed", pushedSha: "fixed" }, exit: "pushed" }
        : { patch: { outcome: "push-rejected" }, exit: "rejected" },
    );
    expect(git).toHaveBeenCalledWith(
      [
        "push",
        "--no-verify",
        `--force-with-lease=refs/heads/feat/x:${env.info.headSha}`,
        "origin",
        "HEAD:refs/heads/feat/x",
      ],
      env.checkout.worktree,
      120_000,
    );
  });
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
        expect(pushes.map(([argv]) => argv)).toEqual([
          [
            "push",
            "--no-verify",
            `--force-with-lease=refs/heads/feat/x:${env.info.headSha}`,
            "origin",
            "HEAD:refs/heads/feat/x",
          ],
        ]);
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

const MINOR: AgreedItem = { kind: "finding", key: "f-1", severity: "minor", issue: "Leak", trigger: "normal" };
const THREAD: AgreedItem = {
  kind: "thread",
  key: "t-1",
  issue: "Rename this",
  reason: "Clearer name",
  threadId: "T1",
  replyTo: "1",
};
const COMMENT: AgreedItem = { kind: "comment", key: "c-1", issue: "Change the flag", reason: "Asked for it" };

/** A review of the given items, stating `blockingTriggers` when the case needs a narrower set. */
function envWith(agreed: readonly AgreedItem[], blockingTriggers?: readonly FindingTrigger[]): BotFixEnv {
  const base = makeBotFixEnv(agreed);
  return blockingTriggers === undefined
    ? base
    : { ...base, review: { ...base.review, blockingTriggers: [...blockingTriggers] } };
}

function recordingFix() {
  const run = mock<typeof _fixStepsDeps.runBranchFix>(async () => ({ autoCommitted: false, dirty: false }));
  _fixStepsDeps.runBranchFix = run;
  return run;
}

describe("fixStep push-worthiness (US-007)", () => {
  test("AC-1: a minor finding alone is a follow-up, not a fix", async () => {
    expect(await fixStep(envWith([MINOR]), state)).toEqual({
      exit: "nothing",
      patch: { agreedCount: 1, outcome: "nothing", followUps: [{ key: "f-1", severity: "minor", trigger: "normal" }] },
    });
  });
  test("AC-2: a minor finding alone starts no fix session", async () => {
    const run = recordingFix();
    await fixStep(envWith([MINOR]), state);
    expect(run).not.toHaveBeenCalled();
  });
  test("AC-3: an important finding outside the blocking set is nothing", async () => {
    const agreed: AgreedItem[] = [
      { kind: "finding", key: "f-2", severity: "important", issue: "Race", trigger: "adversarial" },
    ];
    const result = await fixStep(envWith(agreed, ["normal", "own-concurrency"]), state);
    expect(result.patch).toMatchObject({ agreedCount: 1, outcome: "nothing" });
    expect(result.exit).toBe("nothing");
  });
  test("AC-4: an important finding outside the blocking set starts no fix session", async () => {
    const agreed: AgreedItem[] = [
      { kind: "finding", key: "f-2", severity: "important", issue: "Race", trigger: "adversarial" },
    ];
    const run = recordingFix();
    await fixStep(envWith(agreed, ["normal", "own-concurrency"]), state);
    expect(run).not.toHaveBeenCalled();
  });
  test("AC-5: a finding with no trigger is a normal follow-up", async () => {
    const agreed: AgreedItem[] = [{ kind: "finding", key: "f-3", severity: "minor", issue: "Nit" }];
    expect((await fixStep(envWith(agreed), state)).patch?.followUps).toEqual([
      { key: "f-3", severity: "minor", trigger: "normal" },
    ]);
  });
  test("AC-6: one blocking finding runs the session with every agreed finding", async () => {
    const run = recordingFix();
    const agreed: AgreedItem[] = [
      MINOR,
      { kind: "finding", key: "f-2", severity: "important", issue: "Race", trigger: "normal" },
    ];
    expect((await fixStep(envWith(agreed), state)).exit).toBe("ran");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1].findings).toEqual(toFixFindings(agreed));
    expect(run.mock.calls[0]?.[1].findings.map((finding) => finding.id)).toEqual(["f-1", "f-2"]);
  });
  test("AC-7: an agreed thread runs the session whatever the findings' severity", async () => {
    const run = recordingFix();
    expect((await fixStep(envWith([MINOR, THREAD]), state)).exit).toBe("ran");
    expect(run).toHaveBeenCalledTimes(1);
  });
  test("AC-8: an agreed comment runs the session whatever the findings' severity", async () => {
    const run = recordingFix();
    expect((await fixStep(envWith([MINOR, COMMENT]), state)).exit).toBe("ran");
    expect(run).toHaveBeenCalledTimes(1);
  });
  test("AC-9: a review stating no blocking set falls back to the configured default", async () => {
    const agreed: AgreedItem[] = [
      { kind: "finding", key: "f-4", severity: "important", issue: "Manual edit", trigger: "manual" },
    ];
    const result = await fixStep(envWith(agreed), state);
    expect(result.exit).toBe("nothing");
    expect(result.patch?.followUps).toEqual([{ key: "f-4", severity: "important", trigger: "manual" }]);
  });
  test("AC-10: no agreed items returns nothing with no followUps key", async () => {
    const result = await fixStep(makeBotFixEnv(), state);
    expect(result).toEqual({ patch: { agreedCount: 0, outcome: "nothing" }, exit: "nothing" });
    expect(result.patch).not.toHaveProperty("followUps");
  });
});
