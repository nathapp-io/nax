import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixEnv, makeNaxConfig } from "@test/helpers";
import { _botFixDeps, BOT_FIX_GRAPH } from "@/bot/fix-run";
import { _fixStepsDeps, type BotFixState, checkStep, gatesStep } from "@/bot/fix-steps";
import { gateOutputTail } from "@/finish/gates/quality";
import { runStepGraph } from "@/step-graph";

const original = { ..._fixStepsDeps };
const graphOriginal = { ..._botFixDeps };
const state = (patch: Partial<BotFixState> = {}): BotFixState => ({ step: "gates", timings: {}, ...patch });
function envFor(rounds = 1, spent = 0) {
  const base = makeBotFixEnv();
  return {
    ...base,
    config: makeNaxConfig({ bot: { gateRepairRounds: rounds } }),
    cost: { limitUsd: 5, spentUsd: () => spent },
    checks: {
      ...base.checks,
      gates: [
        { name: "test", command: "test-command" },
        { name: "lint", command: "lint-command" },
      ],
    },
  };
}
beforeEach(() => {
  _fixStepsDeps.runGit = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  _fixStepsDeps.readHead = async () => "fix-sha";
  _fixStepsDeps.failingOnHead = async () => [];
  _fixStepsDeps.readHeadCi = async () => ({ outcome: "green", detail: "" });
  _fixStepsDeps.runBranchFix = mock(async () => ({ dirty: false, autoCommitted: false }));
  _fixStepsDeps.runQualityGates = async () => ({ passed: false, failing: ["test"], ran: ["test"], output: "" });
});
afterEach(() => {
  Object.assign(_fixStepsDeps, original);
  Object.assign(_botFixDeps, graphOriginal);
});

describe("gatesStep repair eligibility", () => {
  test("AC-1 eligible red gate repairs", async () => {
    expect((await gatesStep(envFor(), state())).exit).toBe("repair");
  });
  test("AC-2 zero rounds preserves classification and adds tails", async () => {
    expect(await gatesStep(envFor(0), state())).toEqual({
      exit: "failed",
      patch: {
        failingGates: ["test"],
        baselineFailing: [],
        ciOutcome: "green",
        outcome: "gates-failed",
        gateTails: [{ name: "test", tail: "(no output captured)" }],
      },
    });
  });
  test("AC-3 exhausted rounds fail", async () => {
    expect((await gatesStep(envFor(), state({ gateRepairRounds: 1 }))).exit).toBe("failed");
  });
  test("AC-4 baseline red with failed CI fails", async () => {
    _fixStepsDeps.failingOnHead = async () => ["test"];
    _fixStepsDeps.readHeadCi = async () => ({ outcome: "failed", detail: "" });
    expect((await gatesStep(envFor(), state())).exit).toBe("failed");
  });
  test.each([5, 6])("AC-5/20 spent budget %s skips repair", async (spent) => {
    expect(await gatesStep(envFor(1, spent), state())).toMatchObject({
      exit: "failed",
      patch: { repairSkippedForCost: true },
    });
  });
  test("cost is not the sole reason when rounds are exhausted", async () => {
    expect((await gatesStep(envFor(0, 5), state())).patch?.repairSkippedForCost).toBeUndefined();
  });
  test.each([0, 1])("baseline green CI still obeys rounds %s and cost", async (rounds) => {
    _fixStepsDeps.failingOnHead = async () => ["test"];
    expect((await gatesStep(envFor(rounds), state())).exit).toBe(rounds ? "repair" : "failed");
    expect((await gatesStep(envFor(rounds, 5), state())).exit).toBe("failed");
  });
  test("AC-6 every failing gate carries its own output tail", async () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    _fixStepsDeps.runQualityGates = async (_root, _commands, opts) => {
      for (const name of ["test", "lint"])
        opts?.onGate?.({
          name,
          cwd: "/worktree",
          output: name === "test" ? output : "lint error",
          status: "failed",
          exitCode: 1,
          durationMs: 1,
        });
      return { passed: false, failing: ["test", "lint"], ran: ["test", "lint"], output: "combined" };
    };
    expect((await gatesStep(envFor(), state())).patch?.gateTails).toEqual([
      { name: "test", tail: gateOutputTail(output) },
      { name: "lint", tail: gateOutputTail("lint error") },
    ]);
  });
  test("AC-7 missing record uses explicit fallback", async () => {
    expect((await gatesStep(envFor(), state())).patch?.gateTails).toEqual([
      { name: "test", tail: "(no output captured)" },
    ]);
  });
});

describe("repairStep", () => {
  test("AC-8/9/10 builds repair prompt with every tail and increments round", async () => {
    const env = envFor();
    const run = mock<typeof _fixStepsDeps.runBranchFix>(async () => ({ dirty: false, autoCommitted: false }));
    _fixStepsDeps.runBranchFix = run;
    const result = await _botFixDeps.repairStep(
      env,
      state({
        outcome: "gates-failed",
        gateRepairRounds: 2,
        gateTails: [
          { name: "test", tail: "test broke" },
          { name: "lint", tail: "lint broke" },
        ],
      }),
    );
    expect(result).toEqual({ exit: "ran", patch: { gateRepairRounds: 3, repairMode: "repair" } });
    expect(_fixStepsDeps.runBranchFix).toHaveBeenCalledWith(env.ctx, {
      findings: [],
      model: undefined,
      prompt: expect.stringContaining("test broke"),
    });
    const prompt = run.mock.calls[0]?.[1].prompt ?? "";
    expect(prompt).toContain("lint broke");
    expect(prompt).toContain("holds the fix commit");
  });
  test.each([
    { failure: "session failed", dirty: false },
    { dirty: true, autoCommitted: false },
  ])("AC-11/12 session results propagate %j", async (session) => {
    _fixStepsDeps.runBranchFix = async () => ({ ...session, autoCommitted: false });
    const result = await _botFixDeps.repairStep(envFor(), state({ outcome: "gates-failed" }));
    expect(result.exit).toBe("ran");
    expect(result.patch).toMatchObject(session.dirty ? { fixDirty: true } : { fixFailure: "session failed" });
  });
  test("AC-13 moved repair HEAD is allowed", async () => {
    let head = "before";
    _fixStepsDeps.readHead = async () => head;
    _fixStepsDeps.runBranchFix = async () => {
      head = "after";
      return { dirty: false, autoCommitted: false };
    };
    expect((await _botFixDeps.repairStep(envFor(), state({ outcome: "gates-failed" }))).exit).toBe("ran");
    expect(head).toBe("after");
  });
  test("AC-19 failed baseline restore exits without a session or patch", async () => {
    const env = envFor();
    _fixStepsDeps.readHead = async () => env.info.headSha;
    expect(await _botFixDeps.repairStep(env, state({ outcome: "gates-failed", fixSha: "fix-sha" }))).toEqual({
      exit: "out-of-scope",
      patch: {},
    });
    expect(_fixStepsDeps.runBranchFix).not.toHaveBeenCalled();
  });
  test("AC-22 dirty session survives a clean status on next check", async () => {
    _fixStepsDeps.runBranchFix = async () => ({ dirty: true, autoCommitted: false });
    const initial = state({ outcome: "gates-failed" });
    const result = await _botFixDeps.repairStep(envFor(), initial);
    expect(await checkStep(envFor(), { ...initial, ...result.patch })).toMatchObject({
      exit: "dirty",
      patch: { outcome: "dirty" },
    });
  });
});
describe("BOT_FIX_GRAPH repair loop", () => {
  test.each([true, false])("AC-14/15/16 second gates green=%s", async (green) => {
    const events: string[] = [];
    let runs = 0;
    _fixStepsDeps.runQualityGates = async () => {
      runs++;
      return { passed: green && runs === 2, failing: green && runs === 2 ? [] : ["test"], ran: ["test"], output: "" };
    };
    _botFixDeps.fixStep = async () => {
      events.push("fix");
      return { exit: "ran", patch: {} };
    };
    _botFixDeps.checkStep = async () => {
      events.push("check");
      return { exit: "changed", patch: {} };
    };
    _botFixDeps.gatesStep = async (env, rec) => {
      events.push("gates");
      return gatesStep(env, rec);
    };
    const repair = _botFixDeps.repairStep;
    _botFixDeps.repairStep = async (env, rec) => {
      events.push("repair");
      return repair(env, rec);
    };
    _botFixDeps.pushStep = async () => {
      events.push("push");
      return { exit: "pushed", patch: { outcome: "pushed", pushedSha: "sha" } };
    };
    _botFixDeps.replyStep = async () => ({ exit: "ready", patch: {} });
    _botFixDeps.readyStep = async () => ({ exit: "report", patch: {} });
    _botFixDeps.reportStep = async () => ({ exit: "done", patch: {} });
    const result = await runStepGraph(
      BOT_FIX_GRAPH,
      envFor(),
      state({ step: "fix" }),
      { persist: async () => {} },
      { now: () => 0, aborted: () => false },
    );
    expect(events).toEqual(["fix", "check", "gates", "repair", "check", "gates", ...(green ? ["push"] : [])]);
    expect(result.outcome).toBe(green ? "pushed" : "gates-failed");
    expect(result.gateRepairRounds).toBe(1);
  });
});
