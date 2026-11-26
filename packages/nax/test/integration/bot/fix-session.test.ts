import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeBotFixDeps,
  makeBotFixEnv,
  makeNaxConfig,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import type { Advisor } from "@/advisor";
import { _chainAdviseDeps } from "@/bot/chain-advise";
import { parseChainRuling } from "@/bot/chain-rulings";
import { barCommands } from "@/bot/checks";
import { _fixCarriedDeps } from "@/bot/fix-carried";
import { _botFixDeps, BOT_FIX_GRAPH, runBotFix } from "@/bot/fix-run";
import { _fixStepsDeps, fixStep } from "@/bot/fix-steps";
import { withNaxBotMarker } from "@/forge";
import { getLogger } from "@/logger";
import { renderCheckoutState } from "@/prompts";
import { botRunDir } from "@/workflow/paths";

const originalFix = { ..._fixStepsDeps };
const originalRun = { ..._botFixDeps };
const originalChain = { ..._chainAdviseDeps };
const originalCarried = { ..._fixCarriedDeps };
const dirs: string[] = [];
const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
afterEach(async () => {
  Object.assign(_fixStepsDeps, originalFix);
  Object.assign(_botFixDeps, originalRun);
  Object.assign(_chainAdviseDeps, originalChain);
  Object.assign(_fixCarriedDeps, originalCarried);
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(dirs.splice(0).map(cleanupTempDir));
});
const items = [{ kind: "finding" as const, key: "f1", severity: "important" as const, issue: "Leak", file: "a.ts" }];
const state = () => ({ step: "fix" as const, timings: {} });

describe("fixStep PR session", () => {
  test("AC-4/5/6/7/8/16 uses PR intent, fresh checkout and every bar command, then reads HEAD", async () => {
    const base = makeBotFixEnv(items);
    const worktree = makeTempDir("bot-fix-session-");
    dirs.push(worktree);
    await Bun.write(join(worktree, ".github/workflows/ci.yml"), "name: ci");
    const env = {
      ...base,
      info: { ...base.info, url: "https://github.com/o/r/pull/42", headSha: "abcdef123" },
      checkout: { ...base.checkout, worktree, changedFiles: [".nax/features/f/prd.json", ".nax/features/f/spec.md"] },
      checks: {
        source: "config" as const,
        preRun: [{ command: "install", timeoutSeconds: 30 }],
        gates: [{ name: "test", command: ["check-a", "check-b"] }],
      },
    };
    let finished = false;
    const run = mock<typeof _fixStepsDeps.runBranchFix>(async () => {
      finished = true;
      return { dirty: false, autoCommitted: false };
    });
    _fixStepsDeps.runBranchFix = run;
    _fixStepsDeps.readHead = mock(async (path) => {
      expect(path).toBe(worktree);
      expect(finished).toBe(true);
      return "fix-head";
    });
    const result = await fixStep(env, state());
    const input = run.mock.calls[0]?.[1];
    expect(input?.prompt).toContain(`PR #42: ${env.info.url}`);
    expect(input?.prompt).toContain("## The bar\n");
    for (const command of barCommands(env.checks)) expect(input?.prompt).toContain(`- ${command}\n`);
    expect(input?.prompt).toContain(
      renderCheckoutState({
        phase: "fresh",
        headSha: env.info.headSha,
        setup: ["install"],
        ciFiles: [".github/workflows/ci.yml"],
      }),
    );
    expect(input?.prompt).toContain(join(worktree, ".nax/features/f/prd.json"));
    expect(input?.prompt).toContain(join(worktree, ".nax/features/f/spec.md"));
    expect(input?.prompt).toContain(`append a "Fix" section to ${env.ctx.reportPath}`);
    expect(result).toEqual({ exit: "ran", patch: { agreedCount: 1, fixSha: "fix-head" } });
    expect(BOT_FIX_GRAPH.nodes.fix?.produces).toContain("fixSha");
  });
  test("AC-9/13 logs HEAD failure without changing the session patch", async () => {
    _fixStepsDeps.runBranchFix = async () => ({ dirty: true, failure: "interrupted", autoCommitted: false });
    _fixStepsDeps.readHead = async () => {
      throw new Error("head unreadable");
    };
    const warn = spyOn(getLogger(), "warn");
    try {
      expect(await fixStep(makeBotFixEnv(items), state())).toEqual({
        exit: "ran",
        patch: { agreedCount: 1, fixDirty: true, fixFailure: "interrupted" },
      });
      expect(warn).toHaveBeenCalledWith(
        "bot-fix",
        expect.stringContaining("HEAD"),
        expect.objectContaining({ error: "head unreadable" }),
      );
    } finally {
      warn.mockRestore();
    }
  });
  test("AC-15 skips an empty review before session or HEAD reads", async () => {
    const run = mock<typeof _fixStepsDeps.runBranchFix>();
    const head = mock<typeof _fixStepsDeps.readHead>();
    _fixStepsDeps.runBranchFix = run;
    _fixStepsDeps.readHead = head;
    expect(await fixStep(makeBotFixEnv(), state())).toEqual({
      exit: "nothing",
      patch: { agreedCount: 0, outcome: "nothing" },
    });
    expect(run).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
  });
  test("AC-17 preserves failure while adding the post-session SHA", async () => {
    _fixStepsDeps.runBranchFix = async () => ({ dirty: false, failure: "interrupted", autoCommitted: false });
    _fixStepsDeps.readHead = async () => "failed-session-head";
    expect(await fixStep(makeBotFixEnv(items), state())).toEqual({
      exit: "ran",
      patch: { agreedCount: 1, fixFailure: "interrupted", fixSha: "failed-session-head" },
    });
  });
});

describe("runBotFix durable session report", () => {
  test.each([false, true])("report presence is injectable without a report on disk: %s", async (exists) => {
    const root = makeTempDir("bot-report-probe-");
    dirs.push(root);
    const base = makeBotFixEnv();
    const env = { ...base, ctx: { ...base.ctx, reportPath: "/virtual/session-report.md" } };
    const runtime = makeTestRuntime({ config: env.config });
    runtimes.push(runtime);
    const fileExists = mock(async () => exists);
    const copyFile = mock(async () => {});
    Object.assign(_botFixDeps, makeBotFixDeps(env, runtime), {
      fileExists,
      copyFile,
      fixStep: async () => ({ patch: { outcome: "nothing" }, exit: "nothing" }),
      readyStep: async () => ({ patch: {}, exit: "report" }),
      reportStep: async () => ({ patch: {}, exit: "done" }),
    });
    expect(await runBotFix({ dir: root, pr: 42, profiles: [], interactive: false })).toMatchObject({
      outcome: "nothing",
    });
    expect(fileExists).toHaveBeenCalledWith(env.ctx.reportPath);
    expect(copyFile).toHaveBeenCalledTimes(exists ? 1 : 0);
  });
  test.each([false, true])(
    "F1 preserves report before disposal after a node throws; copy fails=%s",
    async (copyFails) => {
      const root = makeTempDir("bot-fix-node-error-");
      dirs.push(root);
      const base = makeBotFixEnv(items);
      const events: string[] = [];
      const env = {
        ...base,
        checks: { ...base.checks, gates: [{ name: "test", command: "check" }] },
        ctx: { ...base.ctx, reportPath: join(root, "session/report.md") },
        checkout: {
          ...base.checkout,
          dispose: async () => {
            events.push("dispose");
          },
        },
      };
      const runtime = makeTestRuntime({ config: env.config });
      runtimes.push(runtime);
      const target = join(botRunDir(runtime.outputDir, 42, runtime.runId), "fix-report.md");
      const failure = new Error("diff read failed");
      const copy = mock(async (from: string, to: string) => {
        events.push("copy");
        if (copyFails) throw new Error("copy denied");
        await originalRun.copyFile(from, to);
      });
      Object.assign(_botFixDeps, makeBotFixDeps(env, runtime), {
        fileExists: originalRun.fileExists,
        copyFile: copy,
        fixStep: async () => {
          await Bun.write(env.ctx.reportPath, "# Fix before check failure\n");
          events.push("fix");
          return { patch: { agreedCount: 1 }, exit: "ran" };
        },
        checkStep: async () => {
          events.push("check");
          throw failure;
        },
      });
      await expect(runBotFix({ dir: root, pr: 42, profiles: [], interactive: false })).rejects.toBe(failure);
      expect(copy).toHaveBeenCalledWith(env.ctx.reportPath, target);
      expect(events).toEqual(["fix", "check", "copy", "dispose"]);
      if (!copyFails) expect(await Bun.file(target).text()).toBe("# Fix before check failure\n");
    },
  );
  test.each(["present", "missing", "copy-fails"] as const)("AC-10/11/12/14 report %s", async (mode) => {
    const root = makeTempDir("bot-fix-report-");
    dirs.push(root);
    const base = makeBotFixEnv();
    const events: string[] = [];
    const env = {
      ...base,
      checks: { ...base.checks, gates: [{ name: "test", command: "check" }] },
      ctx: { ...base.ctx, reportPath: join(root, "session/report.md") },
      checkout: {
        ...base.checkout,
        dispose: async () => {
          events.push("dispose");
        },
      },
    };
    const runtime = makeTestRuntime({ config: env.config });
    runtimes.push(runtime);
    const target = join(botRunDir(runtime.outputDir, 42, runtime.runId), "fix-report.md");
    const copy = mock(async (from: string, to: string) => {
      events.push("copy");
      expect(await Bun.file(from).text()).toBe("# Session fix\n");
      expect(to).toBe(target);
      if (mode === "copy-fails") throw new Error("copy denied");
      await originalRun.copyFile(from, to);
    });
    Object.assign(_botFixDeps, makeBotFixDeps(env, runtime), {
      fileExists: originalRun.fileExists,
      copyFile: copy,
      fixStep: async () => {
        if (mode !== "missing") await Bun.write(env.ctx.reportPath, "# Session fix\n");
        return { patch: { outcome: "nothing" }, exit: "nothing" };
      },
      readyStep: async () => ({ patch: {}, exit: "report" }),
      reportStep: async () => {
        events.push("graph-end");
        return { patch: {}, exit: "done" };
      },
    });
    const warn = spyOn(getLogger(), "warn");
    try {
      expect(await runBotFix({ dir: root, pr: 42, profiles: [], interactive: false })).toMatchObject({
        outcome: "nothing",
        step: "done",
      });
      if (mode === "present") expect(await Bun.file(target).text()).toBe("# Session fix\n");
      else expect(await Bun.file(target).exists()).toBe(false);
      if (mode === "missing") expect(copy).not.toHaveBeenCalled();
      else {
        expect(copy).toHaveBeenCalledWith(env.ctx.reportPath, target);
        expect(events).toEqual(["graph-end", "copy", "dispose"]);
      }
      if (mode === "copy-fails")
        expect(warn).toHaveBeenCalledWith(
          "bot-fix",
          expect.stringContaining("report"),
          expect.objectContaining({ error: "copy denied" }),
        );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("runBotFix chain rulings", () => {
  const chainItem = {
    kind: "finding" as const,
    key: "f-1",
    severity: "important" as const,
    issue: "Leak",
    suggestion: "Close it",
    trigger: "normal" as const,
    lineage: { generation: 2, parents: ["p-1"], pushSha: "abcdef1" },
  };

  async function setup(env = makeBotFixEnv([chainItem])) {
    const root = makeTempDir("bot-fix-chain-");
    dirs.push(root);
    const worktree = makeTempDir("bot-fix-chain-wt-");
    dirs.push(worktree);
    const full = { ...env, checkout: { ...env.checkout, worktree } };
    const runtime = makeTestRuntime({ config: full.config });
    runtimes.push(runtime);
    const run = mock<typeof _fixStepsDeps.runBranchFix>(async () => ({ dirty: false, autoCommitted: false }));
    _fixStepsDeps.runBranchFix = run;
    _fixStepsDeps.readHead = async () => "fix-head";
    Object.assign(_botFixDeps, makeBotFixDeps(full, runtime), {
      checkStep: async () => ({ patch: { outcome: "no-change" }, exit: "no-change" }),
      readyStep: async () => ({ patch: {}, exit: "report" }),
      reportStep: async () => ({ patch: {}, exit: "done" }),
    });
    return { root, run, full };
  }
  const go = (root: string, extra: { readyOnly?: boolean } = {}) =>
    runBotFix({ dir: root, pr: 42, profiles: [], interactive: false, ...extra });
  const fixRuling = { key: "f-1", outcome: "fix" as const, text: "restore the guard" };

  test("AC-14/15 the prompt carries the ruling and the finding drops its suggestion", async () => {
    const { root, run, full } = await setup();
    _botFixDeps.withChainRulings = async (env) => ({ ...env, chainRulings: [fixRuling] });
    await go(root);
    const input = run.mock.calls[0]?.[1];
    expect(input?.prompt).toContain("Advisor ruling: restore the guard");
    expect(input?.findings).toHaveLength(1);
    expect(input?.findings[0] && "suggestion" in input.findings[0]).toBe(false);
    expect(full.review.agreed[0]?.kind).toBe("finding");
  });

  test("AC-16 no session when the advisor removed the only item", async () => {
    const { root, run } = await setup();
    _botFixDeps.withChainRulings = async (env) => ({ ...env, review: { ...env.review, agreed: [] } });
    await go(root);
    expect(run).not.toHaveBeenCalled();
  });

  test("AC-17 a ready-only run skips the routing", async () => {
    const { root } = await setup();
    const routing = mock(async (env: Parameters<typeof _botFixDeps.withChainRulings>[0]) => env);
    _botFixDeps.withChainRulings = routing;
    await go(root, { readyOnly: true });
    expect(routing).not.toHaveBeenCalled();
  });

  test("AC-18 a rejected routing starts no session", async () => {
    const { root, run } = await setup();
    _botFixDeps.withChainRulings = async () => {
      throw new Error("confirmed rulings unreadable");
    };
    await expect(go(root)).rejects.toThrow("confirmed rulings unreadable");
    expect(run).not.toHaveBeenCalled();
  });

  test("AC-19 the routing sees the carried items merged in", async () => {
    const base = makeBotFixEnv();
    const head = "a".repeat(40);
    const { carriedRecordBody, carriedRecordKey } = await import("@/bot/carried-record");
    const { ownComments } = await import("@/forge");
    const { body } = carriedRecordBody({
      headSha: head,
      findings: [{ key: "f-carry", severity: "important", issue: "Race", raisedBy: "review-B" }],
    });
    const env = {
      ...base,
      info: { ...base.info, headSha: head },
      review: { ...base.review, headSha: head },
      own: ownComments(
        [
          {
            id: "1",
            kind: "comment" as const,
            author: "bot",
            body: withNaxBotMarker(body, carriedRecordKey(head)),
            createdAt: "",
          },
        ],
        "bot",
      ),
    };
    const { root } = await setup(env);
    _fixCarriedDeps.readSettledKeys = async () => new Set();
    _botFixDeps.listPrComments = async () => env.own.map(({ comment }) => comment);
    const routing = mock(async (e: Parameters<typeof _botFixDeps.withChainRulings>[0]) => e);
    _botFixDeps.withChainRulings = routing;
    await go(root);
    expect(routing).toHaveBeenCalledTimes(1);
    expect(routing.mock.calls[0]?.[0].review.agreed.map((i) => i.key)).toEqual(["f-carry"]);
  });

  test("AC-20/21 the real routing posts a fix ruling and the prompt carries it", async () => {
    const base = makeBotFixEnv([chainItem]);
    const env = {
      ...base,
      config: makeNaxConfig({ advisor: { enabled: true, callers: { botFixChain: true } } }),
      threads: [
        {
          id: "t1",
          replyTo: "1",
          resolved: false,
          outdated: false,
          comments: [
            { id: "c1", kind: "thread" as const, author: "bot", body: withNaxBotMarker("body", "f-1"), createdAt: "" },
          ],
        },
      ],
      checkout: {
        ...base.checkout,
        changedFiles: [".nax/features/alpha/prd.json", ".nax/features/alpha/spec.md"],
      },
    };
    const { root, run } = await setup(env);
    const posted: string[] = [];
    Object.assign(_chainAdviseDeps, {
      readFindingDispositions: async () => ({ confirmed: new Set<string>(), writerSettled: new Set<string>() }),
      buildChainQuestion: async () => ({
        kind: "bot-fix-chain",
        feature: "alpha",
        summary: "s",
        evidence: [],
        options: [],
      }),
      replyToThread: async (...a: unknown[]) => {
        posted.push(String(a[2]));
        return { id: "9" };
      },
      createAdvisor: (): Advisor => ({
        advise: async () => ({
          decision: {
            id: "D-1",
            questionId: "Q-1",
            kind: "bot-fix-chain",
            chosenOptionId: "A",
            action: { type: "fix", instruction: "restore the guard" },
            rationale: "r",
            confidence: "high",
            reversible: true,
            needsHumanConfirm: false,
            decidedAt: "",
            model: "m",
            memoryMode: "stateless",
            auditRef: "",
          },
        }),
        recordReuse: async () => null,
        adviseBatch: async () => ({ kind: "preflight" as const, items: [], overlap: [] }),
      }),
    });
    await go(root);
    expect(run.mock.calls[0]?.[1].prompt).toContain("Advisor ruling: restore the guard");
    expect(posted).toHaveLength(1);
    expect(parseChainRuling(posted[0] ?? "")?.outcome).toBe("fix");
  });
});
