import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Command } from "commander";
import type { BotReviewResult, runBotReview } from "@/bot";
import { NaxError } from "@/errors";

const posted: BotReviewResult = {
  outcome: "posted",
  intent: "pass",
  quality: "changes",
  staticMode: false,
  checksSource: "config",
  artifactPath: "/artifacts/bot-review.json",
  earlierAnswered: 0,
  inlineFindings: 3,
  threadsAnswered: 2,
  commentsAnswered: 0,
  offLine: 0,
  failed: 0,
};
let stdout: string[];
let stderr: string[];
let exits: number[];
let result: BotReviewResult;
let failure: unknown;
let interactive: boolean;
const review = mock(async (_input: Parameters<typeof runBotReview>[0]) => {
  if (failure) throw failure;
  return result;
});
beforeEach(() => {
  stdout = [];
  stderr = [];
  exits = [];
  result = posted;
  failure = undefined;
  interactive = false;
  review.mockClear();
});
async function run(...args: string[]): Promise<void> {
  const { registerBotCommand, _botCliDeps } = await import("@/cli/bot");
  const program = new Command().exitOverride();
  registerBotCommand(program, {
    ..._botCliDeps,
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
    runBotReview: review,
  });
  await program.parseAsync(["bot", "review", ...args], { from: "user" });
}
describe("registerBotCommand review", () => {
  test("AC-1 forwards the PR and current directory", async () => {
    await run("42");
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ pr: 42, dir: process.cwd(), interactive: false }));
  });
  test("AC-2 accumulates profiles", async () => {
    await run("42", "--profile", "a,b", "--profile", "c");
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ profiles: ["a", "b", "c"] }));
  });
  test("AC-3 parses an explicit model", async () => {
    await run("42", "--model", "native:m");
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ model: { agent: "native", model: "m" } }));
  });
  test("AC-4 forwards directory and interactivity", async () => {
    interactive = true;
    await run("42", "-d", "/repo");
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ dir: "/repo", interactive: true }));
  });
  test("AC-5/6 prints the posted summary and exits zero", async () => {
    await run("42");
    expect(stdout).toEqual([
      "nax bot review: PR #42 — 3 findings posted, 2 threads answered (intent pass, quality changes)",
    ]);
    expect(stderr).toEqual([]);
    expect(exits).toEqual([0]);
  });
  test.each(["refused", "not-reviewed"] as const)("AC-7/8/9 reports %s and exits two", async (outcome) => {
    result = { outcome, reason: "review unavailable" };
    await run("42");
    expect(stderr).toEqual(["review unavailable"]);
    expect(stdout).toEqual([]);
    expect(exits).toEqual([2]);
  });
  test.each(["abc", "0", "-1", "1.5", "1e2", "https://github.com/o/r/pull/42", "9007199254740993"])(
    "AC-10/11/12/13 rejects invalid PR %s before orchestration",
    async (pr) => {
      await run("--", pr);
      expect(review).not.toHaveBeenCalled();
      expect(exits).toEqual([1]);
      expect(stderr.join("\n")).toContain("positive integer");
      expect(stdout).toEqual([]);
    },
  );
  test("AC-14/15 rejects empty model before orchestration", async () => {
    await run("42", "--model", "");
    expect(review).not.toHaveBeenCalled();
    expect(exits).toEqual([1]);
    expect(stderr.join("\n")).toContain("Invalid --model");
  });
  test("AC-16/17 reports NaxError.message and exits one", async () => {
    failure = new NaxError("review failed", "BOT_FAILED", { stage: "bot" });
    await run("42");
    expect(stderr).toEqual(["review failed"]);
    expect(stdout).toEqual([]);
    expect(exits).toEqual([1]);
  });
});
describe("_botCliDeps process boundary", () => {
  test("writes plain lines, detects TTYs and forwards exit status", async () => {
    const { _botCliDeps } = await import("@/cli/bot");
    const out = spyOn(process.stdout, "write").mockReturnValue(true);
    const err = spyOn(process.stderr, "write").mockReturnValue(true);
    const sentinel = new NaxError("exit captured", "TEST_EXIT", { stage: "test" });
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw sentinel;
    });
    try {
      _botCliDeps.log("summary");
      _botCliDeps.logErr("reason");
      expect(out).toHaveBeenCalledWith("summary\n");
      expect(err).toHaveBeenCalledWith("reason\n");
      const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      try {
        for (const [stdin, stdout, expected] of [
          [true, true, true],
          [true, false, false],
          [false, true, false],
          [false, false, false],
        ]) {
          Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
          Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
          expect(_botCliDeps.isInteractive()).toBe(expected);
        }
      } finally {
        if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
        else Reflect.deleteProperty(process.stdin, "isTTY");
        if (stdoutTty) Object.defineProperty(process.stdout, "isTTY", stdoutTty);
        else Reflect.deleteProperty(process.stdout, "isTTY");
      }
      expect(() => _botCliDeps.exit(2)).toThrow(sentinel);
      expect(exit).toHaveBeenCalledWith(2);
    } finally {
      out.mockRestore();
      err.mockRestore();
      exit.mockRestore();
    }
  });
});
// Brief-required help-only subprocesses: no run/precheck or real forge calls.
describe("bot CLI help wiring", () => {
  test.each([
    ["AC-18", ["bot", "--help"], "review"],
    ["AC-19", ["--help"], "workflow"],
  ])(
    "%s preserves help registration",
    async (_ac, args, entry) => {
      const proc = Bun.spawn(["bun", "bin/nax.ts", ...args], { stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(err).toBe("");
      expect(out).toContain(entry);
    },
    30_000,
  );
});
