import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import type { BotFixResult, BotReviewResult, runBotFix, runBotFixCycle, runBotReview } from "@/bot";
import { _botCliDeps, registerBotCommand } from "@/cli/bot";
import { NaxError } from "@/errors";

let stdout: string[];
let stderr: string[];
let exits: number[];
let result: BotFixResult;
let failure: unknown;
let interactive: boolean;
let cycles: Parameters<typeof runBotFixCycle>[0][];
const fix = mock(async (_input: Parameters<typeof runBotFix>[0]) => {
  if (failure) throw failure;
  return result;
});
const review = mock(
  async (_input: Parameters<typeof runBotReview>[0]): Promise<BotReviewResult> => ({
    outcome: "refused",
    reason: "review stub",
  }),
);
beforeEach(() => {
  stdout = [];
  stderr = [];
  exits = [];
  cycles = [];
  result = { outcome: "pushed", pushedSha: "abcdef12", step: "done", timings: {} };
  failure = undefined;
  interactive = false;
  fix.mockClear();
  review.mockClear();
});
async function run(args: string[], command = "fix"): Promise<void> {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerBotCommand(program, {
    ..._botCliDeps,
    initLogger: () => {},
    log: (message) => {
      stdout.push(message);
    },
    logErr: (message) => {
      stderr.push(message);
    },
    exit: (code) => {
      exits.push(code);
    },
    isInteractive: () => interactive,
    runBotFix: fix,
    runBotFixCycle: async (input) => {
      cycles.push(input);
      return { fix: await fix(input) };
    },
    runBotReview: review,
  });
  await program.parseAsync(["bot", command, ...args], { from: "user" });
}
describe("registerBotCommand fix", () => {
  test("AC-7 forwards explicit invocation trust to the fix cycle", async () => {
    await run(["42", "--trust"]);
    expect(fix).toHaveBeenCalledWith(expect.objectContaining({ trust: true }));
  });
  test("AC-8 omits trust when not requested", async () => {
    await run(["42"]);
    expect(fix).toHaveBeenCalledTimes(1);
    expect(fix.mock.calls[0]?.[0]).not.toHaveProperty("trust");
  });
  test("review rejects the fix-only trust flag", async () => {
    await expect(run(["42", "--trust"], "review")).rejects.toThrow("unknown option");
    expect(review).not.toHaveBeenCalled();
  });
  test("AC-1 forwards positive PR, default directory and interactivity", async () => {
    await run(["42"]);
    expect(fix).toHaveBeenCalledTimes(1);
    expect(fix).toHaveBeenCalledWith({
      pr: 42,
      dir: process.cwd(),
      profiles: [],
      model: undefined,
      interactive: false,
      rereview: true,
      fresh: false,
    });
    expect(review).not.toHaveBeenCalled();
  });
  test("AC-2 normalizes comma-separated and repeatable profiles", async () => {
    await run(["42", "--profile", "a,b"]);
    expect(fix).toHaveBeenLastCalledWith(expect.objectContaining({ profiles: ["a", "b"] }));
    await run(["42", "--profile", "a,b", "--profile", "c"]);
    expect(fix).toHaveBeenLastCalledWith(expect.objectContaining({ profiles: ["a", "b", "c"] }));
  });
  test("AC-3 parses powerful model", async () => {
    await run(["42", "--model", "powerful"]);
    expect(fix).toHaveBeenCalledWith(expect.objectContaining({ model: "powerful" }));
  });
  test("forwards explicit directory, interactivity and agent:model", async () => {
    interactive = true;
    await run(["42", "-d", "/repo", "--model", "native:m"]);
    expect(fix).toHaveBeenCalledWith(
      expect.objectContaining({ dir: "/repo", interactive: true, model: { agent: "native", model: "m" } }),
    );
  });
  test("AC-4/5 prints pushed short SHA on stdout and exits zero", async () => {
    await run(["42"]);
    expect(stdout).toEqual(["nax bot fix: PR #42 — pushed abcdef1"]);
    expect(stderr).toEqual([]);
    expect(exits).toEqual([0]);
  });
  test("rejects a malformed pushed result without a SHA", async () => {
    result = { outcome: "pushed", step: "done", timings: {} };
    await run(["42"]);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Missing pushed SHA");
    expect(exits).toEqual([1]);
  });
  test("AC-6/7 prints nothing to fix on stdout and exits zero", async () => {
    result = { outcome: "nothing", step: "done", timings: {} };
    await run(["42"]);
    expect(stdout).toEqual(["nax bot fix: PR #42 — nothing to fix"]);
    expect(stderr).toEqual([]);
    expect(exits).toEqual([0]);
  });
  test.each([
    ["AC-8", "gates-failed"],
    ["AC-15", "protected"],
    ["AC-16", "no-change"],
    ["AC-17", "no-gates"],
    ["AC-18", "push-rejected"],
  ] as const)("%s reports %s on stderr and exits two", async (_ac, outcome) => {
    result = { outcome, step: "done", timings: {} };
    await run(["42"]);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([outcome]);
    expect(exits).toEqual([2]);
  });
  test("AC-9/10 prints refusal reason on stderr and exits two", async () => {
    result = { outcome: "refused", reason: "cannot push: denied" };
    await run(["42"]);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["cannot push: denied"]);
    expect(exits).toEqual([2]);
  });
  test.each(["abc", "0", "-1", "1.5", "1e2", "9007199254740993"])(
    "AC-11/12 rejects invalid PR %s without orchestration",
    async (pr) => {
      await run(["--", pr]);
      expect(fix).not.toHaveBeenCalled();
      expect(stdout).toEqual([]);
      expect(stderr.join("\n")).toContain("positive integer");
      expect(exits).toEqual([1]);
    },
  );
  test.each(["", ":m", "native:"])("rejects invalid model %s without orchestration", async (model) => {
    await run(["42", "--model", model]);
    expect(fix).not.toHaveBeenCalled();
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Invalid --model");
    expect(exits).toEqual([1]);
  });
  test.each(["PRE_RUN_FAILED", "BOT_FAILED"])("AC-14 reports thrown %s as exit one", async (code) => {
    failure = new NaxError("fix failed", code, { stage: "bot" });
    await run(["42"]);
    expect(fix).toHaveBeenCalledTimes(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["fix failed"]);
    expect(exits).toEqual([1]);
  });
  test("AC-19 preserves review dispatch beside fix", async () => {
    await run(["42"], "review");
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ pr: 42 }));
    expect(fix).not.toHaveBeenCalled();
  });
});
// Brief-required help-only subprocess: no orchestration or live forge access.
describe("bot fix help and export", () => {
  test("AC-13 bin help lists fix and review", async () => {
    const proc = Bun.spawn(["bun", "bin/nax.ts", "bot", "--help"], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toMatch(/^\s+fix(?:\s+\[options\])?\s+<pr>/m);
    expect(out).toContain("review");
  }, 30_000);
  test("exports botFixCommand through the public CLI barrel", async () => {
    const cli = await import("@/cli");
    expect(Reflect.get(cli, "botFixCommand")).toBeFunction();
  });
});

describe("US-001 ready-only CLI pass", () => {
  test("AC-12 --ready-only calls runBotFix directly and never the cycle", async () => {
    result = { outcome: "ready-pass", step: "done", timings: {}, readyOnly: true, markedReady: true };
    await run(["42", "--ready-only"]);
    expect(cycles).toEqual([]);
    expect(fix).toHaveBeenCalledTimes(1);
    expect(fix).toHaveBeenCalledWith(expect.objectContaining({ pr: 42, readyOnly: true }));
  });

  test("AC-13 prints the held readiness pass and exits zero", async () => {
    result = {
      outcome: "ready-pass",
      step: "done",
      timings: {},
      readyOnly: true,
      markedReady: false,
      readyHeld: "1 open critical/important finding(s) in the bot review of abc1234: f-1",
    };
    await run(["42", "--ready-only"]);
    expect(stdout).toEqual([
      "nax bot fix: ready pass — Kept as draft: 1 open critical/important finding(s) in the bot review of abc1234: f-1",
    ]);
    expect(stderr).toEqual([]);
    expect(exits).toEqual([0]);
  });

  test("AC-14 --no-rereview forwards the opt-out and reports no readiness of the pushed head", async () => {
    await run(["42", "--no-rereview"]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ pr: 42, rereview: false });
    expect(stdout).toEqual(["nax bot fix: PR #42 — pushed abcdef1"]);
    expect(stdout.join("\n")).not.toContain("Marked ready");
    expect(exits).toEqual([0]);
  });

  test("B2 --ready-only forwards --trust, so detected checks can be readied", async () => {
    result = { outcome: "ready-pass", step: "done", timings: {}, readyOnly: true, markedReady: true };
    await run(["42", "--ready-only", "--trust"]);
    expect(fix).toHaveBeenCalledTimes(1);
    expect(fix).toHaveBeenCalledWith(expect.objectContaining({ readyOnly: true, trust: true }));
    expect(exits).toEqual([0]);
  });

  test("B2 --ready-only omits trust when it was not requested", async () => {
    result = { outcome: "ready-pass", step: "done", timings: {}, readyOnly: true, markedReady: true };
    await run(["42", "--ready-only"]);
    expect(fix.mock.calls[0]?.[0]).not.toHaveProperty("trust");
  });
});

describe("US-016 fix CLI log", () => {
  test("AC-21 prints log path last on success", async () => {
    result = { outcome: "nothing", step: "done", timings: {}, logPath: "/x/bot.jsonl" };
    await run(["7"]);
    expect(stdout.at(-1)).toBe("nax bot fix: log /x/bot.jsonl");
    expect(exits).toEqual([0]);
  });
  test("AC-22 prints refused log path and preserves exit two", async () => {
    result = { outcome: "refused", reason: "no checks", logPath: "/x/bot.jsonl" };
    await run(["7"]);
    expect(stdout.at(-1)).toBe("nax bot fix: log /x/bot.jsonl");
    expect(stderr).toEqual(["no checks"]);
    expect(exits).toEqual([2]);
  });
});
