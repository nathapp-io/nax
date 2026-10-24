import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import * as sessionPin from "@/bot/session-pin";

const original = { ...sessionPin._sessionPinDeps };
const logger = makeLogger();
let calls: string[][];
let fail: string;
beforeEach(() => {
  calls = [];
  fail = "";
  logger.reset();
  Object.assign(sessionPin._sessionPinDeps, {
    getLogger: () => logger,
    rm: async () => {},
    runGit: async (args: string[]) => {
      calls.push(args);
      const failed = args.includes(fail);
      return {
        exitCode: failed ? 1 : 0,
        stdout: args[0] === "ls-tree" ? "CLAUDE.md\0" : "",
        stderr: failed ? "failed" : "",
      };
    },
  });
});
afterEach(() => Object.assign(sessionPin._sessionPinDeps, original));
const scope = (run: () => Promise<unknown>) => sessionPin.basePinScope("/fixture", "base")(run);
const restored = () => calls.some((args) => args.includes("--no-skip-worktree"));

describe("basePinScope", () => {
  test("AC-7 AC-8 AC-9 pins before run, restores after, and returns the exact value", async () => {
    const value = { result: "session value" };
    expect(
      await scope(async () => {
        calls.push(["RUN"]);
        return value;
      }),
    ).toBe(value);
    const marker = calls.findIndex((args) => args[0] === "RUN");
    const pinned = calls.findIndex((args) => args.includes("--skip-worktree"));
    expect(pinned).toBeGreaterThanOrEqual(0);
    expect(pinned).toBeLessThan(marker);
    expect(calls.findIndex((args) => args.includes("--no-skip-worktree"))).toBeGreaterThan(marker);
  });
  test("AC-10 AC-11 restores on rejection and preserves the session error", async () => {
    const error = new Error("session failed");
    await expect(
      scope(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(restored()).toBe(true);
  });
  test.each([false, true])("AC-12 AC-13 restore failure takes precedence (run rejects: %s)", async (reject) => {
    await expect(
      scope(async () => {
        fail = "--no-skip-worktree";
        if (reject) throw new Error("session failed");
        return "discarded";
      }),
    ).rejects.toMatchObject({ code: "BOT_SESSION_RESTORE_FAILED" });
    expect(logger.warn).toHaveBeenCalledWith(
      "bot-fix",
      "Could not restore head agent configuration after the fix session",
      {
        worktree: "/fixture",
        error: expect.any(String),
      },
    );
  });
  test("AC-14 AC-15 failed pin rejects without running the session", async () => {
    fail = "checkout";
    let ran = false;
    await expect(
      scope(async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ code: "BOT_SESSION_PIN_FAILED" });
    expect(ran).toBe(false);
    expect(restored()).toBe(false);
  });
});
