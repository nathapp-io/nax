import { describe, expect, test } from "bun:test";
import * as prompts from "@/prompts";
import * as workflow from "@/prompts/builders/workflow-builder";
import { buildWorkflowInstructions } from "@/prompts/builders/workflow-builder";

/** The four billed nax commands the instruction section must gate behind approval. */
const BILLED_COMMANDS = ["nax plan", "nax run", "nax bot review", "nax bot fix"];

/** First-mention order of the loop steps the section names. */
const LOOP_ORDER = ["spec-review", "nax plan", "nax run", "nax bot fix"];

function lines(text: string): string[] {
  return text.split("\n");
}

/** A clause that starts a billed launch only on the user's explicit approval. */
const APPROVAL_GATED_LAUNCH =
  /\b(never start|do not start|don't start|only after)\b[^.;]*\b(user's?|person's?)\b[^.;]*explicit(ly)? approv[^.;]*\blaunch\b/i;

/** A prohibition on launching without the user's explicit approval of that launch. */
const LAUNCH_FORBIDDEN_WITHOUT_APPROVAL =
  /\b(never|do not|don't)\b[^.;]*\bwithout\b[^.;]*\b(user's?|person's?)\b[^.;]*explicit(ly)? approv[^.;]*\bof (that|this|the) launch\b/i;

/** Lines that name every billed command, say so, and gate the launch on explicit approval. */
function approvalGatedLaunchLines(text: string): string[] {
  return lines(text).filter(
    (line) =>
      BILLED_COMMANDS.every((command) => line.includes(command)) &&
      line.includes("billed") &&
      APPROVAL_GATED_LAUNCH.test(line),
  );
}

/** Lines that name every billed command and forbid a launch lacking that approval. */
function forbiddingWithoutApprovalLines(text: string): string[] {
  return lines(text).filter(
    (line) =>
      BILLED_COMMANDS.every((command) => line.includes(command)) && LAUNCH_FORBIDDEN_WITHOUT_APPROVAL.test(line),
  );
}

describe("buildWorkflowInstructions", () => {
  test("AC-1 names nax-workflow__state", () => {
    expect(buildWorkflowInstructions()).toContain("nax-workflow__state");
  });

  test("AC-1 tells the agent to check state before proposing a step and again after one ends", () => {
    const stateLine = lines(buildWorkflowInstructions()).find((line) => line.includes("nax-workflow__state")) ?? "";
    expect(stateLine).not.toBe("");
    expect(stateLine).toContain("before proposing");
    expect(stateLine).toContain("after");
  });

  test("AC-2 first mentions spec-review, nax plan, nax run and nax bot fix in loop order", () => {
    const text = buildWorkflowInstructions();
    const positions = LOOP_ORDER.map((step) => text.indexOf(step));
    for (const [index, position] of positions.entries()) {
      expect({ step: LOOP_ORDER[index], found: position >= 0 }).toEqual({ step: LOOP_ORDER[index], found: true });
    }
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(LOOP_ORDER.length);
  });

  test("AC-3 names the --prd PRD fidelity check", () => {
    expect(buildWorkflowInstructions()).toContain("--prd");
  });

  test("AC-4 caps spec-review fix rounds at two", () => {
    expect(buildWorkflowInstructions()).toContain("at most two");
  });

  test("AC-5 says a billed launch starts only on the user's explicit approval", () => {
    const text = buildWorkflowInstructions();
    expect(approvalGatedLaunchLines(text)).toHaveLength(1);
    const approvalLine = approvalGatedLaunchLines(text)[0] ?? "";
    expect(approvalLine).toContain("explicit");
  });

  test("AC-6 says nax never merges a PR", () => {
    expect(buildWorkflowInstructions()).toContain("never merges");
  });

  test("AC-7 is re-exported from the @/prompts barrel with the same text", () => {
    expect(typeof prompts.buildWorkflowInstructions).toBe("function");
    expect(prompts.buildWorkflowInstructions()).toBe(buildWorkflowInstructions());
  });

  test("AC-8 forbids launching any billed command without the user's explicit approval of that launch", () => {
    expect(forbiddingWithoutApprovalLines(buildWorkflowInstructions())).toHaveLength(1);
  });

  test("AC-5/AC-8 assertions reject a billed line that never ties the launch to approval", () => {
    const weakWording = [
      "`nax plan`, `nax run`, `nax bot review` and `nax bot fix` are billed; explicit is an adjective.",
      "`nax plan`, `nax run`, `nax bot review` and `nax bot fix` are billed and approval exists somewhere.",
      "`nax plan`, `nax run`, `nax bot review` and `nax bot fix` are billed: you may approve a launch.",
    ].join("\n");
    expect(approvalGatedLaunchLines(weakWording)).toHaveLength(0);
    expect(forbiddingWithoutApprovalLines(weakWording)).toHaveLength(0);
  });

  test("AC-5/AC-8 assertions reject generic approval that is not the user's", () => {
    const genericApproval = [
      "`nax plan`, `nax run`, `nax bot review` and `nax bot fix` are billed: never start one without explicit approval of that launch.",
      "`nax plan`, `nax run`, `nax bot review` and `nax bot fix` are billed: never start one without the agent's explicit approval of that launch.",
      "`nax plan`, `nax run`, `nax bot review` and `nax bot fix` are billed and start only after explicit approval of that launch.",
    ].join("\n");
    expect(approvalGatedLaunchLines(genericApproval)).toHaveLength(0);
    expect(forbiddingWithoutApprovalLines(genericApproval)).toHaveLength(0);
  });

  test("returns the same fixed text on every call", () => {
    expect(buildWorkflowInstructions()).toBe(buildWorkflowInstructions());
  });
});

const JOB = { id: "run-1a2b3c4d", kind: "run", target: "f1", state: "succeeded", logPath: "/o/l.log" };

describe("buildJobNotice", () => {
  test("US-004 AC-1 formats cost to two decimals", () => {
    expect(lines(workflow.buildJobNotice({ ...JOB, cost: 1.234 }))[0]).toBe(
      "[nax-jobs] job run-1a2b3c4d (run f1) ended: succeeded cost $1.23 log /o/l.log",
    );
  });

  test("US-004 AC-2 includes an exit note without cost", () => {
    const first = lines(workflow.buildJobNotice({ ...JOB, note: "exit code 2" }))[0];
    expect(first).toContain(" (exit code 2) log ");
    expect(first).not.toContain("cost");
  });

  test("US-004 AC-3 gives state, outcome and single next-step instructions on the second line", () => {
    const noticeLines = lines(workflow.buildJobNotice(JOB));
    expect(noticeLines).toHaveLength(2);
    expect(noticeLines[1]).toContain("nax-workflow__state");
    expect(noticeLines[1]).toContain("report the outcome to the user");
    expect(noticeLines[1]).toContain("propose the single next step");
  });

  test("US-004 AC-10 preserves failure note without fabricating cost", () => {
    expect(lines(workflow.buildJobNotice({ ...JOB, state: "failed", note: "no run record for pid 4242" }))[0]).toBe(
      "[nax-jobs] job run-1a2b3c4d (run f1) ended: failed (no run record for pid 4242) log /o/l.log",
    );
  });

  test("includes zero cost and places cost before note", () => {
    expect(lines(workflow.buildJobNotice({ ...JOB, cost: 0, note: "done" }))[0]).toBe(
      "[nax-jobs] job run-1a2b3c4d (run f1) ended: succeeded cost $0.00 (done) log /o/l.log",
    );
  });

  test("US-004 AC-9 barrel notice matches the builder", () => {
    expect(prompts.buildJobNotice(JOB)).toBe(workflow.buildJobNotice(JOB));
  });
});

describe("buildJobsInstructions", () => {
  test.each(["nax-jobs__plan", "nax-jobs__run", "nax-jobs__bot_review", "nax-jobs__bot_fix"])(
    "US-004 AC-4 names billed tool %s",
    (tool) => {
      expect(workflow.buildJobsInstructions()).toContain(tool);
    },
  );

  test("US-004 AC-5 requires an approval card for each billed call", () => {
    expect(workflow.buildJobsInstructions()).toContain("each is billed and shows the user an approval card");
  });

  test("US-004 AC-6 explains background completion notices", () => {
    expect(workflow.buildJobsInstructions()).toContain(
      "Jobs run in the background; a [nax-jobs] notice arrives when one ends.",
    );
  });

  test("US-004 AC-7 explains checkout write refusal during run or plan", () => {
    expect(workflow.buildJobsInstructions()).toContain(
      "Write, Edit, Delete and GitCommit are refused in this checkout while a run or plan job runs.",
    );
  });

  test("US-004 AC-8 makes denial final and forbids argument-changing retries", () => {
    expect(workflow.buildJobsInstructions().toLowerCase()).toContain(
      "a denial is final for that call; do not retry with changed arguments to get round it.",
    );
  });

  test("requires one step at a time and reporting before proposing the next", () => {
    expect(workflow.buildJobsInstructions()).toContain(
      "Start one step at a time: after a job ends, report the outcome to the user and propose the single next step.",
    );
  });

  test("US-004 AC-9 barrel instructions match the builder", () => {
    expect(prompts.buildJobsInstructions()).toBe(workflow.buildJobsInstructions());
  });
});

describe("workflow text preservation", () => {
  test("US-004 AC-11 retains the exact four original lines", () => {
    expect(buildWorkflowInstructions()).toBe(
      [
        "Call `nax-workflow__state` before proposing any workflow step, and call it again after any workflow step ends, so what you propose matches the feature's real state.",
        "The nax loop runs in this order: brainstorm → spec-writing → spec-review (at most two fix rounds) → `nax plan` → PRD fidelity check (spec-review `--prd`) → commit the spec and PRD → `nax run` → `nax bot review` / `nax bot fix` → the user merges → the user releases.",
        "`nax plan`, `nax run`, `nax bot review` and `nax bot fix` are billed: never start one without the user's explicit approval of that launch.",
        "nax never merges a PR and never releases; the user merges the PR and the user releases.",
      ].join("\n"),
    );
  });
});
