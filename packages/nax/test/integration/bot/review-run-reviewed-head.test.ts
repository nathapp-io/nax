import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeBotReviewDeps, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import { _botReviewDeps, type BotReviewInput, type BotReviewResult, runBotReview } from "@/bot/review-run";
import { _reviewStepDeps, type runPrReview } from "@/bot/review-step";
import type { AdvanceReviewedHeadOutcome, advanceReviewedHead } from "@/bot/reviewed-head";
import type { RecordRulingsOutcome, recordPrRulings } from "@/bot/rulings";
import { NAX_WORKFLOW_PR_MARKER, type PrInfo } from "@/forge";
import { initLogger, resetLogger } from "@/logger";
import type { PrReviewVerdict } from "@/operations";
import { _workflowDeps } from "@/workflow/step-context";

const original = { ..._botReviewDeps };
const workflow = { ..._workflowDeps };
const step = { ..._reviewStepDeps };
const config = makeNaxConfig({ bot: { models: { rulings: "balanced" } } });
const input = { dir: "/repo", pr: 7, profiles: [], interactive: false };
/** The result of a review that posted. */
type PostedResult = Extract<BotReviewResult, { readonly outcome: "posted" }>;
const verdict: PrReviewVerdict = {
  intent: "pass",
  quality: "approved",
  findings: [],
  threads: [],
  comments: [],
  cannotVerify: [],
  inspectedFiles: [],
};
/** The reviewed head the stored index names. */
const reviewedHead = "a".repeat(40);
const reviewedBase = "b".repeat(40);
/** The PR head this review covers; distinct from the reviewed head. */
const prHead = "c".repeat(40);
const mergeBase = "merge";
const repoRoot = "/repo";
const botLogin = "bot";
const posted = {
  earlierAnswered: 0,
  inlineFindings: 0,
  threadsAnswered: 0,
  commentsAnswered: 0,
  offLine: 0,
  failed: 0,
};
let runtime: ReturnType<typeof makeTestRuntime>;
let info: PrInfo;
let outcome: RecordRulingsOutcome;
/** Whether the forge classifies the PR as trusted. */
let trusted: boolean;
/** The order in which the post and the advance ran. */
let order: string[] = [];
const ancestor = mock(async (_dir: string, _ancestor: string, _head: string) => true);
const record = mock<typeof recordPrRulings>(async () => {
  return outcome;
});
const review = mock<typeof runPrReview>(async () => {
  return { ran: true, verdict };
});
const post = mock<typeof _botReviewDeps.postPrReview>(async () => {
  order.push("post");
  return posted;
});
const advance = mock<typeof advanceReviewedHead>(async () => {
  order.push("advance");
  return { kind: "unchanged" };
});

/** A fresh runtime and the review dependencies over it; every review run closes the runtime it used. */
function installDeps(): void {
  runtime = makeTestRuntime({ config });
  Object.assign(_botReviewDeps, {
    isAncestor: ancestor,
    ...makeBotReviewDeps({ config, runtime, info: () => info }),
    recordPrRulings: record,
    runPrReview: review,
    postPrReview: post,
    advanceReviewedHead: advance,
    writeJson: async () => {},
  });
  _botReviewDeps.classifyPrTrust = async () => ({
    trusted,
    headSha: info.headSha,
    reasons: trusted ? [] : ["fork"],
  });
}

beforeEach(() => {
  initLogger({ level: "silent" });
  order = [];
  trusted = true;
  outcome = {
    index: { reviewedHead, reviewedBase, keys: [] },
    recorded: [],
    settled: [],
    open: [],
    asked: 0,
    failed: 0,
  };
  ancestor.mockClear();
  ancestor.mockImplementation(async () => true);
  info = {
    number: 7,
    title: "PR",
    body: NAX_WORKFLOW_PR_MARKER,
    url: "url",
    state: "open",
    draft: true,
    author: { login: "writer" },
    baseRef: "main",
    headRef: "topic",
    headSha: prHead,
    crossRepo: false,
  };
  record.mockClear();
  record.mockImplementation(async () => {
    return outcome;
  });
  review.mockClear();
  review.mockImplementation(async () => {
    return { ran: true, verdict };
  });
  post.mockClear();
  post.mockImplementation(async () => {
    order.push("post");
    return posted;
  });
  advance.mockClear();
  advance.mockImplementation(async () => {
    order.push("advance");
    return { kind: "unchanged" };
  });
  installDeps();
});
afterEach(async () => {
  Object.assign(_botReviewDeps, original);
  Object.assign(_workflowDeps, workflow);
  Object.assign(_reviewStepDeps, step);
  await runtime.close();
  resetLogger();
});

/** Run the review and report how often the advance was called. */
async function advanceCalls(overrides: Partial<BotReviewInput> = {}): Promise<number> {
  installDeps();
  advance.mockClear();
  await runBotReview({ ...input, ...overrides });
  return advance.mock.calls.length;
}

/** Run the review with an advance that resolves to the given outcome. */
async function reviewWith(advanceOutcome: AdvanceReviewedHeadOutcome): Promise<PostedResult> {
  advance.mockImplementation(async () => {
    order.push("advance");
    return advanceOutcome;
  });
  installDeps();
  advance.mockClear();
  const result = await runBotReview(input);
  if (result.outcome !== "posted") throw new Error(`expected a posted review, got ${result.outcome}`);
  return result;
}

describe("runBotReview advances the reviewed head after a complete review", () => {
  test("AC-1 calls the advance once, after the post resolved", async () => {
    await runBotReview(input);
    expect(advance).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["post", "advance"]);
  });

  test("AC-2 passes the expected head, the reviewed head, the merge base and the bot login", async () => {
    await runBotReview(input);
    expect(advance.mock.calls[0]?.[0]).toMatchObject({
      expectedHead: reviewedHead,
      head: prHead,
      base: mergeBase,
      login: botLogin,
    });
  });

  test("AC-3 passes the resolved PR ref, the repository root and the forge deps", async () => {
    await runBotReview(input);
    const call = advance.mock.calls[0]?.[0];
    expect(call?.ref).toEqual({ forge: "github", host: "test", repo: "o/r", number: 7 });
    expect(call?.cwd).toBe(repoRoot);
    expect(call?.deps).toBe(_botReviewDeps.forge);
  });

  test("AC-4 a full review advances the reviewed head too", async () => {
    await runBotReview({ ...input, full: true });
    expect(advance).toHaveBeenCalledTimes(1);
    expect(advance.mock.calls[0]?.[0]).toMatchObject({ head: prHead });
  });

  test("AC-5 a post that failed to write does not advance", async () => {
    expect(await advanceCalls()).toBe(1);
    post.mockImplementation(async () => ({ ...posted, failed: 1 }));
    expect(await advanceCalls()).toBe(0);
  });

  test("AC-6 a review that left files unread does not advance", async () => {
    expect(await advanceCalls()).toBe(1);
    review.mockImplementation(async () => ({ ran: true, verdict, unreadFiles: ["src/a.ts"] }));
    expect(await advanceCalls()).toBe(0);
  });

  test("AC-7 a conversation-only review does not advance", async () => {
    expect(await advanceCalls()).toBe(1);
    info = { ...info, headSha: reviewedHead };
    expect(await advanceCalls()).toBe(0);
  });

  test("AC-8 a review that did not run does not advance", async () => {
    expect(await advanceCalls()).toBe(1);
    review.mockImplementation(async () => ({ ran: false, why: "no budget" }));
    expect(await advanceCalls()).toBe(0);
  });

  test("AC-9 an unmarked PR does not advance", async () => {
    expect(await advanceCalls()).toBe(1);
    info = { ...info, body: "ordinary" };
    expect(await advanceCalls()).toBe(0);
  });

  test("AC-10 an untrusted PR does not advance", async () => {
    expect(await advanceCalls()).toBe(1);
    trusted = false;
    expect(await advanceCalls()).toBe(0);
  });

  test("AC-11 a ruling outcome without an index does not advance", async () => {
    expect(await advanceCalls()).toBe(1);
    outcome = { ...outcome, index: undefined };
    expect(await advanceCalls()).toBe(0);
  });

  test("AC-12 a failed advance still posts the same result", async () => {
    const failed = await reviewWith({ kind: "failed" });
    expect(advance).toHaveBeenCalledTimes(1);
    const advanced = await reviewWith({ kind: "advanced" });
    expect(failed.outcome).toBe("posted");
    // The artifact path names the run, so each of the two runs has its own.
    expect(failed).toEqual({ ...advanced, artifactPath: expect.any(String) });
  });

  test("AC-13 a skipped advance still posts the same result", async () => {
    const skipped = await reviewWith({ kind: "skipped", reason: "moved" });
    expect(advance).toHaveBeenCalledTimes(1);
    const advanced = await reviewWith({ kind: "advanced" });
    expect(skipped.outcome).toBe("posted");
    expect(skipped).toEqual({ ...advanced, artifactPath: expect.any(String) });
  });
});
