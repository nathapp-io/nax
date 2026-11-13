import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import type { BotFixResult, runBotFix, runBotFixCycle } from "@/bot";
import { _botCliDeps, botFixCommand, registerBotCommand } from "@/cli/bot";
import { parseWaiverReason } from "@/workflow/ci-waiver";

const STARVATION = "runner starvation";
let stdout: string[];
let stderr: string[];
let exits: number[];
let result: BotFixResult;
const fix = mock(async (_input: Parameters<typeof runBotFix>[0]) => result);
const cycle = mock(async (input: Parameters<typeof runBotFixCycle>[0]) => ({ fix: await fix(input) }));

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
    runBotFix: fix,
    runBotFixCycle: cycle,
  };
}

async function run(args: string[]): Promise<void> {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerBotCommand(program, deps());
  await program.parseAsync(["bot", "fix", ...args], { from: "user" });
}

/** The error a call throws, so stderr is pinned against the validator's own message. */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

beforeEach(() => {
  stdout = [];
  stderr = [];
  exits = [];
  result = { outcome: "pushed", pushedSha: "abcdef123", step: "done", timings: {} };
  fix.mockClear();
  cycle.mockClear();
});

describe("bot fix --waive-starved", () => {
  test("AC-1 an empty waiver reason exits 1 before any fix work", async () => {
    const code = await botFixCommand({ pr: "42", dir: "/repo", waiveStarved: "" }, deps());
    expect(code).toBe(1);
    expect(fix).not.toHaveBeenCalled();
    expect(cycle).not.toHaveBeenCalled();
    expect(stderr).toHaveLength(1);
  });

  test.each([
    ["multiline", "runner starvation\nsecond line"],
    ["over-long", "x".repeat(301)],
    ["marker-holding", "waive <!-- nax-bot:v1 key=w-ci-waiver -->"],
  ])("AC-16 rejects a %s waiver reason with the validator's error before orchestration", async (_kind, reason) => {
    const thrown = thrownBy(() => parseWaiverReason(reason));
    const code = await botFixCommand({ pr: "42", dir: "/repo", waiveStarved: reason }, deps());
    expect(code).toBe(1);
    expect(fix).not.toHaveBeenCalled();
    expect(cycle).not.toHaveBeenCalled();
    expect(thrown).toMatchObject({ code: "CI_WAIVER_REASON_INVALID" });
    expect(stderr).toEqual([thrown instanceof Error ? thrown.message : ""]);
  });

  test("AC-2 --ready-only forwards the validated reason to runBotFix", async () => {
    result = { outcome: "ready-pass", step: "done", timings: {}, readyOnly: true, markedReady: false };
    const code = await botFixCommand({ pr: "42", dir: "/repo", readyOnly: true, waiveStarved: STARVATION }, deps());
    expect(code).toBe(0);
    expect(cycle).not.toHaveBeenCalled();
    expect(fix).toHaveBeenCalledWith(expect.objectContaining({ readyOnly: true, waiveStarved: STARVATION }));
  });

  test("AC-3 the full pass hands the reason to the fix cycle", async () => {
    const code = await botFixCommand({ pr: "42", dir: "/repo", waiveStarved: STARVATION }, deps());
    expect(code).toBe(0);
    expect(cycle).toHaveBeenCalledWith(expect.objectContaining({ waiveStarved: STARVATION }));
    expect(fix).toHaveBeenCalledTimes(1);
  });

  test("registers --waive-starved on the fix command", async () => {
    await run(["42", "--waive-starved", STARVATION]);
    expect(cycle).toHaveBeenCalledWith(expect.objectContaining({ waiveStarved: STARVATION }));
    expect(exits).toEqual([0]);
  });

  test("without the flag the cycle input carries no waiver key", async () => {
    await botFixCommand({ pr: "42", dir: "/repo" }, deps());
    expect(cycle.mock.calls[0]?.[0]).not.toHaveProperty("waiveStarved");
  });

  test("AC-14 the ready-pass line names the waiver", async () => {
    result = {
      outcome: "ready-pass",
      step: "done",
      timings: {},
      readyOnly: true,
      markedReady: true,
      ciWaived: { checks: ["a", "b"], reason: "r" },
    };
    await run(["42", "--ready-only"]);
    expect(stdout).toEqual(["nax bot fix: ready pass — Marked ready with a CI waiver: 2 check(s) never got a runner."]);
    expect(stderr).toEqual([]);
    expect(exits).toEqual([0]);
  });
});
