import { describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import { _botCliDeps, registerBotCommand } from "@/cli/bot";
import { NaxError } from "@/errors";

describe("registerBotCommand in-place", () => {
  test.each([
    ["review", true],
    ["fix", true],
    ["fix", false],
    ["review", false],
  ] as const)("forwards %s inPlace only when flag is %s (AC-1–4)", async (command, flag) => {
    const inputs: unknown[] = [];
    const exits: number[] = [];
    const program = new Command().exitOverride();
    registerBotCommand(program, {
      ..._botCliDeps,
      initLogger: () => {},
      logErr: () => {},
      isInteractive: () => false,
      exit: (code) => {
        exits.push(code);
      },
      runBotReview: async (input) => {
        inputs.push(input);
        return { outcome: "refused", reason: "test" };
      },
      runBotFixCycle: async (input) => {
        inputs.push(input);
        return { fix: { outcome: "refused", reason: "test" } };
      },
    });
    await program.parseAsync(["bot", command, "12", ...(flag ? ["--in-place"] : [])], { from: "user" });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual(expect.objectContaining({ pr: 12 }));
    if (flag) expect(inputs[0]).toHaveProperty("inPlace", true);
    else expect(inputs[0]).not.toHaveProperty("inPlace");
    expect(exits).toEqual([2]);
  });

  test.each(["review", "fix"])("prints checkout precondition and exits 1 for %s (AC-11/12)", async (command) => {
    const error = new NaxError("[bot] In-place checkout refused: check out feat/x first", "BOT_IN_PLACE_REFUSED", {
      stage: "bot",
    });
    const logErr = mock(() => {});
    const exit = mock(() => {});
    const program = new Command().exitOverride();
    registerBotCommand(program, {
      ..._botCliDeps,
      initLogger: () => {},
      isInteractive: () => false,
      logErr,
      exit,
      runBotReview: async () => {
        throw error;
      },
      runBotFixCycle: async () => {
        throw error;
      },
    });
    await program.parseAsync(["bot", command, "12", "--in-place"], { from: "user" });
    expect(logErr).toHaveBeenCalledWith(error.message);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
