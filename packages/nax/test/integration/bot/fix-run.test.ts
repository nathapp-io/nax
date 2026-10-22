import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { makeBotFixDeps, makeBotFixEnv, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import type { resolveBotChecks } from "@/bot/checks";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import { openBotLog } from "@/bot/log";
import { NaxError } from "@/errors";
import { NAX_WORKFLOW_PR_MARKER, type PrComment, withNaxBotMarker } from "@/forge";
import { getLogger, initLogger, resetLogger } from "@/logger";
import { botRulingReadOp } from "@/operations";
import { botChecksExtractOp } from "@/operations/bot-checks-extract";
import { botRunDir } from "@/workflow/paths";
import { _workflowDeps } from "@/workflow/step-context";

const originalCallOp = _workflowDeps.callOp;
const resolve = mock<typeof resolveBotChecks>(async () => env.checks);
const original = { ..._botFixDeps };
const input = { dir: "/repo/sub", pr: 42, profiles: ["a"], interactive: false };
let env: ReturnType<typeof makeBotFixEnv>;
let runtime: ReturnType<typeof makeTestRuntime>;
let events: string[];
let topComments: PrComment[];
const prepare = mock<typeof _botFixDeps.preparePrCheckout>(async () => env.checkout);
const load = mock<typeof _botFixDeps.loadBotConfig>(async () => env.config);
const latest = mock<typeof _botFixDeps.loadLatestReview>(async () => env.review);
const access = mock<typeof _botFixDeps.checkPushAccess>(async () => ({ ok: true }));
const preRun = mock<typeof _botFixDeps.runPreRunSteps>(async () => {
  events.push("pre-run");
});
const fix = mock<typeof _botFixDeps.fixStep>(async () => {
  events.push("fix");
  return { patch: { outcome: "nothing" }, exit: "nothing" };
});
const dispose = mock(async () => {
  events.push("context-close");
});
const write = mock<typeof _botFixDeps.writeJson>(async () => {});
const user = mock<typeof _botFixDeps.readCurrentUser>(async () => env.user);
const threads = mock<typeof _botFixDeps.listReviewThreads>(async () => [...env.threads]);
const comments = mock<typeof _botFixDeps.listPrComments>(async () => topComments);

beforeEach(() => {
  events = [];
  topComments = [];
  env = makeBotFixEnv();
  env = {
    ...env,
    info: { ...env.info, headRef: "feat/x", headSha: "abcdef123456" },
    checks: {
      source: "detected",
      gates: [{ name: "test", command: "npm run test" }],
      preRun: [{ command: "npm ci", timeoutSeconds: 600 }],
    },
    config: makeNaxConfig({ execution: { preRun: [{ command: "install-deps", timeoutSeconds: 30 }] } }),
    checkout: {
      ...env.checkout,
      dispose: async () => {
        events.push("checkout-close");
      },
    },
  };
  runtime = makeTestRuntime({ config: env.config });
  const close = runtime.close.bind(runtime);
  runtime.close = mock(async () => {
    events.push("runtime-close");
    await close();
  });
  for (const fn of [prepare, load, latest, access, preRun, fix, dispose, write, user, threads, comments])
    fn.mockClear();
  resolve.mockClear();
  resolve.mockImplementation(async () => env.checks);
  latest.mockImplementation(async () => env.review);
  access.mockImplementation(async () => ({ ok: true }));
  preRun.mockImplementation(async () => {
    events.push("pre-run");
  });
  fix.mockImplementation(async () => {
    events.push("fix");
    return { patch: { outcome: "nothing" }, exit: "nothing" };
  });
  dispose.mockImplementation(async () => {
    events.push("context-close");
  });
  Object.assign(_botFixDeps, {
    ...makeBotFixDeps(env, runtime),
    gitToplevel: async () => "/repo",
    ensureProjectTrusted: async () => {
      events.push("trust");
    },
    resolvePrRef: async () => {
      events.push("resolve");
      return env.ref;
    },
    readPrInfo: async () => env.info,
    preparePrCheckout: prepare,
    loadBotConfig: load,
    buildPrStepContext: async () => ({ ctx: env.ctx, dispose }),
    loadLatestReview: latest,
    resolveBotChecks: resolve,
    checkPushAccess: access,
    runPreRunSteps: preRun,
    readCurrentUser: user,
    listReviewThreads: threads,
    listPrComments: comments,
    fixStep: fix,
    readyStep: async () => ({ patch: {}, exit: "report" }),
    reportStep: async () => ({ patch: {}, exit: "done" }),
    writeJson: write,
    randomSuffix: () => "1234abcd",
  });
});
afterEach(async () => {
  Object.assign(_botFixDeps, original);
  _workflowDeps.callOp = originalCallOp;
  await runtime.close();
});

describe("runBotFix", () => {
  test.each([false, true])("AC-17/18 records marked PR before fix; failure=%s", async (fails) => {
    topComments = [{ id: "note", kind: "comment", author: "writer", body: "triaged note", createdAt: "" }];
    env = {
      ...env,
      info: { ...env.info, body: NAX_WORKFLOW_PR_MARKER },
      threads: [
        {
          id: "raw",
          replyTo: "1",
          resolved: false,
          outdated: false,
          comments: [
            { ...topComments[0], id: "reply", kind: "thread", author: "writer", body: "raw thread", createdAt: "" },
          ],
        },
      ],
    };
    const record = mock<typeof _botFixDeps.recordPrRulings>(async (args) => {
      events.push("rulings");
      expect(await args.readModel({ items: [] })).toBeNull();
      if (fails) throw new Error("record denied");
      return { recorded: [], settled: [], open: [], asked: 0, failed: 0 };
    });
    _botFixDeps.recordPrRulings = record;
    const call = spyOn(_workflowDeps, "callOp").mockResolvedValue(null);
    const warn = spyOn(getLogger(), "warn");
    try {
      expect(await runBotFix(input)).toMatchObject({ outcome: "nothing" });
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0]?.[0].threads).toEqual(env.threads);
      expect(record.mock.calls[0]?.[0].comments).toEqual(topComments);
      expect(events.indexOf("rulings")).toBeLessThan(events.indexOf("fix"));
      expect(fix).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledWith(env.ctx.callCtx, botRulingReadOp, { items: [], model: "fast" });
      if (fails)
        expect(warn).toHaveBeenCalledWith("bot-fix", "Could not record PR rulings", { pr: 42, error: "record denied" });
    } finally {
      warn.mockRestore();
      call.mockRestore();
    }
  });
  test("checks AC-1/2/3 saved detected checks run without base config even after base moves", async () => {
    env = {
      ...env,
      checkout: { ...env.checkout, hasBaseNax: false, baseSha: "moved-base" },
      review: { ...env.review, version: 2, checks: env.checks, events: [] },
    };
    expect(await runBotFix(input)).toMatchObject({ outcome: "nothing" });
    expect(resolve).not.toHaveBeenCalled();
    expect(fix.mock.calls[0]?.[0].checks).toBe(env.checks);
  });
  test.each([1, 2] as const)(
    "checks AC-4/5/6 version %s fallback resolves base checks and extracts through callOp",
    async (version) => {
      if (version === 2) env = { ...env, review: { ...env.review, version: 2, checks: null, events: [] } };
      const call = spyOn(_workflowDeps, "callOp").mockResolvedValue(null);
      resolve.mockImplementation(async (args) => {
        expect(await args.extract({ fileName: "AGENTS.md", text: "instructions" })).toBeNull();
        return env.checks;
      });
      await runBotFix(input);
      expect(resolve).toHaveBeenCalledWith({
        repoRoot: env.repoRoot,
        baseSha: env.checkout.baseSha,
        snapshotDir: env.checkout.snapshotDir,
        hasBaseNax: env.checkout.hasBaseNax,
        config: env.config,
        extract: expect.any(Function),
      });
      expect(call).toHaveBeenCalledWith(env.ctx.callCtx, botChecksExtractOp, {
        fileName: "AGENTS.md",
        text: "instructions",
        model: env.config.bot?.models.checks,
      });
      expect(fix.mock.calls[0]?.[0].checks).toBe(env.checks);
    },
  );
  test("checks AC-8 saved none refuses without resolution or fix", async () => {
    env = {
      ...env,
      review: { ...env.review, version: 2, checks: { source: "none", gates: [], preRun: [] }, events: [] },
    };
    expect(await runBotFix(input)).toEqual({
      outcome: "refused",
      reason:
        "no check commands found on the base branch; add quality.commands to .nax/config.json, or list the commands in AGENTS.md or CLAUDE.md, then merge it",
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(fix).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe("checkout-close");
  });
  test("AC-1/2 cross-repo refuses without checkout", async () => {
    env = { ...env, info: { ...env.info, crossRepo: true } };
    expect(await runBotFix(input)).toEqual({
      outcome: "refused",
      reason: "head branch is in another repository; nax bot fix cannot push to it",
    });
    expect(prepare).not.toHaveBeenCalled();
  });
  test("AC-3/4 untrusted refuses without checkout", async () => {
    _botFixDeps.classifyPrTrust = async () => ({
      trusted: false,
      headSha: env.info.headSha,
      reasons: ["author has no write access"],
    });
    expect(await runBotFix(input)).toEqual({ outcome: "refused", reason: "untrusted PR: author has no write access" });
    expect(prepare).not.toHaveBeenCalled();
  });
  test("AC-5 closed PR refuses before checkout", async () => {
    env = { ...env, info: { ...env.info, state: "closed" } };
    expect(await runBotFix(input)).toEqual({ outcome: "refused", reason: "PR #42 is closed" });
    expect(prepare).not.toHaveBeenCalled();
  });
  test("AC-6 does not pin head files; forwards profiles and trust ordering", async () => {
    await runBotFix(input);
    expect(prepare).toHaveBeenCalledWith({
      repoRoot: "/repo",
      ref: env.ref,
      info: env.info,
      suffix: "1234abcd",
      pinBaseFiles: false,
    });
    expect(load).toHaveBeenCalledWith({ snapshotDir: "/snapshot", profiles: input.profiles });
    expect(events.slice(0, 2)).toEqual(["trust", "resolve"]);
  });
  test("checks AC-7/9/10 missing checks refuses before triage and disposes checkout", async () => {
    env = { ...env, checkout: { ...env.checkout, hasBaseNax: false } };
    resolve.mockImplementation(async () => ({ source: "none", gates: [], preRun: [] }));
    expect(await runBotFix(input)).toEqual({
      outcome: "refused",
      reason:
        "no check commands found on the base branch; add quality.commands to .nax/config.json, or list the commands in AGENTS.md or CLAUDE.md, then merge it",
    });
    expect(fix).not.toHaveBeenCalled();
    expect(user).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe("checkout-close");
  });
  test("AC-8 exact head lookup uses runtime output directory", async () => {
    await runBotFix(input);
    expect(latest).toHaveBeenCalledWith(runtime.outputDir, 42, env.info.headSha);
  });
  test("AC-9/10 no review refuses before fix or push access", async () => {
    latest.mockImplementation(async () => null);
    expect(await runBotFix(input)).toEqual({
      outcome: "refused",
      reason: "no nax bot review of head abcdef1; run nax bot review 42 first",
    });
    expect(fix).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(events.slice(-3)).toEqual(["context-close", "runtime-close", "checkout-close"]);
  });
  test("AC-11/12/17 push refusal never fixes and closes runtime", async () => {
    access.mockImplementation(async () => ({ ok: false, reason: "denied" }));
    expect(await runBotFix(input)).toEqual({ outcome: "refused", reason: "cannot push to feat/x: denied" });
    expect(access).toHaveBeenCalledWith("/worktree", "feat/x");
    expect(resolve).not.toHaveBeenCalled();
    expect(fix).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(events.slice(-3)).toEqual(["context-close", "runtime-close", "checkout-close"]);
  });
  test("AC-13/14 pre-run uses loaded steps before fix", async () => {
    await runBotFix(input);
    expect(preRun).toHaveBeenCalledWith({ steps: env.checks.preRun, workdir: "/worktree" });
    expect(events.indexOf("pre-run")).toBeLessThan(events.indexOf("fix"));
    expect(fix).toHaveBeenCalledTimes(1);
  });
  test("AC-15/16 pre-run failure resolves as setup-failed without fix", async () => {
    const failure = new NaxError("[execution] setup failed", "PRE_RUN_FAILED", {
      stage: "execution",
      command: "bun install",
    });
    preRun.mockImplementation(async () => {
      throw failure;
    });
    expect(await runBotFix(input)).toMatchObject({ outcome: "setup-failed", setupFailed: "bun install" });
    expect(fix).not.toHaveBeenCalled();
    expect(events.slice(-3)).toEqual(["context-close", "runtime-close", "checkout-close"]);
  });
  test("AC-18/19 fix failure cleans up in order", async () => {
    const failure = new Error("fix failed");
    fix.mockImplementation(async () => {
      throw failure;
    });
    await expect(runBotFix(input)).rejects.toBe(failure);
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(events.slice(-3)).toEqual(["context-close", "runtime-close", "checkout-close"]);
  });
  test("forwards model and reads forge inputs once, retaining own thread scope", async () => {
    const own = {
      id: "C",
      author: "bot",
      body: withNaxBotMarker("hi", "finding-a"),
      kind: "thread" as const,
      createdAt: "today",
    };
    env = {
      ...env,
      threads: [
        {
          id: "T",
          replyTo: "C",
          resolved: false,
          outdated: false,
          comments: [own, { ...own, id: "other", author: "human" }],
        },
      ],
    };
    expect(await runBotFix({ ...input, model: "fast" })).toMatchObject({ outcome: "nothing", step: "done" });
    expect(fix.mock.calls[0]?.[0]).toMatchObject({
      model: "fast",
      threads: env.threads,
      own: [{ comment: own, key: "finding-a", threadId: "T" }],
      repoRoot: "/repo",
    });
    for (const fn of [user, threads, comments]) expect(fn).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      join(botRunDir(runtime.outputDir, 42, runtime.runId), "bot-state.json"),
      expect.objectContaining({ step: "done" }),
    );
  });
  test("fresh graph calls every injected node and returns pushed graph fields", async () => {
    const nodes: string[] = [];
    fix.mockImplementation(async () => {
      nodes.push("fix");
      return { patch: { agreedCount: 1 }, exit: "ran" };
    });
    _botFixDeps.checkStep = async () => {
      nodes.push("check");
      return { patch: { changed: ["source"] }, exit: "changed" };
    };
    _botFixDeps.gatesStep = async () => {
      nodes.push("gates");
      return { patch: {}, exit: "passed" };
    };
    _botFixDeps.pushStep = async () => {
      nodes.push("push");
      return { patch: { outcome: "pushed", pushedSha: "new-head" }, exit: "pushed" };
    };
    _botFixDeps.replyStep = async () => {
      nodes.push("reply");
      return { patch: { replied: 1, resolved: 0 }, exit: "ready" };
    };
    _botFixDeps.readyStep = async () => {
      nodes.push("ready");
      return { patch: { markedReady: true }, exit: "report" };
    };
    _botFixDeps.reportStep = async () => {
      nodes.push("report");
      return { patch: {}, exit: "done" };
    };
    expect(await runBotFix(input)).toMatchObject({
      step: "done",
      outcome: "pushed",
      pushedSha: "new-head",
      agreedCount: 1,
      replied: 1,
      resolved: 0,
      markedReady: true,
    });
    expect(nodes).toEqual(["fix", "check", "gates", "push", "reply", "ready", "report"]);
    expect(write).toHaveBeenCalledTimes(7);
    expect(events.slice(-3)).toEqual(["context-close", "runtime-close", "checkout-close"]);
  });
  test.each(["config", "context", "context-dispose", "runtime-close"] as const)(
    "cleanup survives %s failure",
    async (stage) => {
      const failure = new Error(stage);
      if (stage === "config")
        _botFixDeps.loadBotConfig = async () => {
          throw failure;
        };
      if (stage === "context")
        _botFixDeps.buildPrStepContext = async () => {
          throw failure;
        };
      if (stage === "context-dispose")
        dispose.mockImplementation(async () => {
          throw failure;
        });
      if (stage === "runtime-close") {
        const close = runtime.close.bind(runtime);
        runtime.close = async () => {
          await close();
          throw failure;
        };
      }
      try {
        await expect(runBotFix(input)).rejects.toBe(failure);
        expect(events.at(-1)).toBe("checkout-close");
        if (stage !== "config") expect(events).toContain("runtime-close");
      } finally {
        if (stage === "runtime-close") runtime.close = async () => {};
      }
    },
  );
});

describe("US-016 fix logging", () => {
  test("logs start and successful finish milestones", async () => {
    resetLogger();
    initLogger({ level: "silent", useChalk: false });
    const info = spyOn(getLogger(), "info");
    try {
      expect((await runBotFix(input)).outcome).toBe("nothing");
      expect(info).toHaveBeenCalledWith("bot", "Bot fix started", { pr: 42, headSha: env.info.headSha });
      expect(info).toHaveBeenCalledWith("bot", "Bot fix finished", { outcome: "nothing" });
    } finally {
      info.mockRestore();
      resetLogger();
    }
  });
  test("closes the sink before runtime when fix throws", async () => {
    _botFixDeps.openBotLog = () => ({
      path: "/log",
      close: async () => {
        events.push("log-close");
      },
    });
    fix.mockImplementation(async () => {
      throw new NaxError("fix failed", "TEST_FIX", { stage: "test" });
    });
    await expect(runBotFix(input)).rejects.toThrow("fix failed");
    expect(events).toContain("log-close");
    expect(events.indexOf("log-close")).toBeLessThan(events.indexOf("runtime-close"));
  });
  test("AC-15/16 opens run log and returns path, closing before runtime", async () => {
    const path = join(botRunDir(runtime.outputDir, env.ref.number, runtime.runId), "bot.jsonl");
    const open = mock((requested: string) => ({
      path: requested,
      close: async () => {
        events.push("log-close");
      },
    }));
    _botFixDeps.openBotLog = open;
    expect(await runBotFix(input)).toMatchObject({ outcome: "nothing", logPath: path });
    expect(open).toHaveBeenCalledWith(path);
    expect(events.indexOf("log-close")).toBeLessThan(events.indexOf("runtime-close"));
  });
  test("AC-17/18 no-check refusal logs outcome and retains path", async () => {
    resetLogger();
    initLogger({ level: "silent", useChalk: false });
    const infoLog = spyOn(getLogger(), "info");
    _botFixDeps.openBotLog = () => ({ path: "/log", close: async () => {} });
    resolve.mockImplementation(async () => ({ source: "none", gates: [], preRun: [] }));
    try {
      const result = await runBotFix(input);
      expect(result).toMatchObject({ outcome: "refused", logPath: "/log" });
      expect(infoLog).toHaveBeenCalledWith(
        "bot",
        "Bot fix finished",
        expect.objectContaining({ outcome: "refused", reason: expect.stringContaining("no check commands") }),
      );
    } finally {
      infoLog.mockRestore();
      resetLogger();
    }
  });
  test("AC-19 closed PR never opens a log", async () => {
    _botFixDeps.readPrInfo = async () => ({ ...env.info, state: "closed" });
    const open = mock(() => ({ path: "/log", close: async () => {} }));
    _botFixDeps.openBotLog = open;
    const result = await runBotFix(input);
    expect(result.outcome).toBe("refused");
    expect(result).not.toHaveProperty("logPath");
    expect(open).not.toHaveBeenCalled();
  });
  test("AC-24 post-runtime fix without logger omits logPath", async () => {
    resetLogger();
    _botFixDeps.openBotLog = openBotLog;
    const result = await runBotFix(input);
    expect(result.outcome).toBe("nothing");
    expect(result).not.toHaveProperty("logPath");
  });
});

describe("runBotFix log initialization cleanup", () => {
  test("closes runtime if opening the sink unexpectedly throws", async () => {
    const close = spyOn(runtime, "close");
    _botFixDeps.openBotLog = () => {
      throw new NaxError("sink failure", "TEST_SINK", { stage: "test" });
    };
    await expect(runBotFix(input)).rejects.toThrow("sink failure");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
