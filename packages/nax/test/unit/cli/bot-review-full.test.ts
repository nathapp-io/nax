import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import type { BotReviewResult, runBotReview } from "@/bot";
import { _botCliDeps, registerBotCommand } from "@/cli/bot";

const posted: BotReviewResult = {
  outcome: "posted",
  intent: "pass",
  quality: "approved",
  staticMode: false,
  checksSource: "config",
  artifactPath: "/artifacts/bot-review.json",
  earlierAnswered: 0,
  inlineFindings: 0,
  threadsAnswered: 0,
  commentsAnswered: 0,
  offLine: 0,
  failed: 0,
};
const initialize = mock(() => {});
const review = mock(async (_input: Parameters<typeof runBotReview>[0]) => posted);
const fixCycle = mock<typeof _botCliDeps.runBotFixCycle>(async () => ({
  fix: { outcome: "nothing", step: "done", timings: {} },
}));
let exits: number[];
let stderr: string[];

beforeEach(() => {
  exits = [];
  stderr = [];
  review.mockClear();
  fixCycle.mockClear();
  initialize.mockClear();
});

afterEach(() => mock.restore());

/** Real Commander parsing: the flag reaches the input only through the registered option. */
async function run(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  // The parser's own stderr would duplicate what the command's logErr dep already captures.
  program.configureOutput({ writeErr: () => {} });
  registerBotCommand(program, {
    ..._botCliDeps,
    initLogger: initialize,
    log: () => {},
    logErr: (message) => {
      stderr.push(message);
    },
    exit: (code) => {
      exits.push(code);
    },
    isInteractive: () => false,
    runBotReview: review,
    runBotFixCycle: fixCycle,
  });
  await program.parseAsync(["bot", ...args], { from: "user" });
}

function reviewInput(): Parameters<typeof runBotReview>[0] {
  const input = review.mock.calls[0]?.[0];
  if (input === undefined) throw new Error("runBotReview was not called");
  return input;
}

describe("nax bot review --full", () => {
  test("AC-1 forwards --full as full true", async () => {
    await run("review", "12", "--full");
    expect(reviewInput()).toMatchObject({ pr: 12, full: true });
    expect(exits).toEqual([0]);
  });
  test("AC-2 omits the full key without --full", async () => {
    await run("review", "12");
    expect(Object.hasOwn(reviewInput(), "full")).toBe(false);
    expect(reviewInput().full).toBeUndefined();
    expect(exits).toEqual([0]);
  });
  test("registers --full on review only, so the fix cycle can never re-review full", async () => {
    await expect(run("fix", "12", "--full")).rejects.toThrow(/unknown option/i);
    expect(fixCycle).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(stderr).toEqual([]);
  });
});

describe("nax bot review --rulings", () => {
  const file = { version: 1 as const, headSha: "a".repeat(40), rulings: [] };
  const loadCallerRulings = mock(async (_path: string) => file);

  async function runWith(logs: string[], ...args: string[]): Promise<void> {
    const program = new Command().exitOverride();
    registerBotCommand(program, {
      ..._botCliDeps,
      initLogger: initialize,
      log: (message) => {
        logs.push(message);
      },
      logErr: (message) => {
        stderr.push(message);
      },
      exit: (code) => {
        exits.push(code);
      },
      isInteractive: () => false,
      runBotReview: review,
      loadCallerRulings,
    });
    await program.parseAsync(["bot", ...args], { from: "user" });
  }

  test("loads the file and forwards it to the review", async () => {
    await runWith([], "review", "12", "--rulings", "/tmp/r.json");
    expect(loadCallerRulings).toHaveBeenCalledWith("/tmp/r.json");
    expect(reviewInput().callerRulings).toEqual(file);
  });
  test("omits callerRulings without the flag", async () => {
    await runWith([], "review", "12");
    expect(Object.hasOwn(reviewInput(), "callerRulings")).toBe(false);
  });
  test("prints a one-line summary of what the file did", async () => {
    review.mockImplementationOnce(async () => ({
      ...posted,
      callerRulings: {
        applied: [
          { item: "A", disposition: "waived" },
          { item: "B", disposition: "confirmed" },
        ],
        skipped: [{ item: "C", reason: "stale-key" }],
      },
    }));
    const logs: string[] = [];
    await runWith(logs, "review", "12", "--rulings", "/tmp/r.json");
    expect(logs).toContain("nax bot review: caller rulings — 2 applied, 1 skipped");
  });
  test("reports an ignored file", async () => {
    review.mockImplementationOnce(async () => ({
      ...posted,
      callerRulings: { applied: [], skipped: [], ignored: "untrusted-pr" },
    }));
    const logs: string[] = [];
    await runWith(logs, "review", "12", "--rulings", "/tmp/r.json");
    expect(logs).toContain("nax bot review: caller rulings — ignored (untrusted-pr)");
  });
  test("an invalid file fails the command before any review", async () => {
    loadCallerRulings.mockImplementationOnce(async () => {
      throw new Error("[bot] Invalid rulings file /tmp/r.json: bad");
    });
    await runWith([], "review", "12", "--rulings", "/tmp/r.json");
    expect(review).not.toHaveBeenCalled();
    expect(exits).toEqual([1]);
    expect(stderr[0]).toContain("Invalid rulings file");
  });
  test("bot fix does not take --rulings", async () => {
    await expect(run("fix", "12", "--rulings", "/tmp/r.json")).rejects.toThrow(/unknown option/i);
  });
});
