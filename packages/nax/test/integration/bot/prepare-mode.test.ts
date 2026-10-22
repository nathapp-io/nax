import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixEnv } from "@test/helpers";
import { _botFixDeps, BOT_FIX_GRAPH } from "@/bot/fix-run";
import { _fixStepsDeps, type BotFixState, gatesStep } from "@/bot/fix-steps";
import { repairStep } from "@/bot/repair-step";
import { runStepGraph } from "@/step-graph";

const original = { ..._fixStepsDeps };
const graphOriginal = { ..._botFixDeps };
const state = (patch: Partial<BotFixState> = {}): BotFixState => ({
  step: "repair",
  timings: {},
  outcome: "baseline-red",
  ciOutcome: "green",
  fixSha: "fix",
  ...patch,
});
let head: string;
let tracked: string;
const envFor = () => {
  const base = makeBotFixEnv();
  return { ...base, checks: { ...base.checks, gates: [{ name: "test", command: "test-command" }] } };
};
beforeEach(() => {
  head = "fix";
  tracked = "";
  _fixStepsDeps.readHead = async () => head;
  _fixStepsDeps.runGit = mock(async () => ({ exitCode: 0, stdout: tracked, stderr: "" }));
  _fixStepsDeps.runBranchFix = mock(async () => ({ dirty: false, autoCommitted: false }));
  _fixStepsDeps.failingOnHead = async () => ["test"];
  _fixStepsDeps.readHeadCi = async () => ({ outcome: "green", detail: "" });
  _fixStepsDeps.runQualityGates = async () => ({ passed: false, failing: ["test"], ran: ["test"], output: "" });
});
afterEach(() => {
  Object.assign(_fixStepsDeps, original);
  Object.assign(_botFixDeps, graphOriginal);
});

describe("prepare mode", () => {
  test("failed status reports an unreadable boundary rather than a proven tracked change", async () => {
    _fixStepsDeps.runGit = async () => ({ exitCode: 1, stdout: "", stderr: "timeout" });
    expect(await repairStep(envFor(), state())).toMatchObject({
      exit: "out-of-scope",
      patch: { outcome: "prepare-touched-tracked", prepareTreeUnreadable: true, fixSha: "fix" },
    });
  });
  test("AC-1 baseline-red with green CI and rounds left enters repair", async () => {
    expect(await gatesStep(envFor(), state({ step: "gates" }))).toMatchObject({
      exit: "repair",
      patch: { outcome: "baseline-red", ciOutcome: "green" },
    });
  });
  test("AC-2 uses the setup-only prepare prompt", async () => {
    const run = mock<typeof _fixStepsDeps.runBranchFix>(async () => ({ dirty: false, autoCommitted: false }));
    _fixStepsDeps.runBranchFix = run;
    await repairStep(envFor(), state({ gateTails: [{ name: "test", tail: "missing generated output" }] }));
    const prompt = run.mock.calls[0]?.[1].prompt ?? "";
    expect(prompt).toContain("setup only (code generation, installs, builds)");
    expect(prompt).toContain("A tracked change ends the run without a push.");
    expect(prompt).toContain("missing generated output");
    expect(prompt).toContain("holds the fix commit");
  });
  test("AC-3/4 clean prepare patches mode and round and exits ran", async () => {
    const env = envFor();
    expect(await repairStep(env, state())).toEqual({
      exit: "ran",
      patch: { repairMode: "prepare", gateRepairRounds: 1, fixSha: "fix" },
    });
    expect(_fixStepsDeps.runGit).toHaveBeenCalledWith(
      ["status", "--porcelain", "--untracked-files=no"],
      env.checkout.worktree,
    );
  });
  test("AC-5/6 a prepare commit exits out-of-scope with tracked-change outcome", async () => {
    _fixStepsDeps.runBranchFix = async () => {
      head = "committed";
      return { dirty: false, autoCommitted: false };
    };
    expect(await repairStep(envFor(), state())).toMatchObject({
      exit: "out-of-scope",
      patch: { outcome: "prepare-touched-tracked", repairMode: "prepare", gateRepairRounds: 1 },
    });
  });
  test.each([" M tracked.ts\n", "M  tracked.ts\n", " D tracked.ts\n"])(
    "AC-7 rejects tracked porcelain %j",
    async (status) => {
      _fixStepsDeps.runBranchFix = async () => {
        tracked = status;
        return { dirty: true, autoCommitted: false };
      };
      expect(await repairStep(envFor(), state())).toMatchObject({
        exit: "out-of-scope",
        patch: { outcome: "prepare-touched-tracked", fixDirty: true },
      });
    },
  );
  test("AC-8 graph reports a tracked violation without pushing or rechecking", async () => {
    _fixStepsDeps.runBranchFix = async () => {
      tracked = " M tracked.ts\n";
      return { dirty: false, autoCommitted: false };
    };
    const report = mock<typeof _botFixDeps.reportStep>(async () => ({ exit: "done", patch: {} }));
    const push = mock<typeof _botFixDeps.pushStep>(async () => ({ exit: "pushed", patch: {} }));
    const check = mock<typeof _botFixDeps.checkStep>(async () => ({ exit: "changed", patch: {} }));
    Object.assign(_botFixDeps, { reportStep: report, pushStep: push, checkStep: check });
    const result = await runStepGraph(
      BOT_FIX_GRAPH,
      envFor(),
      state(),
      { persist: async () => {} },
      {
        now: () => 0,
        aborted: () => false,
      },
    );
    expect(result.outcome).toBe("prepare-touched-tracked");
    expect(report).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });
  test("AC-11 ordinary repair can commit and leaves tracked restrictions to check", async () => {
    _fixStepsDeps.runBranchFix = async () => {
      head = "committed";
      tracked = " M tracked.ts\n";
      return { dirty: false, autoCommitted: false };
    };
    expect(await repairStep(envFor(), state({ outcome: "gates-failed" }))).toEqual({
      exit: "ran",
      patch: { repairMode: "repair", gateRepairRounds: 1, fixSha: "committed" },
    });
    expect(_fixStepsDeps.runGit).not.toHaveBeenCalled();
  });
});
