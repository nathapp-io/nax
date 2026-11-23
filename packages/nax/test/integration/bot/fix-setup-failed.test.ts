import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixDeps, makeBotFixEnv, makeTestRuntime } from "@test/helpers";
import type { BotChecks } from "@/bot";
import { _fixReportDeps } from "@/bot/fix-report";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import { _fixStepsDeps, checkStep, fixStep, gatesStep } from "@/bot/fix-steps";
import { NaxError } from "@/errors";
import { getLogger, initLogger, resetLogger } from "@/logger";

const original = { ..._botFixDeps };
const reportOriginal = { ..._fixReportDeps };
const stepsOriginal = { ..._fixStepsDeps };
let runtime: ReturnType<typeof makeTestRuntime>;
const input = { dir: "/repo", pr: 42, profiles: [], interactive: false };
const branchFix = mock<typeof _fixStepsDeps.runBranchFix>();
const post = mock<typeof _fixReportDeps.postPrComment>(async () => ({ id: "comment" }));

beforeEach(() => {
  const base = makeBotFixEnv([{ kind: "finding", key: "fix-me", issue: "Fix this issue", severity: "important" }]);
  const env = { ...base, checks: { ...base.checks, preRun: [{ command: "bun install", timeoutSeconds: 60 }] } };
  runtime = makeTestRuntime({ config: env.config });
  Object.assign(_botFixDeps, makeBotFixDeps(env, runtime));
  _botFixDeps.runPreRunSteps = async () => {
    throw new NaxError("[execution] setup failed", "PRE_RUN_FAILED", { stage: "execution", command: "bun install" });
  };
  branchFix.mockClear();
  post.mockClear();
  _fixStepsDeps.runBranchFix = branchFix;
  _fixReportDeps.postPrComment = post;
});
afterEach(async () => {
  Object.assign(_botFixDeps, original);
  Object.assign(_fixReportDeps, reportOriginal);
  Object.assign(_fixStepsDeps, stepsOriginal);
  await runtime.close();
});

describe("runBotFix setup failure", () => {
  test("AC-1/2/3/11 reports the failed command without starting a fix session", async () => {
    const result = await runBotFix(input);
    expect(result).toMatchObject({ outcome: "setup-failed", setupFailed: "bun install", step: "done" });
    expect(branchFix).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[1]).toContain("Setup failed at `bun install`; nothing ran.");
  });
  test.each([
    new NaxError("other failure", "OTHER", { stage: "test" }),
    new Error("unexpected failure"),
    { code: "PRE_RUN_FAILED", context: { command: "bun install" } },
  ])("AC-4 propagates non-PRE_RUN_FAILED NaxErrors and other rejections unchanged: %s", async (failure) => {
    _botFixDeps.runPreRunSteps = async () => {
      throw failure;
    };
    await expect(runBotFix(input)).rejects.toBe(failure);
    expect(branchFix).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

/**
 * US-003: the fresh checkout's build runs after a successful install. A build that fails for its own
 * reason (`PRE_RUN_FAILED`) must not read as a setup failure — the fix session still runs — while
 * anything else still ends the run.
 */
describe("runBotFix build failure", () => {
  const BUILD = "bun run build";
  const checks = {
    source: "config" as const,
    gates: [{ name: "build", command: BUILD }],
    preRun: [{ command: "bun install", timeoutSeconds: 60 }],
  };

  beforeEach(() => {
    _botFixDeps.resolveBotChecks = async () => checks;
    branchFix.mockImplementation(async () => ({ autoCommitted: false, dirty: false }));
    // The tree here is a fixture, not a checkout: stop the graph after the session it just ran.
    _botFixDeps.checkStep = async () => ({ patch: { outcome: "nothing" }, exit: "no-change" });
  });

  /** Fail the build invocation only; the install succeeded. */
  function failBuild(failure: unknown): void {
    _botFixDeps.runPreRunSteps = async ({ steps }) => {
      if (steps.some(({ command }) => command === BUILD)) throw failure;
    };
  }

  test("AC-7: a failed build warns and the fix session still runs", async () => {
    initLogger({ level: "silent" });
    const warn = spyOn(getLogger(), "warn");
    failBuild(new NaxError("[bot] build failed", "PRE_RUN_FAILED", { stage: "execution", command: BUILD }));
    try {
      const result = await runBotFix(input);
      expect(result).not.toMatchObject({ outcome: "setup-failed" });
      expect(branchFix).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "bot-fix",
        "Fix build step failed",
        expect.objectContaining({ pr: 42, command: BUILD }),
      );
    } finally {
      warn.mockRestore();
      resetLogger();
    }
  });

  test("AC-8: any other build failure rejects the run", async () => {
    const failure = new Error("build blew up");
    failBuild(failure);
    await expect(runBotFix(input)).rejects.toBe(failure);
    expect(branchFix).not.toHaveBeenCalled();
  });
});

/**
 * US-002: a *saved* install that fails is retried once with the install the current base tip
 * resolves. The gates stay the ones the head's review saved; only the install is re-resolved.
 */
describe("runBotFix saved install retry", () => {
  const SAVED_INSTALL = { command: "bun install --frozen-lockfile", timeoutSeconds: 600 };
  const FRESH_INSTALL = { command: "npm ci", timeoutSeconds: 600 };
  const SAVED_GATE = "bun run test";
  const FRESH_GATE = "npm run test";
  const RETRY_MESSAGE = "Saved install failed; retrying with the install resolved from the base tip";

  function savedChecks(): BotChecks {
    return {
      source: "config",
      gates: [{ name: "test", command: SAVED_GATE }],
      preRun: [SAVED_INSTALL],
      install: { lockfile: "bun.lock", reason: "lockfile-order", fallbacks: [] },
    };
  }
  function freshChecks(): BotChecks {
    return {
      source: "config",
      gates: [{ name: "test", command: FRESH_GATE }],
      preRun: [FRESH_INSTALL],
      install: { lockfile: "package-lock.json", reason: "package-manager", fallbacks: [] },
    };
  }

  /** The head's saved review, and the resolver the re-resolve calls. */
  function savedHead(checks: BotChecks, resolve: typeof _botFixDeps.resolveBotChecks): void {
    _botFixDeps.loadLatestReview = async () => ({
      ...makeBotFixEnv([{ kind: "finding", key: "fix-me", issue: "Fix this issue", severity: "important" }]).review,
      version: 3,
      checks,
    });
    _botFixDeps.resolveBotChecks = resolve;
  }

  /** The install fails for each of `commands`, and nothing else. */
  function installs(commands: readonly string[], options: { tried?: readonly string[] } = {}) {
    const preRun = mock<typeof _botFixDeps.runPreRunSteps>(async ({ steps }) => {
      const command = steps[0]?.command ?? "";
      if (!commands.includes(command)) return;
      throw new NaxError("[bot] install failed", "PRE_RUN_FAILED", {
        stage: "bot",
        command,
        ...(options.tried === undefined ? {} : { tried: [...options.tried] }),
      });
    });
    _botFixDeps.runPreRunSteps = preRun;
    return preRun;
  }

  /** Stop the graph as soon as the session ran: this story is about the setup, not the push. */
  function stopAfterFix(): ReturnType<typeof mock<typeof _fixStepsDeps.runBranchFix>> {
    const session = mock<typeof _fixStepsDeps.runBranchFix>(async () => ({ autoCommitted: false, dirty: false }));
    _fixStepsDeps.runBranchFix = session;
    _fixStepsDeps.readHead = async () => "fixed-head";
    _botFixDeps.fixStep = fixStep;
    _botFixDeps.checkStep = async () => ({ patch: { changed: [], outcome: "no-change" }, exit: "no-change" });
    return session;
  }

  test("AC-1/2/3/5: the failed saved install is retried with the install resolved from the base tip", async () => {
    initLogger({ level: "silent" });
    const info = spyOn(getLogger(), "info");
    const saved = savedChecks();
    const resolve = mock<typeof _botFixDeps.resolveBotChecks>(async () => freshChecks());
    resolve.mockImplementationOnce(async () => saved);
    try {
      // The resolve that produced the saved review (its own lifecycle), then this run's replay.
      const produced = await resolve({
        repoRoot: "/repo",
        baseSha: "base",
        snapshotDir: "/snapshot",
        hasBaseNax: true,
        config: makeBotFixEnv().config,
        extract: async () => null,
      });
      savedHead(produced, resolve);
      const preRun = installs([SAVED_INSTALL.command]);
      const session = stopAfterFix();

      const result = await runBotFix(input);

      expect(result).not.toMatchObject({ outcome: "setup-failed" });
      expect(session).toHaveBeenCalledTimes(1);
      const prompt = session.mock.calls[0]?.[1].prompt ?? "";
      expect(prompt).toContain(`Setup nax ran: ${FRESH_INSTALL.command} — all succeeded`);
      expect(prompt).not.toContain(SAVED_INSTALL.command);
      expect(preRun).toHaveBeenCalledTimes(2);
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(resolve.mock.calls[1]?.[0]).toMatchObject({ baseSha: "base", repoRoot: "/repo" });
      expect(info).toHaveBeenCalledWith(
        "bot-fix",
        RETRY_MESSAGE,
        expect.objectContaining({ saved: [SAVED_INSTALL.command], fresh: [FRESH_INSTALL.command] }),
      );
    } finally {
      info.mockRestore();
      resetLogger();
    }
  });

  test("AC-4: the gates the retried fix runs are the saved review's, not the re-resolved ones", async () => {
    savedHead(
      savedChecks(),
      mock<typeof _botFixDeps.resolveBotChecks>(async () => freshChecks()),
    );
    installs([SAVED_INSTALL.command]);
    const session = mock<typeof _fixStepsDeps.runBranchFix>(async () => ({ autoCommitted: false, dirty: false }));
    const gates = mock<typeof _fixStepsDeps.runQualityGates>(async () => ({
      passed: true,
      failing: [],
      ran: [SAVED_GATE],
      output: "green",
    }));
    Object.assign(_fixStepsDeps, {
      runBranchFix: session,
      readHead: async () => "fixed-head",
      runGit: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      changedPaths: async () => ["source.txt"],
      runQualityGates: gates,
    });
    Object.assign(_botFixDeps, {
      fixStep,
      checkStep,
      gatesStep,
      ledgerStep: async () => ({ patch: {}, exit: "push" as const }),
      pushStep: async () => ({ patch: { outcome: "pushed" as const, pushedSha: "abc1234" }, exit: "pushed" as const }),
      replyStep: async () => ({ patch: {}, exit: "ready" as const }),
      readyStep: async () => ({ patch: {}, exit: "report" as const }),
      reportStep: async () => ({ patch: {}, exit: "done" as const }),
    });

    await runBotFix(input);

    expect(session).toHaveBeenCalledTimes(1);
    expect(gates.mock.calls[0]?.[1].map(({ command }) => command)).toEqual([SAVED_GATE]);
    expect(gates.mock.calls[0]?.[1].map(({ command }) => command)).not.toContain(FRESH_GATE);
  });

  test("F1: command lists that only look equal once joined still retry", async () => {
    const joined = { command: `${SAVED_INSTALL.command}\n${FRESH_INSTALL.command}`, timeoutSeconds: 600 };
    savedHead(
      { ...savedChecks(), preRun: [joined] },
      mock<typeof _botFixDeps.resolveBotChecks>(async () => ({
        ...freshChecks(),
        preRun: [SAVED_INSTALL, FRESH_INSTALL],
      })),
    );
    // `${SAVED_INSTALL.command}\n${FRESH_INSTALL.command}` === the fresh list joined by "\n": only an
    // element-wise comparison tells the two lists apart, and the retry must still happen.
    const preRun = installs([joined.command]);
    stopAfterFix();

    const result = await runBotFix(input);

    expect(result).not.toMatchObject({ outcome: "setup-failed" });
    expect(preRun).toHaveBeenCalledTimes(2);
    expect(preRun.mock.calls[1]?.[0]).toEqual({ steps: [SAVED_INSTALL, FRESH_INSTALL], workdir: "/worktree" });
  });

  test("AC-6: an identical fresh install is not retried", async () => {
    savedHead(
      savedChecks(),
      mock<typeof _botFixDeps.resolveBotChecks>(async () => savedChecks()),
    );
    const preRun = installs([SAVED_INSTALL.command]);
    stopAfterFix();

    const result = await runBotFix(input);

    expect(result).toMatchObject({ outcome: "setup-failed", setupFailed: SAVED_INSTALL.command });
    expect(preRun).toHaveBeenCalledTimes(1);
    expect(branchFix).not.toHaveBeenCalled();
  });

  test("AC-7: an empty fresh preRun is not retried", async () => {
    savedHead(
      savedChecks(),
      mock<typeof _botFixDeps.resolveBotChecks>(async () => ({ ...savedChecks(), preRun: [] })),
    );
    const preRun = installs([SAVED_INSTALL.command]);
    stopAfterFix();

    const result = await runBotFix(input);

    expect(result).toMatchObject({ outcome: "setup-failed", setupFailed: SAVED_INSTALL.command });
    expect(preRun).toHaveBeenCalledTimes(1);
    expect(branchFix).not.toHaveBeenCalled();
  });

  test("AC-8: a re-resolved install that fails too names the re-resolved command", async () => {
    savedHead(
      savedChecks(),
      mock<typeof _botFixDeps.resolveBotChecks>(async () => freshChecks()),
    );
    const preRun = installs([SAVED_INSTALL.command, FRESH_INSTALL.command]);
    stopAfterFix();

    const result = await runBotFix(input);

    expect(result).toMatchObject({ outcome: "setup-failed", setupFailed: FRESH_INSTALL.command });
    expect(preRun).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]?.[1]).toContain("`package-lock.json`");
  });

  test("AC-9/20: a re-resolve that rejects keeps the saved command and logs the error", async () => {
    initLogger({ level: "silent" });
    const logged = spyOn(getLogger(), "error");
    try {
      savedHead(
        savedChecks(),
        mock<typeof _botFixDeps.resolveBotChecks>(async () => {
          throw new Error("resolve blew up");
        }),
      );
      const preRun = installs([SAVED_INSTALL.command]);
      stopAfterFix();

      const result = await runBotFix(input);

      expect(result).toMatchObject({ outcome: "setup-failed", setupFailed: SAVED_INSTALL.command });
      expect(preRun).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith(
        "bot-fix",
        "Could not re-resolve the saved checks from the base tip",
        expect.objectContaining({ pr: 42, error: "resolve blew up" }),
      );
    } finally {
      logged.mockRestore();
      resetLogger();
    }
  });

  test("AC-10: checks that were never saved are not re-resolved", async () => {
    const resolve = mock<typeof _botFixDeps.resolveBotChecks>(async () => savedChecks());
    _botFixDeps.resolveBotChecks = resolve;
    installs([SAVED_INSTALL.command]);
    stopAfterFix();

    const result = await runBotFix(input);

    expect(result).toMatchObject({ outcome: "setup-failed", setupFailed: SAVED_INSTALL.command });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  /** AC-13/14/15/16: what the public summary says about a setup failure of unsaved checks. */
  function failingChecks(checks: BotChecks, tried?: readonly string[]): void {
    _botFixDeps.resolveBotChecks = mock<typeof _botFixDeps.resolveBotChecks>(async () => checks);
    installs([SAVED_INSTALL.command], tried === undefined ? {} : { tried });
  }

  test("AC-13: the summary names the lockfile the install was derived from", async () => {
    failingChecks(savedChecks());
    await runBotFix(input);
    expect(post.mock.calls[0]?.[1]).toContain("derived from `bun.lock` (the first lockfile found) on the base branch");
  });

  test("AC-14: the summary names a packageManager-derived install as such", async () => {
    failingChecks({
      ...savedChecks(),
      install: { lockfile: "package-lock.json", reason: "package-manager", fallbacks: [] },
    });
    await runBotFix(input);
    expect(post.mock.calls[0]?.[1]).toContain("(the packageManager field)");
  });

  test("AC-15: the summary lists the other commands the install tried", async () => {
    failingChecks(savedChecks(), [SAVED_INSTALL.command, FRESH_INSTALL.command]);
    await runBotFix(input);
    expect(post.mock.calls[0]?.[1]).toContain("Also tried: `npm ci`");
  });

  test("AC-16: the summary names the config key and both commands that re-read it", async () => {
    failingChecks(savedChecks());
    await runBotFix(input);
    const body = post.mock.calls[0]?.[1] ?? "";
    expect(body).toContain("Set execution.preRun in the base branch's .nax/config.json");
    expect(body).toContain("nax bot review 42");
  });
});
