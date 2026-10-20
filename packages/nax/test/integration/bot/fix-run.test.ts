import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { makeBotFixEnv, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import { NaxError } from "@/errors";
import { withNaxBotMarker } from "@/forge";
import { botRunDir } from "@/workflow/paths";

const original = { ..._botFixDeps };
const input = { dir: "/repo/sub", pr: 42, profiles: ["a"], interactive: false };
let env: ReturnType<typeof makeBotFixEnv>;
let runtime: ReturnType<typeof makeTestRuntime>;
let events: string[];
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
const comments = mock<typeof _botFixDeps.listPrComments>(async () => []);

beforeEach(() => {
  events = [];
  env = makeBotFixEnv();
  env = {
    ...env,
    info: { ...env.info, headRef: "feat/x", headSha: "abcdef123456" },
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
    gitToplevel: async () => "/repo",
    ensureProjectTrusted: async () => {
      events.push("trust");
    },
    resolvePrRef: async () => {
      events.push("resolve");
      return env.ref;
    },
    readPrInfo: async () => env.info,
    classifyPrTrust: async () => ({ trusted: true, headSha: env.info.headSha, reasons: [] }),
    preparePrCheckout: prepare,
    loadBotConfig: load,
    createRuntime: () => runtime,
    buildPrStepContext: async () => ({ ctx: env.ctx, dispose }),
    loadLatestReview: latest,
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
  await runtime.close();
});

describe("runBotFix", () => {
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
  test("AC-7 missing base config refuses and disposes checkout", async () => {
    env = { ...env, checkout: { ...env.checkout, hasBaseNax: false } };
    expect(await runBotFix(input)).toEqual({
      outcome: "refused",
      reason: "the base branch has no nax config; gates cannot run",
    });
    expect(load).not.toHaveBeenCalled();
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
    expect(events.slice(-3)).toEqual(["context-close", "runtime-close", "checkout-close"]);
  });
  test("AC-11/12/17 push refusal never fixes and closes runtime", async () => {
    access.mockImplementation(async () => ({ ok: false, reason: "denied" }));
    expect(await runBotFix(input)).toEqual({ outcome: "refused", reason: "cannot push to feat/x: denied" });
    expect(access).toHaveBeenCalledWith("/worktree", "feat/x");
    expect(fix).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(events.slice(-3)).toEqual(["context-close", "runtime-close", "checkout-close"]);
  });
  test("AC-13/14 pre-run uses loaded steps before fix", async () => {
    await runBotFix(input);
    expect(preRun).toHaveBeenCalledWith({ steps: env.config.execution.preRun, workdir: "/worktree" });
    expect(events.indexOf("pre-run")).toBeLessThan(events.indexOf("fix"));
    expect(fix).toHaveBeenCalledTimes(1);
  });
  test("AC-15/16 pre-run failure propagates unchanged without fix", async () => {
    const failure = new NaxError("[execution] setup failed", "PRE_RUN_FAILED", { stage: "execution" });
    preRun.mockImplementation(async () => {
      throw failure;
    });
    await expect(runBotFix(input)).rejects.toBe(failure);
    expect(fix).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
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
