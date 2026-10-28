import { describe, expect, test } from "bun:test";
import * as prompts from "@/prompts";
import { buildJobNotice, buildJobsInstructions, type JobNoticeInput } from "@/prompts/builders/workflow-builder";

function lines(text: string): string[] {
  return text.split("\n");
}

const CHAIN_JOB: JobNoticeInput = {
  id: "run-1a2b3c4d",
  kind: "run",
  target: "f1",
  state: "succeeded",
  logPath: "/o/l.log",
  chainId: "chain-1a2b3c4d",
  chainStep: 2,
};

const CHAIN_NOTICE_LINE =
  "This job is step 2 of chain chain-1a2b3c4d; call nax-jobs__list to see whether the chain continues, and if it does, call the next step's launch tool with exactly the approved arguments (no card is shown for it).";

const CHAIN_INSTRUCTIONS = [
  '`nax-jobs__chain` proposes a full run: an ordered list of billed steps on one approval card. Only the user\'s yes on that card approves it; a chat message such as "go ahead" does not.',
  "While a chain is active, call each step's launch tool with exactly the approved arguments, one step at a time, after the previous step succeeded; a different call stops the chain and shows a normal card.",
  "Before a step that names a check, run that check yourself and record its verdict with `nax-jobs__chain_check`; stop the chain with `nax-jobs__chain_stop` when the user asks.",
];

describe("buildJobNotice — chain line", () => {
  test("AC-1 a chained job yields three lines", () => {
    expect(lines(buildJobNotice(CHAIN_JOB))).toHaveLength(3);
  });

  test("AC-2 the third line tells the agent to check the chain with nax-jobs__list", () => {
    expect(lines(buildJobNotice(CHAIN_JOB))[2]).toBe(CHAIN_NOTICE_LINE);
  });

  test("AC-2 the chain line names the actual step and chain", () => {
    const third = lines(buildJobNotice({ ...CHAIN_JOB, chainId: "chain-9f8e7d6c", chainStep: 1 }))[2] ?? "";
    expect(third).toContain("step 1 of chain chain-9f8e7d6c");
  });

  test("AC-3 a job with no chainId yields two lines", () => {
    expect(lines(buildJobNotice({ ...CHAIN_JOB, chainId: undefined, chainStep: undefined }))).toHaveLength(2);
  });

  test("F1 a chainId without a chainStep still gets a chain line", () => {
    const chainedOnly = lines(buildJobNotice({ ...CHAIN_JOB, chainStep: undefined }));
    expect(chainedOnly).toHaveLength(3);
    expect(chainedOnly[2]).toBe(
      "This job is part of chain chain-1a2b3c4d; call nax-jobs__list to see whether the chain continues, and if it does, call the next step's launch tool with exactly the approved arguments (no card is shown for it).",
    );
  });

  test("F1 a chainId without a chainStep never prints an undefined step", () => {
    const third = lines(buildJobNotice({ ...CHAIN_JOB, chainStep: undefined }))[2] ?? "";
    expect(third).toContain("chain chain-1a2b3c4d");
    expect(third).not.toContain("undefined");
    expect(third).not.toContain("step ");
  });

  test("AC-2/AC-9 the two original lines are unchanged for a chained job", () => {
    const chained = lines(buildJobNotice(CHAIN_JOB));
    const plain = lines(buildJobNotice({ ...CHAIN_JOB, chainId: undefined, chainStep: undefined }));
    expect(chained[0]).toBe(plain[0]);
    expect(chained[1]).toBe(plain[1]);
  });

  test("AC-2 the chain line keeps cost and note in the first line", () => {
    const first = lines(buildJobNotice({ ...CHAIN_JOB, cost: 1.234, note: "exit code 2" }))[0];
    expect(first).toBe("[nax-jobs] job run-1a2b3c4d (run f1) ended: succeeded cost $1.23 (exit code 2) log /o/l.log");
  });

  test("AC-9 a failed job with no chainId is exactly the original failure notice", () => {
    const notice = buildJobNotice({
      id: "run-1a2b3c4d",
      kind: "run",
      target: "f1",
      state: "failed",
      note: "no run record for pid 4242",
      logPath: "/o/l.log",
    });
    expect(notice).toBe(
      "[nax-jobs] job run-1a2b3c4d (run f1) ended: failed (no run record for pid 4242) log /o/l.log\nCall `nax-workflow__state`, report the outcome to the user and propose the single next step.",
    );
  });
});

describe("buildJobsInstructions — chain lines", () => {
  test("AC-4 carries the nax-jobs__chain approval line", () => {
    expect(lines(buildJobsInstructions())).toContain(CHAIN_INSTRUCTIONS[0] as string);
  });

  test("AC-5 carries the one-step-at-a-time chain launch line", () => {
    expect(lines(buildJobsInstructions())).toContain(CHAIN_INSTRUCTIONS[1] as string);
  });

  test("AC-6 carries the chain check and stop line", () => {
    expect(lines(buildJobsInstructions())).toContain(CHAIN_INSTRUCTIONS[2] as string);
  });

  test("AC-7 the fifth line is still the single-next-step line", () => {
    expect(lines(buildJobsInstructions())[4]).toBe(
      "Start one step at a time: after a job ends, report the outcome to the user and propose the single next step.",
    );
  });

  test("AC-8 returns exactly eight lines, the chain lines last", () => {
    const instructionLines = lines(buildJobsInstructions());
    expect(instructionLines).toHaveLength(8);
    expect(instructionLines.slice(5)).toEqual(CHAIN_INSTRUCTIONS);
  });

  test("AC-4..AC-8 the five original instruction lines are preserved verbatim", () => {
    expect(lines(buildJobsInstructions()).slice(0, 5)).toEqual([
      "`nax-jobs__plan`, `nax-jobs__run`, `nax-jobs__bot_review` and `nax-jobs__bot_fix`: each is billed and shows the user an approval card.",
      "A denial is final for that call; do not retry with changed arguments to get round it.",
      "Jobs run in the background; a [nax-jobs] notice arrives when one ends.",
      "Write, Edit, Delete and GitCommit are refused in this checkout while a run or plan job runs.",
      "Start one step at a time: after a job ends, report the outcome to the user and propose the single next step.",
    ]);
  });

  test("the chain lines reach the @/prompts barrel text", () => {
    expect(prompts.buildJobsInstructions()).toBe(buildJobsInstructions());
    for (const line of CHAIN_INSTRUCTIONS) expect(prompts.buildJobsInstructions()).toContain(line);
  });
});
