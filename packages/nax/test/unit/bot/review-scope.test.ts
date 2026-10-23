import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeMockCallContext, makeNaxConfig, makeScriptedCallOp } from "@test/helpers";
import { reviewScopeOf } from "@/bot/review-rulings";
import { _reviewStepDeps, type PrReviewInput, runPrReview } from "@/bot/review-step";
import { resolveWorkflowConfig } from "@/config";
import type { BotPrReviewPromptInput } from "@/prompts";
import * as prompts from "@/prompts";
import type { PrStepContext } from "@/workflow/branch-step-context";
import { _workflowDeps } from "@/workflow/step-context";

const REVIEWED = "a".repeat(40);

const base: BotPrReviewPromptInput = {
  packagePath: "/p.diff",
  range: "m..HEAD",
  staticMode: false,
  pr: { number: 42, title: "Title", body: "Adds X", author: "alice" },
  issues: [],
  threads: [],
  comments: [],
};
const INTENT_LINE = "Intent: the PR description and the linked issues below.";
const REVIEW_LINE = "Review pull request #42";
const INCREMENTAL = "This is an incremental review";

describe("reviewScopeOf", () => {
  test("AC-1 treats a rangeBase equal to the merge base as a full review", () => {
    expect(reviewScopeOf({ rangeBase: "m", mergeBase: "m" })).toBe("full");
  });
  test("AC-2 treats an absent rangeBase as a full review", () => {
    expect(reviewScopeOf({ mergeBase: "m" })).toBe("full");
  });
  test("AC-3 treats a rangeBase differing from the merge base as incremental", () => {
    expect(reviewScopeOf({ rangeBase: "r", mergeBase: "m" })).toBe("incremental");
  });
  test("AC-4 reports conversation-only ahead of the range comparison", () => {
    expect(reviewScopeOf({ rangeBase: "r", mergeBase: "m", conversationOnly: true })).toBe("conversation-only");
  });
});

describe("buildBotPrReviewPrompt incremental note", () => {
  test("AC-5 names the already-reviewed sha", () => {
    const result = prompts.buildBotPrReviewPrompt({ ...base, incrementalSince: REVIEWED });
    expect(result).toContain(
      `This is an incremental review: every commit up to ${REVIEWED} was already reviewed by an earlier nax review of this pull request.`,
    );
  });
  test("AC-6 scopes intent to the range", () => {
    expect(prompts.buildBotPrReviewPrompt({ ...base, incrementalSince: REVIEWED })).toContain(
      "Judge intent only for what this range changes.",
    );
  });
  test("AC-7 keeps earlier commits and unchanged documents out of cannotVerify", () => {
    expect(prompts.buildBotPrReviewPrompt({ ...base, incrementalSince: REVIEWED })).toContain(
      "Do not list earlier commits, or parts of the PRD or spec this range does not change, in cannotVerify.",
    );
  });
  test("AC-8 places the note after the review line and before the intent line", () => {
    const result = prompts.buildBotPrReviewPrompt({ ...base, incrementalSince: REVIEWED });
    const review = result.indexOf(REVIEW_LINE);
    const note = result.indexOf(INCREMENTAL);
    const intent = result.indexOf(INTENT_LINE);
    expect(review).toBeGreaterThanOrEqual(0);
    expect(intent).toBeGreaterThanOrEqual(0);
    expect(note).toBeGreaterThan(review);
    expect(note).toBeLessThan(intent);
  });
  test("AC-9 omits the note without incrementalSince", () => {
    expect(prompts.buildBotPrReviewPrompt(base)).not.toContain(INCREMENTAL);
  });
  test("AC-10 omits the note for a conversation-only review", () => {
    const result = prompts.buildBotPrReviewPrompt({
      ...base,
      incrementalSince: REVIEWED,
      conversationOnly: true,
    });
    expect(result).not.toContain(INCREMENTAL);
  });
});

const originalStep = { ..._reviewStepDeps };
const originalWorkflow = { ..._workflowDeps };
const config = makeNaxConfig();
const ctx: PrStepContext = {
  config,
  workflow: resolveWorkflowConfig(config),
  callCtx: makeMockCallContext(),
  projectDir: "/checkout",
  runDir: "/artifacts",
  reportPath: "/report",
  feature: "bot",
  pr: { forge: "github", number: 7, base: "merge", head: "head" },
  packageDirs: [],
  dryRun: false,
};
const input: PrReviewInput = {
  mergeBase: "merge",
  staticMode: false,
  issues: [],
  threads: [],
  comments: [],
  info: {
    number: 7,
    title: "PR",
    body: "body",
    url: "url",
    state: "open",
    draft: true,
    author: { login: "writer" },
    baseRef: "main",
    headRef: "topic",
    headSha: "head",
    crossRepo: false,
  },
};
const write = mock<typeof _reviewStepDeps.writeBranchReviewPackage>(async () => ["changed"]);
const rules = mock<typeof _workflowDeps.appendChangedFileRules>(async () => {});
let calls: { prompt?: string }[];

/** The prompt the real builder handed to the review operation on the first dispatch. */
function operationPrompt(): string {
  const prompt = calls[0]?.prompt;
  if (prompt === undefined) throw new Error("the review operation was not dispatched with a prompt");
  return prompt;
}

beforeEach(() => {
  calls = [];
  write.mockClear();
  rules.mockClear();
  _reviewStepDeps.writeBranchReviewPackage = write;
  _workflowDeps.appendChangedFileRules = rules;
  _workflowDeps.callOp = makeScriptedCallOp((_op, value) => {
    calls.push(value as { prompt?: string });
    return {
      intent: "pass",
      quality: "approved",
      findings: [],
      threads: [],
      comments: [],
      cannotVerify: [],
      inspectedFiles: [],
    };
  });
});
afterEach(() => {
  Object.assign(_reviewStepDeps, originalStep);
  Object.assign(_workflowDeps, originalWorkflow);
});

describe("runPrReview incremental note", () => {
  test("AC-11 explains the already-reviewed head of an incremental range", async () => {
    await runPrReview(ctx, { ...input, rangeBase: "reviewed" });
    expect(operationPrompt()).toContain("every commit up to reviewed was already reviewed");
  });
  test("AC-12 leaves a full review unexplained when no rangeBase is given", async () => {
    await runPrReview(ctx, input);
    expect(operationPrompt()).toContain("range merge..HEAD");
    expect(operationPrompt()).not.toContain(INCREMENTAL);
  });
  test("AC-13 leaves a rangeBase equal to the merge base unexplained", async () => {
    await runPrReview(ctx, { ...input, rangeBase: "merge" });
    expect(operationPrompt()).toContain("range merge..HEAD");
    expect(operationPrompt()).not.toContain(INCREMENTAL);
  });
});
