import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { BotChecks, BotInstallChoice } from "@/bot";
import { runBotInstall } from "@/bot/install";
import type { PreRunStepConfig } from "@/config/runtime-types-execution";
import { NaxError } from "@/errors";
import type { runPreRunSteps } from "@/execution/lifecycle/pre-run-steps";
import { getLogger, initLogger, resetLogger } from "@/logger";

const WORKDIR = "/checkout";
const A: PreRunStepConfig = { command: "npm ci", timeoutSeconds: 600 };
const B: PreRunStepConfig = { command: "bun install --frozen-lockfile", timeoutSeconds: 600 };
const C: PreRunStepConfig = { command: "pnpm install --frozen-lockfile", timeoutSeconds: 600 };
const CHOICE: BotInstallChoice = { lockfile: "package-lock.json", reason: "package-manager", fallbacks: [B] };

function checks(preRun: readonly PreRunStepConfig[], choice?: BotInstallChoice): BotChecks {
  return { source: "detected", gates: [], preRun, ...(choice === undefined ? {} : { install: choice }) };
}

function preRunFailure(command: string): NaxError {
  return new NaxError(`Pre-run step failed: ${command}`, "PRE_RUN_FAILED", { stage: "execution", command });
}

/** A `runPreRunSteps` stand-in that fails only the named commands. */
function failingRun(failing: readonly string[]): ReturnType<typeof mock<typeof runPreRunSteps>> {
  return mock<typeof runPreRunSteps>(async ({ steps }) => {
    const failed = steps.find(({ command }) => failing.includes(command));
    if (failed !== undefined) throw preRunFailure(failed.command);
  });
}

let warn: ReturnType<typeof spyOn<ReturnType<typeof initLogger>, "warn">>;

beforeEach(() => {
  initLogger({ level: "silent" });
  warn = spyOn(getLogger(), "warn");
});
afterEach(() => {
  warn.mockRestore();
  resetLogger();
});

describe("runBotInstall", () => {
  test("AC-13/14: a failing install runs the next fallback once, in the same workdir", async () => {
    const run = failingRun([A.command]);
    expect(await runBotInstall(checks([A], CHOICE), WORKDIR, run)).toEqual({ ran: [B] });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[0]).toEqual({ steps: [A], workdir: WORKDIR });
    expect(run.mock.calls[1]?.[0]).toEqual({ steps: [B], workdir: WORKDIR });
  });
  test("AC-15: the fallback is announced as a warning naming both commands", async () => {
    await runBotInstall(checks([A], CHOICE), WORKDIR, failingRun([A.command]));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("bot");
    expect(warn.mock.calls[0]?.[1]).toContain(A.command);
    expect(warn.mock.calls[0]?.[1]).toContain(B.command);
  });
  test("AC-16: every attempt failing reports the first command and everything tried, in order", async () => {
    const choice: BotInstallChoice = { lockfile: "package-lock.json", reason: "package-manager", fallbacks: [B, C] };
    const error = await runBotInstall(checks([A], choice), WORKDIR, failingRun([A.command, B.command, C.command])).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(NaxError);
    if (!(error instanceof NaxError)) throw new Error("expected a NaxError");
    expect(error.code).toBe("PRE_RUN_FAILED");
    expect(error.context?.command).toBe(A.command);
    expect(error.context?.tried).toEqual([A.command, B.command, C.command]);
  });
  test("AC-17: another error code propagates at once without another attempt", async () => {
    const failure = new NaxError("[bot] trust refused", "PROJECT_UNTRUSTED", { stage: "execution" });
    const run = mock<typeof runPreRunSteps>(async () => {
      throw failure;
    });
    await expect(runBotInstall(checks([A], CHOICE), WORKDIR, run)).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
  });
  test("AC-18: no fallbacks rethrows the original failure after one attempt", async () => {
    const failure = preRunFailure(A.command);
    const run = mock<typeof runPreRunSteps>(async () => {
      throw failure;
    });
    await expect(runBotInstall(checks([A]), WORKDIR, run)).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
  });
  test("AC-19: a succeeding setup reports the steps it ran without a fallback", async () => {
    const preRun = [A];
    const run = mock<typeof runPreRunSteps>(async () => {});
    expect(await runBotInstall(checks(preRun, CHOICE), WORKDIR, run)).toEqual({ ran: preRun });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual({ steps: preRun, workdir: WORKDIR });
  });
});
