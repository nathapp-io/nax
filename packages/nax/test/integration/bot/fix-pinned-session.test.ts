import { afterEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeBotFixDeps,
  makeBotFixEnv,
  makeScriptedCallOp,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import { _fixStepsDeps, fixStep } from "@/bot/fix-steps";
import { botGit } from "@/bot/git";
import { repairStep } from "@/bot/repair-step";
import { basePinScope } from "@/bot/session-pin";
import { NaxError } from "@/errors";
import { runBranchFix } from "@/workflow/branch-fix";
import { _workflowDeps } from "@/workflow/step-context";

const originalBot = { ..._botFixDeps };
const originalFix = { ..._fixStepsDeps };
const originalWorkflow = { ..._workflowDeps };
const dirs: string[] = [];
const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
afterEach(async () => {
  Object.assign(_botFixDeps, originalBot);
  Object.assign(_fixStepsDeps, originalFix);
  Object.assign(_workflowDeps, originalWorkflow);
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(dirs.splice(0).map(cleanupTempDir));
});
const items = [{ kind: "finding" as const, key: "f1", severity: "minor" as const, issue: "Leak", file: "src/a.ts" }];
const note =
  "Agent configuration (CLAUDE.md, AGENTS.md and the other instruction files, .claude/, .mcp.json and each agent's config directory) holds the base branch's versions for this session; nax restores the PR's versions afterwards. Do not edit, stage or commit those files.";
const state = { step: "fix" as const, timings: {} };
const input = { dir: "/repo", pr: 42, profiles: [], interactive: false };
function fixture(inPlace = false) {
  const base = makeBotFixEnv(items);
  const root = makeTempDir("fix-pinned-");
  dirs.push(root);
  const env = {
    ...base,
    ctx: { ...base.ctx, reportPath: join(root, "report.md") },
    checkout: { ...base.checkout, inPlace },
  };
  const runtime = makeTestRuntime({ config: env.config });
  runtimes.push(runtime);
  Object.assign(_botFixDeps, makeBotFixDeps(env, runtime), {
    prepareInPlaceCheckout: async () => env.checkout,
    runGit: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    checkStep: async () => ({ patch: { outcome: "no-change" }, exit: "no-change" }),
    reportStep: async () => ({ patch: {}, exit: "done" }),
  });
  _fixStepsDeps.readHead = async () => "fixed";
  return env;
}

describe("runBotFix pinned sessions", () => {
  test.each([false, true])("AC-4/5/6 scope wiring, inPlace=%s", async (inPlace) => {
    const env = fixture(inPlace);
    const scope = async <T>(run: () => Promise<T>): Promise<T> => run();
    const pin = mock(() => scope);
    Object.assign(_botFixDeps, { basePinScope: pin });
    const run = mock<typeof runBranchFix>(async () => ({ autoCommitted: false, dirty: false }));
    _fixStepsDeps.runBranchFix = run;
    await runBotFix({ ...input, inPlace });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0].sessionScope).toBe(inPlace ? undefined : scope);
    expect(pin).toHaveBeenCalledTimes(inPlace ? 0 : 1);
    if (!inPlace) expect(pin).toHaveBeenCalledWith(env.checkout.worktree, env.checkout.baseSha);
  });
  test("AC-7 repair receives the exact same scoped context", async () => {
    fixture();
    const scope = async <T>(run: () => Promise<T>): Promise<T> => run();
    Object.assign(_botFixDeps, {
      basePinScope: () => scope,
      checkStep: async () => ({ patch: { changed: ["src/a.ts"] }, exit: "changed" }),
      gatesStep: async (_env: unknown, current: { gateRepairRounds?: number }) =>
        current.gateRepairRounds
          ? { patch: { outcome: "gates-failed" }, exit: "failed" }
          : { patch: { outcome: "gates-failed", gateTails: [{ name: "test", tail: "red" }] }, exit: "repair" },
    });
    const run = mock<typeof runBranchFix>(async () => ({ autoCommitted: false, dirty: false }));
    _fixStepsDeps.runBranchFix = run;
    await runBotFix(input);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[1].kind).toBe("repair");
    expect(run.mock.calls[1]?.[0]).toBe(run.mock.calls[0]?.[0]);
    expect(run.mock.calls[1]?.[0].sessionScope).toBe(scope);
  });
  test("AC-8 restore failure escapes the real branch fix and prevents push", async () => {
    fixture();
    const failure = new NaxError("[bot-fix] restore failed", "BOT_SESSION_RESTORE_FAILED", { stage: "bot-fix" });
    const scope = async <T>(run: () => Promise<T>): Promise<T> => {
      await run();
      throw failure;
    };
    Object.assign(_botFixDeps, {
      basePinScope: () => scope,
      checkStep: async () => ({ patch: { changed: ["src/a.ts"] }, exit: "changed" }),
      gatesStep: async () => ({ patch: {}, exit: "passed" }),
    });
    const push = mock(originalBot.pushStep);
    _botFixDeps.pushStep = push;
    const calls: string[] = [];
    _workflowDeps.callOp = makeScriptedCallOp(() => {
      calls.push("session");
      return { status: "DONE", commits: [], testSummary: "ok", interrupted: false };
    });
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    await expect(runBotFix(input)).rejects.toMatchObject({ code: "BOT_SESSION_RESTORE_FAILED" });
    expect(calls).toEqual(["session"]);
    expect(push).not.toHaveBeenCalled();
  });
});

describe("pinned checkout prompt", () => {
  test.each([false, true])("AC-11/12 fix prompt, inPlace=%s", async (inPlace) => {
    const env = fixture(inPlace);
    const run = mock<typeof runBranchFix>(async () => ({ autoCommitted: false, dirty: false }));
    _fixStepsDeps.runBranchFix = run;
    await fixStep(env, state);
    const prompt = run.mock.calls[0]?.[1].prompt;
    expect(typeof prompt).toBe("string");
    expect(prompt?.includes(note)).toBe(!inPlace);
  });
  test("AC-13 repair prompt includes the pinned note", async () => {
    const env = fixture();
    const run = mock<typeof runBranchFix>(async () => ({ autoCommitted: false, dirty: false }));
    _fixStepsDeps.runBranchFix = run;
    await repairStep(env, { ...state, outcome: "gates-failed" });
    expect(run.mock.calls[0]?.[1].prompt).toContain(note);
  });
});

describe("runBranchFix real base pin", () => {
  test("AC-14 agent reads base; leftover commit and worktree keep head configuration", async () => {
    const root = makeTempDir("fix-pin-real-");
    dirs.push(root);
    const git = async (args: string[]) => {
      const result = await botGit(args, root);
      expect(result.exitCode).toBe(0);
      return result.stdout.trim();
    };
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Test"]);
    await git(["config", "user.email", "test@example.com"]);
    await Bun.write(join(root, "CLAUDE.md"), "base");
    await Bun.write(join(root, "src/a.ts"), "base");
    await git(["add", "."]);
    await git(["commit", "-m", "base"]);
    const baseSha = await git(["rev-parse", "HEAD"]);
    await Bun.write(join(root, "CLAUDE.md"), "head");
    await git(["commit", "-am", "head"]);
    const env = makeBotFixEnv(items);
    let seen = "";
    _workflowDeps.callOp = makeScriptedCallOp(async () => {
      seen = await Bun.file(join(root, "CLAUDE.md")).text();
      await Bun.write(join(root, "src/a.ts"), "fixed");
      return { status: "DONE", commits: [], testSummary: "ok", interrupted: false };
    });
    _workflowDeps.autoCommitIfDirty = async () => {
      expect(await Bun.file(join(root, "CLAUDE.md")).text()).toBe("head");
      await git(["add", "src/a.ts"]);
      await git(["commit", "-m", "fix"]);
    };
    const result = await runBranchFix(
      {
        ...env.ctx,
        projectDir: root,
        reportPath: join(root, ".git/report.md"),
        sessionScope: basePinScope(root, baseSha),
      },
      { findings: [] },
    );
    expect(seen).toBe("base");
    expect(result.autoCommitted).toBe(true);
    expect(await Bun.file(join(root, "CLAUDE.md")).text()).toBe("head");
    expect(await git(["show", "HEAD:CLAUDE.md"])).toBe("head");
    expect(await git(["show", "HEAD:src/a.ts"])).toBe("fixed");
  });
});
