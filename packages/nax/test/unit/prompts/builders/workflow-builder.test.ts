import { describe, expect, test } from "bun:test";
import { PROJECT_FEATURES_DIR } from "@/config";
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

/**
 * The six lines US-004 pinned, in order. Kept verbatim so a rewrite of the text
 * fails here rather than silently reflowing the section.
 */
const ORIGINAL_LINES = [
  "Call `nax-workflow__state` before proposing any workflow step, and call it again after any workflow step ends, so what you propose matches the feature's real state.",
  "The nax loop runs in this order: brainstorm → spec-writing → spec-review (usually two fix rounds) → `nax plan` → PRD fidelity check (spec-review `--prd`) → commit the spec and PRD → `nax run` → `nax bot review` / `nax bot fix` → the user merges → the user releases.",
  'Two spec-review fix rounds are the default budget, not a limit: past two, another round needs the user\'s go-ahead, and a user instruction to continue (including an earlier one such as "until clean") is that go-ahead, for spec rounds only and never for `nax plan`. Applying spec fixes is your work; the user rules only on findings you cannot settle, never on edits.',
  "`nax plan`, `nax run`, `nax bot review` and `nax bot fix` are billed: never start one without the user's explicit approval of that launch.",
  "nax never merges a PR and never releases; the user merges the PR and the user releases.",
  "When the nax project is in a folder inside this chat's folder (for example repos/nax), pass repo with that folder's path; the chat stays where it is.",
];

/** Where a feature's spec lives, read from the one source of the feature tree. */
const SPEC_PATH = `${PROJECT_FEATURES_DIR}/<feature>/spec.md`;

/** What the PRD fidelity check writes. */
const FIDELITY_REPORT_PATH = `${PROJECT_FEATURES_DIR}/<feature>/prd-fidelity-report.md`;

/** The one line naming the spec report, present whether or not `chat.workflow` is set. */
const PATHS_LINE = `The spec for a feature is \`${SPEC_PATH}\`, which is where the plan launch reads it. Spec-review findings and fixes stay in this chat and in the spec itself, so a spec round writes no report file; the PRD fidelity check (spec-review --prd) writes \`${FIDELITY_REPORT_PATH}\`.`;

/** The fixed line that puts a feature's plan and run on its feature branch. */
const BRANCH_LINE =
  "A feature's `nax plan` and `nax run` happen on its feature branch (the PRD's branchName, by default feat/<feature>), never on main or master: create or check out that branch before the launch; `nax-jobs__plan` and `nax-jobs__run` refuse on main, master or an unnamed branch.";

/** The line that hands the unset choices back to the user. */
const CHOICES_LINE =
  "In this chat, where chat.workflow does not set them, the plan and run profiles and the spec writer and reviewer are the user's choice: nax-jobs__list returns the profile names; ask for the spec writer and reviewer when you propose spec-writing, and for the profiles in the same message that asks for plan approval.";

/** How the budget reads in English for the rounds the schema accepts. */
const ROUND_WORDS = {
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
  10: "ten",
} as const;

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

  test("AC-4 names two spec-review fix rounds as the usual budget", () => {
    expect(buildWorkflowInstructions()).toContain("spec-review (usually two fix rounds)");
  });

  test("#2929 never states the spec-review fix rounds as a hard cap", () => {
    const specReviewLines = lines(buildWorkflowInstructions()).filter((line) => line.includes("spec-review"));
    expect(specReviewLines.length).toBeGreaterThan(0);
    for (const line of specReviewLines) {
      expect({ line, capped: /at most|no more than|maximum|\bcap\b/i.test(line) }).toEqual({ line, capped: false });
    }
  });

  test("#2929 the user's instruction to continue is the go-ahead past two rounds, for spec rounds only", () => {
    const budgetLine = lines(buildWorkflowInstructions()).find((line) => line.includes("default budget")) ?? "";
    expect(budgetLine).toContain("not a limit");
    expect(budgetLine).toContain("a user instruction to continue");
    expect(budgetLine).toContain("never for `nax plan`");
  });

  test("#2929 applying spec fixes stays with the agent; the user rules only on findings it cannot settle", () => {
    const text = buildWorkflowInstructions();
    expect(text).toContain("Applying spec fixes is your work");
    expect(text).toContain("the user rules only on findings you cannot settle");
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
  test.each(["nax-jobs__plan", "nax-jobs__run", "nax-jobs__finish", "nax-jobs__bot_review", "nax-jobs__bot_fix"])(
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
  test("US-004 AC-11 retains the original lines, the fix-budget line (#2929), then the repo line", () => {
    expect(lines(buildWorkflowInstructions()).slice(0, ORIGINAL_LINES.length)).toEqual(ORIGINAL_LINES);
  });

  test("US-007 appends the paths line then the choices line after the last original line", () => {
    const output = lines(buildWorkflowInstructions());
    expect(output.slice(ORIGINAL_LINES.length)).toEqual([PATHS_LINE, BRANCH_LINE, CHOICES_LINE]);
  });

  test("US-007 keeps the six fixed lines byte-identical when chat.workflow is set", () => {
    const output = lines(
      buildWorkflowInstructions({
        workflow: {
          specFixRounds: 2,
          plan: { profiles: ["p1"] },
          run: { profiles: ["r1"] },
          specWriter: { agent: "general" },
          specReviewer: { agent: "code-reviewer" },
        },
      }),
    );
    expect(output.slice(0, ORIGINAL_LINES.length)).toEqual(ORIGINAL_LINES);
  });
});

describe("US-002 buildWorkflowInstructions feature branch", () => {
  test("AC-18 names the guarded launches, main, master and the default branch", () => {
    const branchLines = lines(buildWorkflowInstructions()).filter(
      (line) =>
        line.includes("nax-jobs__plan") &&
        line.includes("nax-jobs__run") &&
        line.includes("main") &&
        line.includes("master") &&
        line.includes("feat/<feature>"),
    );
    expect(branchLines).toEqual([BRANCH_LINE]);
  });

  test("AC-19 puts the branch line right after the fidelity-report line, before any chat.workflow line", () => {
    const output = lines(
      buildWorkflowInstructions({
        workflow: {
          specFixRounds: 2,
          plan: { profiles: ["p1"] },
          specWriter: { agent: "general" },
          specReviewer: { agent: "code-reviewer" },
        },
      }),
    );
    const pathsAt = output.findIndex((line) => line.includes(FIDELITY_REPORT_PATH));
    expect(output[pathsAt + 1]).toBe(BRANCH_LINE);
    const firstOptionalAt = output.findIndex(
      (line) =>
        line.includes("Spec-writing runs through") ||
        line.includes("sets the profiles") ||
        line.startsWith("In this chat, where chat.workflow does not set them,"),
    );
    expect(firstOptionalAt).toBeGreaterThan(output.indexOf(BRANCH_LINE));
  });
});

describe("US-007 buildWorkflowInstructions fix-round budget", () => {
  test("AC-1 states two fix rounds when no workflow is given", () => {
    expect(buildWorkflowInstructions()).toContain("spec-review (usually two fix rounds)");
  });

  test("AC-2 renders specFixRounds 3 as three in the loop line", () => {
    expect(buildWorkflowInstructions({ workflow: { specFixRounds: 3 } })).toContain(
      "spec-review (usually three fix rounds)",
    );
  });

  test("AC-3 starts the budget line with Three ... past three, for specFixRounds 3", () => {
    const prefix = "Three spec-review fix rounds are the default budget, not a limit: past three,";
    const budgetLines = lines(buildWorkflowInstructions({ workflow: { specFixRounds: 3 } })).filter((line) =>
      line.startsWith(prefix),
    );
    expect(budgetLines).toHaveLength(1);
  });

  test.each([1, 4, 5, 6, 7, 8, 9, 10] as const)("spells specFixRounds %i as an English word", (rounds) => {
    const word = ROUND_WORDS[rounds];
    const text = buildWorkflowInstructions({ workflow: { specFixRounds: rounds } });
    expect(text).toContain(`usually ${word} fix rounds`);
    const capitalised = `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    expect(
      lines(text).filter((line) => line.startsWith(`${capitalised} spec-review fix rounds are the default budget`)),
    ).toHaveLength(1);
  });
});

describe("US-007 buildWorkflowInstructions feature paths", () => {
  test("AC-4 names the feature spec path as where the plan launch reads the spec", () => {
    const pathLine = lines(buildWorkflowInstructions()).find((line) => line.includes(SPEC_PATH)) ?? "";
    expect(pathLine).toContain(`\`${SPEC_PATH}\``);
    expect(pathLine).toContain("where the plan launch reads it");
  });

  test("AC-5 says a spec round writes no report file", () => {
    const pathLine = lines(buildWorkflowInstructions()).find((line) => line.includes(SPEC_PATH)) ?? "";
    expect(pathLine).toContain("a spec round writes no report file");
  });

  test("AC-6 names the PRD fidelity report as what spec-review --prd writes", () => {
    const pathLine = lines(buildWorkflowInstructions()).find((line) => line.includes(SPEC_PATH)) ?? "";
    expect(pathLine).toContain(`\`${FIDELITY_REPORT_PATH}\``);
    expect(pathLine).toContain("the PRD fidelity check (spec-review --prd) writes");
  });
});

describe("US-007 buildWorkflowInstructions spec agents", () => {
  test("AC-7 names the configured spec writer and reviewer choices", () => {
    expect(
      buildWorkflowInstructions({
        workflow: {
          specFixRounds: 2,
          specWriter: { agent: "general", model: "m/w" },
          specReviewer: { agent: "code-reviewer" },
        },
      }),
    ).toContain(
      "Spec-writing runs through nax-agents__run with agent general and model m/w; spec-review runs with agent code-reviewer (chat.workflow).",
    );
  });

  test("AC-8 a model-only spec writer renders as the general agent on that model", () => {
    const text = buildWorkflowInstructions({ workflow: { specFixRounds: 2, specWriter: { model: "m/w" } } });
    expect(text).toContain("Spec-writing runs through nax-agents__run with agent general and model m/w;");
  });

  test("AC-9 a set spec writer with no reviewer renders the reviewer as the agent you choose", () => {
    const text = buildWorkflowInstructions({ workflow: { specFixRounds: 2, specWriter: { agent: "general" } } });
    expect(text).toContain("spec-review runs with the agent you choose (chat.workflow).");
  });

  test.each([
    ["AC-10", {}],
    ["AC-11", { specWriter: {}, specReviewer: {} }],
  ] as const)("%s writes no spec-agents line when neither choice is set", (_ac, workflowConfig) => {
    const text = buildWorkflowInstructions({ workflow: { specFixRounds: 2, ...workflowConfig } });
    expect(lines(text).filter((line) => line.includes("Spec-writing runs through"))).toHaveLength(0);
  });
});

describe("US-007 buildWorkflowInstructions profiles", () => {
  test("AC-12 names the plan and run profiles chat.workflow sets", () => {
    expect(
      buildWorkflowInstructions({
        workflow: { specFixRounds: 2, plan: { profiles: ["p1", "p2"] }, run: { profiles: ["r1"] } },
      }),
    ).toContain(
      "chat.workflow sets the profiles for nax plan (p1, p2) and nax run (r1); leave profiles empty on those launches and the card names them.",
    );
  });

  test("AC-13 with only run.profiles set names nax run and not nax plan", () => {
    const profileLine =
      lines(buildWorkflowInstructions({ workflow: { specFixRounds: 2, run: { profiles: ["r1"] } } })).find((line) =>
        line.includes("sets the profiles"),
      ) ?? "";
    expect(profileLine).toContain("nax run (r1)");
    expect(profileLine).not.toContain("nax plan");
    expect(profileLine).toContain("leave profiles empty on those launches and the card names them.");
  });

  test("writes no profiles line when neither step sets profiles", () => {
    const text = buildWorkflowInstructions({ workflow: { specFixRounds: 2 } });
    expect(lines(text).filter((line) => line.includes("sets the profiles"))).toHaveLength(0);
  });
});

describe("US-007 buildWorkflowInstructions user choice", () => {
  test("AC-14 states the unset choices are the user's and how to read the profile names", () => {
    const choices = lines(buildWorkflowInstructions()).find((line) =>
      line.startsWith("In this chat, where chat.workflow does not set them,"),
    );
    expect(choices).toBe(CHOICES_LINE);
    expect(choices).toContain("the plan and run profiles and the spec writer and reviewer are the user's choice");
    expect(choices).toContain("nax-jobs__list returns the profile names");
  });

  test("AC-15 writes no choice line when every choice is set", () => {
    const text = buildWorkflowInstructions({
      workflow: {
        specFixRounds: 2,
        plan: { profiles: ["p1"] },
        run: { profiles: ["r1"] },
        specWriter: { agent: "general" },
        specReviewer: { agent: "code-reviewer" },
      },
    });
    expect(lines(text).filter((line) => line.includes("are the user's choice"))).toHaveLength(0);
  });

  test("AC-15 writes the choice line when only some choices are set", () => {
    const text = buildWorkflowInstructions({
      workflow: { specFixRounds: 2, plan: { profiles: ["p1"] } },
    });
    expect(lines(text).filter((line) => line.includes("are the user's choice"))).toHaveLength(1);
  });
});

describe("US-007 buildWorkflowInstructions approval wording", () => {
  test("AC-16 keeps exactly one line naming all four billed commands with the explicit-approval wording", () => {
    const text = buildWorkflowInstructions({
      workflow: {
        specFixRounds: 4,
        plan: { profiles: ["p1", "p2"] },
        run: { profiles: ["r1"] },
        botReview: { profiles: ["b1"], model: "m/w" },
        botFix: { profiles: ["b2"] },
        specWriter: { agent: "general", model: "m/w" },
        specReviewer: { agent: "code-reviewer" },
      },
    });
    expect(approvalGatedLaunchLines(text)).toHaveLength(1);
    expect(forbiddingWithoutApprovalLines(text)).toHaveLength(1);
    // The added choice lines may name a launch but must never carry the approval wording themselves.
    const added = lines(text).filter(
      (line) => line.includes("chat.workflow sets the profiles") || line.includes("Spec-writing runs through"),
    );
    expect(added.filter((line) => /explicit.*approv|approv.*explicit/i.test(line))).toHaveLength(0);
  });
});
