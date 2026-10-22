import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Command } from "commander";
import type { BotFixCycleResult, BotFixResult, BotReviewResult, runBotFixCycle } from "@/bot";
import * as bot from "@/bot";
import { _botCliDeps, botFixCommand, registerBotCommand } from "@/cli/bot";

const pushed: BotFixResult = { outcome: "pushed", pushedSha: "abcdef123", step: "done", timings: {} };
const posted: BotReviewResult = {
  outcome: "posted",
  intent: "pass",
  quality: "changes",
  staticMode: false,
  checksSource: "config",
  artifactPath: "/review.json",
  earlierAnswered: 0,
  inlineFindings: 3,
  threadsAnswered: 2,
  commentsAnswered: 0,
  offLine: 0,
  failed: 0,
};
let result: BotFixCycleResult;
let stdout: string[];
let stderr: string[];
let exits: number[];
const cycle = mock(async (_input: Parameters<typeof runBotFixCycle>[0]) => result);
const legacy = mock(async (): Promise<BotFixResult> => ({ outcome: "refused", reason: "legacy dispatch" }));
function deps() {
  return {
    ..._botCliDeps,
    initLogger: () => {},
    isInteractive: () => false,
    log: (line: string) => {
      stdout.push(line);
    },
    logErr: (line: string) => {
      stderr.push(line);
    },
    exit: (code: number) => {
      exits.push(code);
    },
    runBotFixCycle: cycle,
    runBotFix: legacy,
  };
}
async function run(...args: string[]): Promise<void> {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerBotCommand(program, deps());
  await program.parseAsync(["bot", "fix", "42", ...args], { from: "user" });
}
beforeEach(() => {
  result = { fix: pushed };
  stdout = [];
  stderr = [];
  exits = [];
  cycle.mockClear();
  legacy.mockClear();
});
afterEach(() => mock.restore());

describe("botFixCommand cycle", () => {
  test("AC-1 defaults to rereview and saved-fix reuse, including direct callers", async () => {
    await botFixCommand({ pr: "42", dir: "/repo" }, deps());
    expect(cycle).toHaveBeenCalledWith({
      pr: 42,
      dir: "/repo",
      profiles: [],
      model: undefined,
      interactive: false,
      rereview: true,
      fresh: false,
    });
    expect(legacy).not.toHaveBeenCalled();
  });
  test("AC-2 --no-rereview opts out", async () => {
    await run("--no-rereview");
    expect(cycle).toHaveBeenCalledWith(expect.objectContaining({ rereview: false, fresh: false }));
  });
  test("AC-3 --fresh discards saved fix", async () => {
    await run("--fresh");
    expect(cycle).toHaveBeenCalledWith(expect.objectContaining({ rereview: true, fresh: true }));
  });
  test("AC-4 prints posted review after the fix", async () => {
    result = { fix: pushed, review: posted };
    await run();
    expect(stdout).toEqual([
      "nax bot fix: PR #42 — pushed abcdef1",
      "nax bot review: PR #42 — 3 findings posted, 2 threads answered (intent pass, quality changes)",
    ]);
    expect(stderr).toEqual([]);
  });
  test.each([
    ["AC-5", { markedReady: true }, "Marked ready."],
    ["AC-6", { readyHeld: "CI pending" }, "Kept as draft: CI pending"],
    ["AC-10", {}, "not a draft"],
  ] as const)("%s prints ready pass %s", async (_ac, readiness, summary) => {
    result = { fix: pushed, review: posted, ready: { outcome: "ready-pass", step: "done", timings: {}, ...readiness } };
    await run();
    expect(stdout.at(-1)).toBe(`nax bot fix: ready pass — ${summary}`);
    expect(stderr).toEqual([]);
    expect(exits).toEqual([0]);
  });
  test("AC-7 sends skipped text to stderr", async () => {
    result = { fix: pushed, skipped: "head timeout; run nax bot review 42" };
    await run();
    expect(stderr).toEqual(["head timeout; run nax bot review 42"]);
    expect(exits).toEqual([0]);
  });
  test.each(["not-reviewed", "refused"] as const)(
    "AC-8 reports %s review without failing the push",
    async (outcome) => {
      result = { fix: pushed, review: { outcome, reason: "review blocked" } };
      await run();
      expect(stderr).toEqual(["review blocked"]);
      expect(exits).toEqual([0]);
    },
  );
  test.each([
    [{ outcome: "refused", reason: "ready refused" }, "ready refused"],
    [{ outcome: "gates-failed", step: "done", timings: {} }, "gates-failed"],
  ] as const)("reports unsuccessful ready result %s on stderr", async (ready, expected) => {
    result = { fix: pushed, review: posted, ready };
    await run();
    expect(stderr).toEqual([expected]);
    expect(exits).toEqual([0]);
    expect(stdout.some((line) => line.startsWith("nax bot fix: ready pass"))).toBe(false);
  });
  test.each(["nothing", "pushed"] as const)(
    "AC-11/12/13 preserves %s summary and success despite chained failure",
    async (outcome) => {
      result = { fix: { ...pushed, outcome }, review: { outcome: "not-reviewed", reason: "blocked" } };
      await run();
      expect(stdout).toEqual([`nax bot fix: PR #42 — ${outcome === "nothing" ? "nothing to fix" : "pushed abcdef1"}`]);
      expect(exits).toEqual([0]);
    },
  );
  test.each(["gates-failed", "cost-limit", "ready-pass"] as const)(
    "AC-14 preserves exit two for fix %s",
    async (outcome) => {
      result = { fix: { outcome, step: "done", timings: {} } };
      await run();
      expect(exits).toEqual([2]);
      expect(stderr).toEqual([outcome]);
    },
  );
  test("fix flags are rejected by review", async () => {
    for (const flag of ["--fresh", "--no-rereview"]) {
      const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
      registerBotCommand(program, deps());
      await expect(program.parseAsync(["bot", "review", "42", flag], { from: "user" })).rejects.toThrow();
    }
    expect(cycle).not.toHaveBeenCalled();
  });
  test("AC-9 lazy dependency delegates through the bot barrel", async () => {
    const spy = spyOn(bot, "runBotFixCycle").mockResolvedValue({ fix: pushed });
    const input = { pr: 42, dir: "/repo", profiles: [], interactive: false, rereview: true, fresh: false };
    const delegate = _botCliDeps.runBotFixCycle;
    expect(delegate).toBeFunction();
    expect(await delegate(input)).toEqual({ fix: pushed });
    expect(spy).toHaveBeenCalledWith(input);
  });
});
