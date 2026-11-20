import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { makeBotFixDeps, makeBotFixDraftEnv, makeBotFixEnv, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import { _fixReportDeps, type AgreedItem, BOT_FIX_GRAPH, type BotFixEnv, readyStep, reportStep } from "@/bot";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import type { BotFixState, BotFixStep } from "@/bot/fix-steps";
import { _fixStepsDeps } from "@/bot/fix-steps";
import { NAX_WORKFLOW_PR_MARKER } from "@/forge";
import { runStepGraph } from "@/step-graph";
import { botRunDir } from "@/workflow/paths";

const original = { ..._botFixDeps };
const stepsOriginal = { ..._fixStepsDeps };
const input = { dir: "/repo", pr: 42, profiles: [], interactive: false };
let runtime: ReturnType<typeof makeTestRuntime>;
let calls: BotFixStep[];
let writes: { path: string; value: unknown }[];

beforeEach(() => {
  spyOn(_fixReportDeps, "listPrComments").mockResolvedValue([]);
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
  _botFixDeps.ledgerStep = async (_env, state) => {
    calls.push("ledger");
    return { patch: {}, exit: state.outcome === "nothing" ? "skip" : "push" };
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
  Object.assign(_fixStepsDeps, stepsOriginal);
  await runtime.close();
});

describe("runBotFix graph routing", () => {
  test("US-009 AC-4/12/13 ledger-only run visits reply and ready with pushed head", async () => {
    _botFixDeps.readPrInfo = async () => ({ ...makeBotFixEnv().info, body: NAX_WORKFLOW_PR_MARKER });
    _botFixDeps.recordPrRulings = async () => ({ recorded: [], settled: [], open: [], asked: 0, failed: 0 });
    _botFixDeps.fixStep = async () => {
      calls.push("fix");
      return { patch: { outcome: "nothing", agreedCount: 0 }, exit: "nothing" };
    };
    _botFixDeps.ledgerStep = async () => {
      calls.push("ledger");
      return { patch: { ledgerCarried: true }, exit: "push" };
    };
    const push = spyOn(_botFixDeps, "pushStep").mockImplementation(async () => {
      calls.push("push");
      return { patch: { outcome: "nothing", pushedSha: "abcdef12" }, exit: "pushed" };
    });
    _botFixDeps.readyStep = async (_env, state) => {
      calls.push("ready");
      expect(state.pushedSha).toBe("abcdef12");
      return { patch: {}, exit: "report" };
    };
    expect(await runBotFix(input)).toMatchObject({ outcome: "nothing", pushedSha: "abcdef12" });
    expect(push).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["fix", "ledger", "push", "reply", "ready", "report"]);
  });
  test("AC-1/12 success executes all eight injected nodes and returns final state", async () => {
    expect(await runBotFix(input)).toMatchObject({
      step: "done",
      outcome: "pushed",
      pushedSha: "abcdef12",
      agreedCount: 1,
      replied: 1,
      resolved: 1,
      markedReady: true,
    });
    expect(calls).toEqual(["fix", "check", "gates", "ledger", "push", "reply", "ready", "report"]);
    expect(writes).toHaveLength(8);
  });

  test.each([
    {
      ac: "AC-2/3",
      node: "gates",
      exit: "failed",
      outcome: "gates-failed",
      sequence: ["fix", "check", "gates", "report"],
    },
    { ac: "AC-4/5", node: "fix", exit: "nothing", outcome: "nothing", sequence: ["fix", "ledger", "ready", "report"] },
    {
      ac: "AC-6/7",
      node: "push",
      exit: "rejected",
      outcome: "push-rejected",
      sequence: ["fix", "check", "gates", "ledger", "push", "report"],
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
  test("US-008 AC-11/12: rejected ready write still posts the fix summary", async () => {
    const env = makeBotFixDraftEnv();
    _botFixDeps.readyStep = readyStep;
    _botFixDeps.reportStep = reportStep;
    spyOn(_fixReportDeps, "waitForPrHead").mockResolvedValue(true);
    spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue({ outcome: "green", detail: "passed" });
    spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue(env.info);
    spyOn(env.forge, "run").mockResolvedValue({ exitCode: 1, stdout: "", stderr: "denied\n" });
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "summary" });
    // Nothing pushed, so no US-001 pushed-head hold stands between the ready write and its report.
    nothingRoute();
    const result = await runGraph(env);
    expect(result.step).toBe("done");
    expect(result.markedReady).toBe(false);
    expect(result.readyHeld).toBe("could not mark ready: denied");
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[1]).toContain("Kept as draft: could not mark ready");
  });

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

  test("US-001 AC-8: a fix that pushed holds readiness for a bot review of the pushed head", async () => {
    _botFixDeps.readyStep = async (env, state) => {
      calls.push("ready");
      return readyStep(env, state);
    };
    _botFixDeps.pushStep = async () => {
      calls.push("push");
      return { patch: { outcome: "pushed", pushedSha: "abc1234def" }, exit: "pushed" };
    };
    spyOn(_fixReportDeps, "waitForPrHead").mockResolvedValue(true);
    const run = spyOn(_botFixDeps.forge, "run");
    const result = await runBotFix(input);
    if (result.outcome === "refused") throw new Error(`refused: ${result.reason}`);
    expect(result.outcome).toBe("pushed");
    expect(result.pushedSha).toBe("abc1234def");
    expect(result.markedReady).not.toBe(true);
    expect(result.readyHeld).toStartWith("pushed abc1234");
    expect(calls).toEqual(["fix", "check", "gates", "ledger", "push", "reply", "ready", "report"]);
    expect(run).not.toHaveBeenCalled();
  });

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

/**
 * #2999: a fix session that failed and left the tree untouched is a failure, not a no-op. These run
 * `runBotFix` with the production `fixStep`, `checkStep` and `gatesStep`, so the classification under
 * test is the real one — only the session boundary and the gates' own command runner are stubbed.
 */
describe("US-005 a failed fix session", () => {
  const FINDING: AgreedItem = {
    kind: "finding",
    key: "f-1",
    severity: "important",
    issue: "Leak",
    file: "src/a.ts",
    trigger: "normal",
  };

  /**
   * A run whose session reports `failure: "boom"` and leaves `changed` behind. No gate repair rounds,
   * so a red gate reports instead of routing back through `repair`.
   */
  function failedSession(changed: readonly string[], gatesPass = true): { gates: string[] } {
    const env = {
      ...makeBotFixEnv([FINDING]),
      config: makeNaxConfig({ bot: { gateRepairRounds: 0 } }),
      checks: { source: "config" as const, gates: [{ name: "test", command: "test-command" }], preRun: [] },
    };
    // The real steps, each recorded, so the sequence under test is the production one.
    _botFixDeps.fixStep = (env, state) => {
      calls.push("fix");
      return original.fixStep(env, state);
    };
    _botFixDeps.checkStep = (env, state) => {
      calls.push("check");
      return original.checkStep(env, state);
    };
    _botFixDeps.gatesStep = (env, state) => {
      calls.push("gates");
      return original.gatesStep(env, state);
    };
    _botFixDeps.loadLatestReview = async () => env.review;
    _botFixDeps.loadBotConfig = async () => env.config;
    _botFixDeps.resolveBotChecks = async () => env.checks;
    _botFixDeps.preparePrCheckout = async () => env.checkout;
    _fixStepsDeps.runBranchFix = async () => ({ dirty: false, autoCommitted: false, failure: "boom" });
    _fixStepsDeps.readHead = async () => "fixed";
    _fixStepsDeps.runGit = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    _fixStepsDeps.changedPaths = async () => [...changed];
    _fixStepsDeps.failingOnHead = async () => [];
    _fixStepsDeps.readHeadCi = async () => ({ outcome: "green", detail: "" });
    const gates: string[] = [];
    _fixStepsDeps.runQualityGates = async (_root, commands) => {
      gates.push(...commands.map(({ name }) => name));
      return { passed: gatesPass, failing: gatesPass ? [] : ["test"], ran: ["test"], output: "" };
    };
    return { gates };
  }

  test("AC-5: a failed session that changed nothing ends fix-failed with its cause", async () => {
    failedSession([]);
    expect(await runBotFix(input)).toMatchObject({ outcome: "fix-failed", fixFailure: "boom" });
    // The run above only reaches the report node because the check node declares the exit:
    // `runStepGraph` refuses an exit its node does not list (STEP_GRAPH_UNDECLARED_EXIT).
    expect(BOT_FIX_GRAPH.nodes.check.exits).toContain("fix-failed");
  });

  test("AC-6: a failed session that changed nothing never reaches the gates", async () => {
    failedSession([]);
    await runBotFix(input);
    expect(calls).toEqual(["fix", "check", "report"]);
  });

  test("AC-14: a failed session that left changes still runs the configured gates", async () => {
    const { gates } = failedSession(["src/a.ts"], false);
    expect(await runBotFix(input)).toMatchObject({ outcome: "gates-failed" });
    expect(calls.slice(0, 3)).toEqual(["fix", "check", "gates"]);
    expect(gates).toEqual(["test"]);
  });

  test("AC-15: that run keeps the session failure in its fix state", async () => {
    failedSession(["src/a.ts"], false);
    expect(await runBotFix(input)).toMatchObject({ outcome: "gates-failed", fixFailure: "boom" });
  });

  test("AC-16: its fix summary still reports the session failure", async () => {
    failedSession(["src/a.ts"], false);
    _botFixDeps.reportStep = (env, state) => {
      calls.push("report");
      return original.reportStep(env, state);
    };
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "summary" });
    await runBotFix(input);
    const bodies = post.mock.calls.map(([, body]) => body);
    expect(bodies.some((body) => body.includes("Fix session: boom"))).toBe(true);
  });
});
