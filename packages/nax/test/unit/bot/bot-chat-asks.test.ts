import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixDeps, makeBotFixEnv, makeBotReviewDeps, makeTestRuntime } from "@test/helpers";
import { Command } from "commander";
import { _botFixDeps, _botReviewDeps, runBotFix, runBotReview } from "@/bot";
import { _fixCycleDeps, runBotFixCycle } from "@/bot/fix-cycle";
import { _botCliDeps, botFixCommand, botReviewCommand, registerBotCommand } from "@/cli/bot";
import { InteractionChain } from "@/interaction";
import { getLogger, initLogger, resetLogger } from "@/logger";

const reviewOriginal = { ..._botReviewDeps };
const fixOriginal = { ..._botFixDeps };
const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
afterEach(async () => {
  mock.restore();
  Object.assign(_botReviewDeps, reviewOriginal);
  Object.assign(_botFixDeps, fixOriginal);
  await Promise.all(runtimes.map((runtime) => runtime.close()));
  runtimes.length = 0;
  resetLogger();
});
const secret = new Uint8Array(32).fill(7);
const input = { dir: "/repo", pr: 12, profiles: [], interactive: false };

describe("bot chat CLI", () => {
  test.each(["review", "fix"] as const)(
    "%s validates, forwards and omits chat inputs (AC-1–5,20,22,23)",
    async (kind) => {
      const run = mock(async (_value: Parameters<typeof runBotFix>[0]) => ({
        outcome: "refused" as const,
        reason: "test",
      }));
      const read = mock(async () => secret);
      const logErr = mock(() => {});
      const deps = {
        ..._botCliDeps,
        logErr,
        readChatAskSecret: read,
        runBotReview: run,
        runBotFixCycle: async (value: Parameters<typeof runBotFix>[0]) => ({ fix: await run(value) }),
      };
      const command = kind === "review" ? botReviewCommand : botFixCommand;
      expect(await command({ pr: "12", dir: "/repo", chatAsks: "relative" }, deps)).toBe(1);
      expect(logErr).toHaveBeenCalledWith("--chat-asks must be an absolute path");
      expect(run).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      await command({ pr: "12", dir: "/repo", chatAsks: "/tmp/asks" }, deps);
      expect(run).toHaveBeenLastCalledWith(
        expect.objectContaining({ chatAsksDir: "/tmp/asks", chatAskSecret: secret }),
      );
      await command({ pr: "12", dir: "/repo" }, deps);
      expect(run.mock.calls.at(-1)?.[0]).not.toHaveProperty("chatAsksDir");
      expect(read).toHaveBeenCalledTimes(1);
    },
  );
  test("registers hidden options on both subcommands (AC-18,19)", () => {
    const group = registerBotCommand(new Command());
    for (const command of group.commands) {
      expect(command.options.find((option) => option.long === "--chat-asks")?.flags).toBe("--chat-asks <dir>");
      expect(command.helpInformation()).not.toContain("--chat-asks");
    }
  });
});

describe("bot chat lifecycle", () => {
  test.each(["review", "fix"] as const)("%s attaches, disposes and recovers (AC-8–17,21)", async (kind) => {
    initLogger({ level: "silent" });
    const env = makeBotFixEnv();
    const runtime = makeTestRuntime({ config: env.config });
    runtimes.push(runtime);
    Object.assign(_botReviewDeps, makeBotReviewDeps({ config: env.config, runtime, info: () => env.info }));
    Object.assign(_botFixDeps, makeBotFixDeps(env, runtime));
    const deps = kind === "review" ? _botReviewDeps : _botFixDeps;
    const run = kind === "review" ? runBotReview : runBotFix;
    const chain = new InteractionChain({ defaultTimeout: 1_000, defaultFallback: "skip" });
    const destroy = spyOn(chain, "destroy");
    const init = mock(async () => chain);
    Object.assign(deps, { initInteractionChain: init });
    const originalBuild = deps.buildPrStepContext;
    const build = spyOn(deps, "buildPrStepContext");
    // Stop immediately after context creation: cleanup must cover thrown steps too.
    build.mockImplementation(async (value) => {
      const context = await originalBuild(value);
      await context.dispose();
      throw new Error("step stopped");
    });
    await expect(run({ ...input, chatAsksDir: "/tmp/asks", chatAskSecret: secret })).rejects.toThrow("step stopped");
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ bot: env.config.bot }), true, {
      chatAsksDir: "/tmp/asks",
      chatAskSecret: secret,
    });
    expect(build.mock.calls[0]?.[0].interactionChain).toBe(chain);
    expect(destroy).toHaveBeenCalledTimes(1);
    build.mockClear();
    await expect(run(input)).rejects.toThrow("step stopped");
    expect(build.mock.calls[0]?.[0]).not.toHaveProperty("interactionChain");
    expect(init).toHaveBeenCalledTimes(1);
    build.mockClear();
    init.mockRejectedValue(new Error("directory unavailable"));
    const warn = spyOn(getLogger(), "warn");
    await expect(run({ ...input, chatAsksDir: "/tmp/asks" })).rejects.toThrow("step stopped");
    expect(build.mock.calls[0]?.[0]).not.toHaveProperty("interactionChain");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain("/tmp/asks");
    build.mockRestore();
    init.mockResolvedValue(chain);
    destroy.mockClear();
    const freshRuntime = makeTestRuntime({ config: env.config });
    runtimes.push(freshRuntime);
    deps.createRuntime = () => freshRuntime;
    if (kind === "fix") {
      // The missing-review refusal returns early after creating the context.
      _botFixDeps.loadLatestReview = async () => null;
    } else {
      _botReviewDeps.runPrReview = async () => ({ ran: false, why: "test complete" });
    }
    await run({ ...input, chatAsksDir: "/tmp/asks", chatAskSecret: secret });
    expect(destroy).toHaveBeenCalledTimes(1);
  });
  test("fix cycle preserves directory and secret through re-review (AC-6,7)", async () => {
    const env = makeBotFixEnv();
    const fix = mock<typeof runBotFix>(async () => ({
      outcome: "pushed",
      pushedSha: "new",
      step: "done",
      timings: {},
    }));
    const review = mock<typeof runBotReview>(async () => ({ outcome: "refused", reason: "stop" }));
    await runBotFixCycle(
      { ...input, rereview: true, chatAsksDir: "/tmp/asks", chatAskSecret: secret },
      {
        ..._fixCycleDeps,
        runBotFix: fix,
        runBotReview: review,
        gitToplevel: async () => "/repo",
        resolvePrRef: async () => env.ref,
        waitForPrHead: async () => true,
      },
    );
    for (const call of [fix.mock.calls[0]?.[0], review.mock.calls[0]?.[0]])
      expect(call).toMatchObject({ chatAsksDir: "/tmp/asks", chatAskSecret: secret });
  });
});
