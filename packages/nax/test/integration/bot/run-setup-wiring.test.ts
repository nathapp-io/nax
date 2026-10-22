import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  makeBotFixDeps,
  makeBotFixEnv,
  makeBotReviewDeps,
  makeMockRuntime,
  makeNaxConfig,
  makeTestRuntime,
} from "@test/helpers";
import { _botFixDeps, _botReviewDeps, _fixStepsDeps, runBotFix, runBotReview, setupBotRuntime } from "@/bot";
import { _botRunSetupDeps } from "@/bot/run-setup";
import { _botCliDeps, botFixCommand, botReviewCommand } from "@/cli/bot";
import { NaxError } from "@/errors";
import { initLogger, resetLogger } from "@/logger";

const stepsOriginal = { ..._fixStepsDeps };
const setupOriginal = { ..._botRunSetupDeps };
const fixOriginal = { ..._botFixDeps };
const reviewOriginal = { ..._botReviewDeps };
const input = { dir: "/repo", pr: 42, profiles: [], interactive: false };
let runtime: ReturnType<typeof makeTestRuntime>;
let env: ReturnType<typeof makeBotFixEnv>;
beforeEach(() => {
  initLogger({ level: "silent" });
  env = makeBotFixEnv();
  runtime = makeTestRuntime({ config: env.config });
  Object.assign(_botFixDeps, makeBotFixDeps(env, runtime));
  Object.assign(_botReviewDeps, makeBotReviewDeps({ config: env.config, runtime, info: () => env.info }));
});
afterEach(async () => {
  Object.assign(_fixStepsDeps, stepsOriginal);
  Object.assign(_botRunSetupDeps, setupOriginal);
  Object.assign(_botFixDeps, fixOriginal);
  Object.assign(_botReviewDeps, reviewOriginal);
  await runtime.close();
  resetLogger();
});

describe("bot runtime setup wiring", () => {
  test("AC-7: workflow index delivery installs real non-empty handlers", async () => {
    const runtime = makeMockRuntime();
    const configure = mock<typeof runtime.sessionManager.configureLoopHandlers>(() => {});
    runtime.sessionManager.configureLoopHandlers = configure;
    _botRunSetupDeps.assertDefaultNativeCredentials = async () => {};
    try {
      await setupBotRuntime(
        runtime,
        makeNaxConfig({ execution: { mode: "workflow" }, context: { rules: { delivery: "index" } } }),
        "/checkout",
      );
      expect(configure).toHaveBeenCalledTimes(1);
      expect(configure.mock.calls[0]?.[0].length).toBeGreaterThan(0);
    } finally {
      await runtime.close();
    }
  });
  test.each([true, false])("AC-8/9: review setup precedes agent work (trusted=%s)", async (trusted) => {
    const events: string[] = [];
    const setup = mock(async () => {
      events.push("setup");
    });
    Object.assign(_botReviewDeps, {
      setupBotRuntime: setup,
      classifyPrTrust: async () => ({ trusted, headSha: env.info.headSha, reasons: [] }),
      runPrReview: async () => {
        events.push("review");
        return { ran: false, reason: "test" };
      },
    });
    await runBotReview(input);
    expect(events).toEqual(["setup", "review"]);
    expect(setup).toHaveBeenCalledWith(runtime, expect.objectContaining({ bot: env.config.bot }), "/checkout");
  });

  test("AC-10: fix setup receives runtime/config/worktree before branch fix", async () => {
    const events: string[] = [];
    const setup = mock(async () => {
      events.push("setup");
    });
    env = makeBotFixEnv([{ kind: "comment", key: "k", issue: "fix this", reason: "agreed" }]);
    Object.assign(_botFixDeps, makeBotFixDeps(env, runtime));
    _fixStepsDeps.runBranchFix = async () => {
      events.push("fix");
      return { autoCommitted: false, dirty: false };
    };
    Object.assign(_botFixDeps, {
      setupBotRuntime: setup,
      checkStep: async () => ({ patch: { outcome: "nothing" }, exit: "no-change" }),
      readyStep: async () => ({ patch: {}, exit: "report" }),
      reportStep: async () => ({ patch: {}, exit: "done" }),
    });
    await runBotFix(input);
    expect(setup).toHaveBeenCalledWith(runtime, env.config, env.checkout.worktree);
    expect(events).toEqual(["setup", "fix"]);
  });

  test.each(["review", "fix"] as const)(
    "AC-11/12/19/20/21/22/23: %s setup failures close runtime, stop agents and reach CLI boundary",
    async (kind) => {
      const deps = kind === "fix" ? _botFixDeps : _botReviewDeps;
      const run = kind === "fix" ? runBotFix : runBotReview;
      const command = kind === "fix" ? botFixCommand : botReviewCommand;
      const agent = mock(async () => {
        throw new Error("agent must not run");
      });
      Object.assign(_botFixDeps, { fixStep: agent });
      Object.assign(_botReviewDeps, { runPrReview: agent });
      for (const code of [
        "CREDENTIALS_MISSING",
        "NATIVE_CREDENTIALS_MISSING",
        "RULES_OVERRIDE_DIR_NOT_FOUND",
        "PROJECT_CONTEXT_FILE_NOT_FOUND",
      ]) {
        const error = new NaxError(`[bot] ${code}`, code, { stage: "bot" });
        Object.assign(deps, { setupBotRuntime });
        runtime.agentManager.validateCredentials = async () => {
          if (code === "CREDENTIALS_MISSING") throw error;
        };
        _botRunSetupDeps.assertDefaultNativeCredentials = async () => {
          if (code === "NATIVE_CREDENTIALS_MISSING") throw error;
        };
        _botRunSetupDeps.configureRunRules = async () => {
          throw error;
        };
        const close = spyOn(runtime, "close");
        await expect(run(input)).rejects.toBe(error);
        expect(close).toHaveBeenCalled();
        const logErr = mock(() => {});
        const result = await command(
          { dir: "/repo", pr: "42" },
          {
            ..._botCliDeps,
            isInteractive: () => false,
            logErr,
            runBotFix,
            runBotReview,
          },
        );
        expect(close).toHaveBeenCalledTimes(2);
        close.mockRestore();
        expect(result).toBe(1);
        expect(logErr).toHaveBeenCalledWith(error.message);
        expect(agent).not.toHaveBeenCalled();
      }
    },
  );
});
