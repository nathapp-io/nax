import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { Command } from "commander";
import type { BotReviewResult, runBotReview } from "@/bot";
import { _botCliDeps } from "@/cli/bot";
import { NaxError } from "@/errors";
import { defaultForgeDeps } from "@/forge";

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
const initialize = mock(() => {});
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
  initialize.mockClear();
});
async function run(...args: string[]): Promise<void> {
  const { registerBotCommand, _botCliDeps } = await import("@/cli/bot");
  const program = new Command().exitOverride();
  registerBotCommand(program, {
    ..._botCliDeps,
    initLogger: initialize,
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
afterEach(() => mock.restore());
describe("botReviewCommand chat secret", () => {
  test("reads the valid first stdin line before forwarding the 32-byte secret", async () => {
    const { botReviewCommand } = await import("@/cli/bot");
    const secret = new Uint8Array(32).fill(17);
    const stdin = mock(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`${Buffer.from(secret).toString("hex")}\n`));
            controller.close();
          },
        }),
    );
    await botReviewCommand(
      { pr: "12", dir: "/repo", chatAsks: "/tmp/asks" },
      {
        ..._botCliDeps,
        stdin,
        runBotReview: review,
        log: () => {},
      },
    );
    expect(stdin).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ chatAskSecret: secret }));
  });
});

describe("registerBotCommand review decisions and readiness", () => {
  test("US-013 AC-1/2 forwards decisions loaded through the lazy dependency", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "decisions.json");
      const decisions = [{ id: "D-1", statement: "Keep generated files" }];
      await Bun.write(path, JSON.stringify({ version: 1, decisions }));
      const load = spyOn(_botCliDeps, "loadBotDecisions");
      await run("7", "--decisions", path);
      expect(load).toHaveBeenCalledWith(path);
      expect(review).toHaveBeenCalledWith(expect.objectContaining({ decisions }));
      expect(exits).toEqual([0]);
    });
  });
  test.each(["missing", "invalid"])("US-013 AC-3/4/5/14/15 rejects %s before review or forge", async (kind) => {
    await withTempDir(async (dir) => {
      const path = join(dir, "decisions.json");
      if (kind === "invalid") await Bun.write(path, '{"version":2,"decisions":[]}');
      const forge = spyOn(defaultForgeDeps, "run");
      await run("7", "--decisions", path);
      expect(stderr).toHaveLength(1);
      if (kind === "missing") expect(stderr[0]).toBe(`[bot] Cannot read decisions file ${path}`);
      else expect(stderr[0]).toStartWith(`[bot] Invalid decisions file ${path}`);
      expect(exits).toEqual([1]);
      expect(review).not.toHaveBeenCalled();
      expect(forge).not.toHaveBeenCalled();
    });
  });
  test("US-013 AC-6 does not load or forward decisions when omitted", async () => {
    const load = spyOn(_botCliDeps, "loadBotDecisions");
    await run("7");
    expect(load).not.toHaveBeenCalled();
    expect(review.mock.calls[0]?.[0].decisions).toBeUndefined();
    expect(review).toHaveBeenCalledTimes(1);
  });
  test("US-013 AC-8 warns about absent checks without changing success", async () => {
    result = { ...posted, checksSource: "none" };
    await run("7");
    expect(stderr).toEqual(["nax bot review: no check commands found on the base branch; nax bot fix will refuse"]);
    expect(exits).toEqual([0]);
  });
});
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
      "nax bot review: artifact /artifacts/bot-review.json",
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

describe("US-016 review CLI log", () => {
  test("AC-20 prints log path last", async () => {
    result = { ...posted, logPath: "/x/bot.jsonl" };
    await run("7");
    expect(stdout.at(-1)).toBe("nax bot review: log /x/bot.jsonl");
  });
  test("AC-23 initializes silent logger before review", async () => {
    review.mockImplementationOnce(async () => {
      expect(initialize).toHaveBeenCalledWith({ level: "silent", useChalk: false });
      return posted;
    });
    await run("7");
    expect(review).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([0]);
  });
});
