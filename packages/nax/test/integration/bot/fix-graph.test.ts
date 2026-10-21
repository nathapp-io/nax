import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { makeBotFixDeps, makeBotFixDraftEnv, makeBotFixEnv, makeTestRuntime } from "@test/helpers";
import { _fixReportDeps, BOT_FIX_GRAPH, type BotFixEnv, readyStep } from "@/bot";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import type { BotFixState, BotFixStep } from "@/bot/fix-steps";
import { NAX_WORKFLOW_PR_MARKER } from "@/forge";
import { runStepGraph } from "@/step-graph";
import { botRunDir } from "@/workflow/paths";

const original = { ..._botFixDeps };
const input = { dir: "/repo", pr: 42, profiles: [], interactive: false };
let runtime: ReturnType<typeof makeTestRuntime>;
let calls: BotFixStep[];
let writes: { path: string; value: unknown }[];

beforeEach(() => {
  calls = [];
  writes = [];
  const env = makeBotFixEnv();
  runtime = makeTestRuntime({ config: env.config });
  Object.assign(_botFixDeps, {
    ...makeBotFixDeps(env, runtime),
    readPrInfo: async () => ({ ...env.info, draft: true }),
    writeJson: async (path: string, value: unknown) => {
      writes.push({ path, value: structuredClone(value) });
    },
  });
  _botFixDeps.fixStep = async () => {
    calls.push("fix");
    return { patch: { agreedCount: 1 }, exit: "ran" };
  };
  _botFixDeps.checkStep = async () => {
    calls.push("check");
    return { patch: { changed: ["source"] }, exit: "changed" };
  };
  _botFixDeps.gatesStep = async () => {
    calls.push("gates");
    return { patch: {}, exit: "passed" };
  };
  _botFixDeps.pushStep = async () => {
    calls.push("push");
    return { patch: { outcome: "pushed", pushedSha: "abcdef12" }, exit: "pushed" };
  };
  _botFixDeps.replyStep = async () => {
    calls.push("reply");
    return { patch: { replied: 1, resolved: 1 }, exit: "ready" };
  };
  _botFixDeps.readyStep = async () => {
    calls.push("ready");
    return { patch: { markedReady: true }, exit: "report" };
  };
  _botFixDeps.reportStep = async () => {
    calls.push("report");
    return { patch: {}, exit: "done" };
  };
});
afterEach(async () => {
  mock.restore();
  Object.assign(_botFixDeps, original);
  await runtime.close();
});

describe("runBotFix graph routing", () => {
  test("AC-1/12 success executes all seven injected nodes and returns final state", async () => {
    expect(await runBotFix(input)).toMatchObject({
      step: "done",
      outcome: "pushed",
      pushedSha: "abcdef12",
      agreedCount: 1,
      replied: 1,
      resolved: 1,
      markedReady: true,
    });
    expect(calls).toEqual(["fix", "check", "gates", "push", "reply", "ready", "report"]);
    expect(writes).toHaveLength(7);
  });

  test.each([
    {
      ac: "AC-2/3",
      node: "gates",
      exit: "failed",
      outcome: "gates-failed",
      sequence: ["fix", "check", "gates", "report"],
    },
    { ac: "AC-4/5", node: "fix", exit: "nothing", outcome: "nothing", sequence: ["fix", "ready", "report"] },
    {
      ac: "AC-6/7",
      node: "push",
      exit: "rejected",
      outcome: "push-rejected",
      sequence: ["fix", "check", "gates", "push", "report"],
    },
    { ac: "AC-8/9", node: "check", exit: "protected", outcome: "protected", sequence: ["fix", "check", "report"] },
    {
      ac: "dirty trees stop before gates and push",
      node: "check",
      exit: "dirty",
      outcome: "dirty",
      sequence: ["fix", "check", "report"],
    },
    { ac: "AC-10", node: "check", exit: "no-change", outcome: "no-change", sequence: ["fix", "check", "report"] },
    {
      ac: "AC-11",
      node: "gates",
      exit: "no-gates",
      outcome: "no-gates",
      sequence: ["fix", "check", "gates", "report"],
    },
  ] satisfies {
    ac: string;
    node: "fix" | "check" | "gates" | "push";
    exit: string;
    outcome: BotFixState["outcome"];
    sequence: BotFixStep[];
  }[])("$ac routes $exit safely and returns $outcome (AC-12)", async ({ node, exit, outcome, sequence }) => {
    _botFixDeps[`${node}Step`] = async () => {
      calls.push(node);
      return { patch: { outcome }, exit };
    };
    expect(await runBotFix(input)).toMatchObject({ step: "done", outcome });
    expect(calls).toEqual(sequence);
    expect(writes).toHaveLength(sequence.length);
  });

  test("AC-13 persists the fix patch before the next node starts", async () => {
    _botFixDeps.checkStep = async (_env, state) => {
      calls.push("check");
      expect(writes).toEqual([
        {
          path: join(botRunDir(runtime.outputDir, 42, runtime.runId), "bot-state.json"),
          value: expect.objectContaining({ step: "check", agreedCount: 1, timings: expect.any(Object) }),
        },
      ]);
      expect(state.agreedCount).toBe(1);
      return { patch: { outcome: "no-change" }, exit: "no-change" };
    };
    expect(await runBotFix(input)).toMatchObject({ outcome: "no-change" });
    expect(calls).toEqual(["fix", "check", "report"]);
  });
});

describe("BOT_FIX_GRAPH ready node", () => {
  /** The `nothing` route: the fix found nothing to fix, so the ready step is the next node. */
  function nothingRoute(): void {
    _botFixDeps.fixStep = async () => ({ patch: { agreedCount: 0, outcome: "nothing" }, exit: "nothing" });
  }

  /** The graph, run for real — the ready step is the production one, not a stub. */
  function runGraph(env: BotFixEnv): Promise<BotFixState> {
    _botFixDeps.readyStep = readyStep;
    return runStepGraph(
      BOT_FIX_GRAPH,
      env,
      { step: "fix", timings: {} },
      { persist: async () => {} },
      { aborted: () => false, now: () => 0 },
    );
  }

  test("AC-19/20: a failed CI keeps the draft and never marks it ready", async () => {
    const env = makeBotFixDraftEnv();
    spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue({ outcome: "failed", detail: "a check failed" });
    const run = spyOn(env.forge, "run");
    nothingRoute();
    const state = await runGraph(env);
    expect(state.markedReady).toBe(false);
    expect(state.readyHeld).toBe("CI failed: a check failed");
    expect(run).not.toHaveBeenCalled();
  });

  test("AC-21: a marked nax-workflow draft never waits for CI", async () => {
    const env = makeBotFixDraftEnv({ body: `${NAX_WORKFLOW_PR_MARKER}\n\n## Summary` });
    spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue(env.info);
    spyOn(_fixReportDeps, "readCurrentUser").mockResolvedValue(env.user);
    spyOn(_fixReportDeps, "listReviewThreads").mockResolvedValue([]);
    spyOn(_fixReportDeps, "listPrComments").mockResolvedValue([]);
    spyOn(_fixReportDeps, "recordPrRulings").mockResolvedValue({
      recorded: [],
      settled: [],
      open: [],
      asked: 0,
      failed: 0,
    });
    const wait = spyOn(_fixReportDeps, "waitForChecks").mockImplementation(() => {
      throw new Error("waitForChecks must not run on a nax-workflow PR");
    });
    nothingRoute();
    const state = await runGraph(env);
    expect(wait).not.toHaveBeenCalled();
    expect(state.markedReady).toBe(false);
    expect(state.readyHeld).toBe("no nax item index on this PR");
  });
});
